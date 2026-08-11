import fs from 'node:fs';
import path from 'node:path';

import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  isAddress,
  keccak256,
  padHex,
} from 'viem';
import { baseSepolia } from 'viem/chains';

import { loadBaseSepoliaDeployer } from './lib/base-deployer-account.mjs';
import {
  atomicWriteJson,
  createJournalSaver,
  loadOrCreateJournal,
  resumeContractDeployment,
  resumeContractWrite,
} from './lib/base-deployment-journal.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const output = path.join(projectRoot, 'deployments', 'base-sepolia.json');
const journalPath = path.join(projectRoot, 'deployments', 'base-sepolia.journal.json');
if (fs.existsSync(output)) {
  throw new Error(`Refusing to deploy: deployment manifest already exists at ${output}`);
}
const artifact = (name) => JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'artifacts', 'base', `${name}.json`), 'utf8'),
);

function checkedAddress(label, value) {
  if (!isAddress(value)) throw new Error(`${label} must be an address`);
  return getAddress(value);
}

function addressOr(name, fallback) {
  return checkedAddress(name, process.env[name] || fallback);
}

const deployer = await loadBaseSepoliaDeployer();
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
const finalOwner = addressOr('BASE_FINAL_OWNER_ADDRESS', deployer.address);
const treasury = addressOr('BASE_SEPOLIA_TREASURY_ADDRESS', deployer.address);
const usdc = addressOr('BASE_SEPOLIA_USDC_ADDRESS', '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const resolver = addressOr('GENLAYER_RESOLVER_ADDRESS');
const genlayerContract = padHex(resolver, { size: 32 });
const watchers = (process.env.BASE_WATCHER_ADDRESSES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => checkedAddress('BASE_WATCHER_ADDRESSES entry', value));
const threshold = Number.parseInt(process.env.BASE_WATCHER_THRESHOLD ?? '2', 10);
const feeBps = Number.parseInt(process.env.ADPROOF_PROTOCOL_FEE_BPS ?? '250', 10);
if (new Set(watchers.map((value) => value.toLowerCase())).size !== watchers.length) throw new Error('Watcher addresses must be unique');
if (watchers.length < 3) throw new Error('At least three independent watcher addresses are required');
if (!Number.isSafeInteger(threshold) || threshold < 2 || threshold > watchers.length) throw new Error('Invalid watcher threshold');
if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > 1_000) throw new Error('Invalid protocol fee');

const transport = http(rpcUrl, { timeout: 20_000, retryCount: 3 });
const publicClient = createPublicClient({ chain: baseSepolia, transport });
const walletClient = createWalletClient({ account: deployer, chain: baseSepolia, transport });
if (await publicClient.getChainId() !== baseSepolia.id) throw new Error('RPC is not Base Sepolia (84532)');
const usdcCode = await publicClient.getCode({ address: usdc });
if (!usdcCode || usdcCode === '0x') throw new Error('Configured Base Sepolia USDC address has no bytecode');
const balance = await publicClient.getBalance({ address: deployer.address });
if (balance === 0n) throw new Error(`Deployer ${deployer.address} has no Base Sepolia ETH`);

const artifacts = {
  registry: artifact('AdProofCreatorRegistry'),
  escrow: artifact('AdProofEscrow'),
  receiver: artifact('AdProofAttestationReceiver'),
};
const journalConfig = {
  chainId: baseSepolia.id,
  deployer: deployer.address,
  finalOwner,
  treasury,
  usdc,
  genlayerResolver: resolver,
  genlayerContract,
  feeBps,
  watchers,
  threshold,
  artifactBytecodeHashes: {
    registry: keccak256(artifacts.registry.bytecode),
    escrow: keccak256(artifacts.escrow.bytecode),
    receiver: keccak256(artifacts.receiver.bytecode),
  },
};
const { journal, resumed: resumedJournal } = loadOrCreateJournal({ journalPath, config: journalConfig });
const saveJournal = createJournalSaver({ journalPath, journal });
const emit = (event) => console.log(JSON.stringify(event));

const recoveryRegistryTransaction = process.env.BASE_SEPOLIA_RECOVER_REGISTRY_TRANSACTION_HASH;
if (recoveryRegistryTransaction) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(recoveryRegistryTransaction)) {
    throw new Error('BASE_SEPOLIA_RECOVER_REGISTRY_TRANSACTION_HASH must be a transaction hash');
  }
  const existing = journal.contracts.registry;
  if (existing && existing.transactionHash.toLowerCase() !== recoveryRegistryTransaction.toLowerCase()) {
    throw new Error('Recovery registry transaction differs from the existing deployment journal');
  }
  if (!existing) {
    journal.contracts.registry = {
      contractName: 'AdProofCreatorRegistry',
      transactionHash: recoveryRegistryTransaction,
      submittedAt: new Date().toISOString(),
      adoptedFromPreJournalRun: true,
    };
    saveJournal();
  }
}

async function deploy(key, contractName, args) {
  return resumeContractDeployment({
    key,
    contractName,
    artifact: artifacts[key],
    args,
    journal,
    saveJournal,
    walletClient,
    publicClient,
    emit,
  });
}

async function write(key, contractName, deployment, functionName, args) {
  return resumeContractWrite({
    key,
    contractName,
    deployment,
    artifact: artifacts[key.startsWith('registry') ? 'registry' : key.startsWith('escrow') ? 'escrow' : 'receiver'],
    functionName,
    args,
    journal,
    saveJournal,
    walletClient,
    publicClient,
    account: deployer,
    emit,
  });
}

emit({
  stage: 'preflight',
  deployer: deployer.address,
  balanceEth: formatEther(balance),
  journal: journalPath,
  resumed: resumedJournal || Object.keys(journal.contracts).length > 0,
});
const registry = await deploy('registry', 'AdProofCreatorRegistry', [deployer.address]);
emit({ stage: 'registry', ...registry });
const escrow = await deploy('escrow', 'AdProofEscrow', [
  deployer.address,
  usdc,
  registry.address,
  treasury,
  feeBps,
]);
emit({ stage: 'escrow', ...escrow });
const receiver = await deploy('receiver', 'AdProofAttestationReceiver', [
  deployer.address,
  registry.address,
  escrow.address,
  genlayerContract,
  watchers,
  BigInt(threshold),
]);
emit({ stage: 'receiver', ...receiver });
const registryWiringTx = await write(
  'registryWiring',
  'AdProofCreatorRegistry',
  registry,
  'setAttestationReceiver',
  [receiver.address],
);
const escrowWiringTx = await write(
  'escrowWiring',
  'AdProofEscrow',
  escrow,
  'setResolutionReceiver',
  [receiver.address],
);
const ownershipTransferTransactions = {};
if (finalOwner !== deployer.address) {
  ownershipTransferTransactions.registry = await write(
    'registryOwnership',
    'AdProofCreatorRegistry',
    registry,
    'transferOwnership',
    [finalOwner],
  );
  ownershipTransferTransactions.escrow = await write(
    'escrowOwnership',
    'AdProofEscrow',
    escrow,
    'transferOwnership',
    [finalOwner],
  );
  ownershipTransferTransactions.receiver = await write(
    'receiverOwnership',
    'AdProofAttestationReceiver',
    receiver,
    'transferOwnership',
    [finalOwner],
  );
}

const deployment = {
  schemaVersion: 2,
  deployedAt: new Date().toISOString(),
  chainId: baseSepolia.id,
  rpcUrl,
  deployer: deployer.address,
  initialOwner: deployer.address,
  finalOwner,
  ownershipAcceptanceRequired: finalOwner !== deployer.address,
  treasury,
  usdc,
  genlayerResolver: resolver,
  genlayerContract,
  feeBps,
  watchers,
  threshold,
  receiverEip712Domain: {
    name: 'XProofAttestationReceiver',
    version: '2',
    chainId: baseSepolia.id,
    verifyingContract: receiver.address,
  },
  contracts: { registry, escrow, receiver },
  wiringTransactions: { registry: registryWiringTx, escrow: escrowWiringTx },
  ownershipTransferTransactions,
};
atomicWriteJson(output, deployment, { exclusive: true });
journal.completedAt = deployment.deployedAt;
journal.finalManifest = output;
saveJournal();
emit({ stage: 'complete', output, journal: journalPath, contracts: deployment.contracts });
