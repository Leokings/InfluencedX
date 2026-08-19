import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  padHex,
  parseAbiItem,
} from 'viem';
import { baseSepolia } from 'viem/chains';

import { loadBaseSepoliaDeployer } from './lib/base-deployer-account.mjs';
import {
  createBaseSepoliaFallbackTransport,
  safeCutoverErrorMessage,
} from './lib/base-sepolia-rpc.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'deployments', 'base-sepolia.json');
const KEYSTORE_PATH = path.join(
  PROJECT_ROOT,
  '.secrets',
  'testnet-deployer',
  'grounding-bradbury.keystore.json',
);
const OLD_RESOLVER = getAddress('0x017311b35dbB9802883bDaE7Fb0Efd7Bd77cB0b2');
const NEW_RESOLVER = getAddress('0x0913b5593Ff16974E2fd616cA678A4986Cb48600');
const NEW_CONTRACT = padHex(NEW_RESOLVER, { size: 32 });
const CONFIRMATION = 'CUT OVER INFLUENCEDX TO STUDIONET';
const resolverEvent = parseAbiItem(
  'event GenLayerContractUpdated(bytes32 indexed previousContract, bytes32 indexed newContract)',
);

async function main() {
const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'));
const receiver = getAddress(manifest.contracts.receiver.address);
const receiverArtifact = JSON.parse(await fs.readFile(
  path.join(PROJECT_ROOT, 'artifacts', 'base', 'AdProofAttestationReceiver.json'),
  'utf8',
));
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL?.trim() || 'https://sepolia.base.org';
const rpcTransport = createBaseSepoliaFallbackTransport({ configuredUrl: rpcUrl });
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: rpcTransport,
});

if (await publicClient.getChainId() !== baseSepolia.id) {
  throw new Error('Configured RPC is not Base Sepolia.');
}

const [owner, currentContract, initiallyPaused] = await Promise.all([
  publicClient.readContract({ address: receiver, abi: receiverArtifact.abi, functionName: 'owner' }),
  publicClient.readContract({ address: receiver, abi: receiverArtifact.abi, functionName: 'genlayerContract' }),
  publicClient.readContract({ address: receiver, abi: receiverArtifact.abi, functionName: 'paused' }),
]);
const [ownerLatestNonce, ownerPendingNonce] = await Promise.all([
  publicClient.getTransactionCount({ address: owner, blockTag: 'latest' }),
  publicClient.getTransactionCount({ address: owner, blockTag: 'pending' }),
]);

if (ownerPendingNonce !== ownerLatestNonce) {
  throw new Error(
    'The Base receiver owner has a pending transaction. Wait for it to settle, then rerun so '
    + 'on-chain state can be reconciled.',
  );
}

const oldContract = padHex(OLD_RESOLVER, { size: 32 });
if (![oldContract.toLowerCase(), NEW_CONTRACT.toLowerCase()].includes(currentContract.toLowerCase())) {
  throw new Error('Receiver is bound to an unexpected GenLayer resolver; no transaction was signed.');
}

let updateTransactionHash = manifest.resolverUpdate?.transactionHash ?? null;
let updateBlockNumber = manifest.resolverUpdate?.blockNumber ?? null;
let pauseTransactionHash = manifest.resolverUpdate?.pauseTransactionHash ?? null;
let unpauseTransactionHash = manifest.resolverUpdate?.unpauseTransactionHash ?? null;
let account = null;
let walletClient = null;
let mutationConfirmed = false;

async function requireMutationConfirmation(action) {
  if (mutationConfirmed) return;
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`${JSON.stringify({
      receiver,
      owner,
      currentResolver: `0x${currentContract.slice(-40)}`,
      paused: initiallyPaused,
      requestedAction: action,
    })}\n`);
    const answer = await prompt.question(`Type ${CONFIRMATION} to continue: `);
    if (answer !== CONFIRMATION) throw new Error('StudioNet receiver cutover was cancelled.');
    mutationConfirmed = true;
  } finally {
    prompt.close();
  }
}

async function signer() {
  if (account) return { account, walletClient };
  account = await loadBaseSepoliaDeployer({
    env: { BASE_SEPOLIA_DEPLOYER_KEYSTORE_PATH: KEYSTORE_PATH },
    cwd: PROJECT_ROOT,
  });
  if (account.address.toLowerCase() !== String(owner).toLowerCase()) {
    throw new Error('The decrypted account is not the Base receiver owner.');
  }
  walletClient = createWalletClient({ account, chain: baseSepolia, transport: rpcTransport });
  return { account, walletClient };
}

async function write(functionName, args = []) {
  const loaded = await signer();
  const simulation = await publicClient.simulateContract({
    account: loaded.account,
    address: receiver,
    abi: receiverArtifact.abi,
    functionName,
    args,
  });
  const hash = await loaded.walletClient.writeContract(simulation.request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`${functionName} transaction reverted.`);
  return receipt;
}

if (currentContract.toLowerCase() === oldContract.toLowerCase()) {
  await requireMutationConfirmation('pause the receiver, bind StudioNet, and restore service');

  if (!initiallyPaused) {
    const receipt = await write('pause');
    pauseTransactionHash = receipt.transactionHash;
  }
  const updateReceipt = await write('setGenLayerContract', [NEW_CONTRACT]);
  updateTransactionHash = updateReceipt.transactionHash;
  updateBlockNumber = updateReceipt.blockNumber.toString();
}

if (!updateTransactionHash || !updateBlockNumber) {
  const logs = await publicClient.getLogs({
    address: receiver,
    event: resolverEvent,
    args: { previousContract: oldContract, newContract: NEW_CONTRACT },
    fromBlock: BigInt(manifest.contracts.receiver.blockNumber),
    toBlock: 'latest',
  });
  if (logs.length !== 1) throw new Error('Cannot reconcile one exact StudioNet resolver-update event.');
  updateTransactionHash = logs[0].transactionHash;
  updateBlockNumber = logs[0].blockNumber.toString();
}

const pausedAfterUpdate = await publicClient.readContract({
  address: receiver,
  abi: receiverArtifact.abi,
  functionName: 'paused',
});
if (pausedAfterUpdate) {
  await requireMutationConfirmation('unpause the StudioNet-bound receiver after a partial cutover');
  const receipt = await write('unpause');
  unpauseTransactionHash = receipt.transactionHash;
}

const [finalContract, finalPaused] = await Promise.all([
  publicClient.readContract({ address: receiver, abi: receiverArtifact.abi, functionName: 'genlayerContract' }),
  publicClient.readContract({ address: receiver, abi: receiverArtifact.abi, functionName: 'paused' }),
]);
if (finalContract.toLowerCase() !== NEW_CONTRACT.toLowerCase() || finalPaused) {
  throw new Error('StudioNet receiver cutover did not reach the required unpaused state.');
}

const nextManifest = {
  ...manifest,
  schemaVersion: 3,
  initialGenlayerResolver: manifest.initialGenlayerResolver ?? manifest.genlayerResolver,
  initialGenlayerContract: manifest.initialGenlayerContract ?? manifest.genlayerContract,
  genlayerResolver: NEW_RESOLVER,
  genlayerContract: NEW_CONTRACT,
  resolverUpdate: {
    previousResolver: OLD_RESOLVER,
    newResolver: NEW_RESOLVER,
    transactionHash: updateTransactionHash,
    blockNumber: String(updateBlockNumber),
    pauseTransactionHash,
    unpauseTransactionHash,
    receiverPausedAfterCutover: false,
  },
};
const temporaryPath = `${MANIFEST_PATH}.tmp`;
await fs.writeFile(temporaryPath, `${JSON.stringify(nextManifest, null, 2)}\n`, { flag: 'w' });
await fs.rename(temporaryPath, MANIFEST_PATH);

process.stdout.write(`${JSON.stringify({
  ok: true,
  network: 'base-sepolia',
  receiver,
  previousResolver: OLD_RESOLVER,
  resolver: NEW_RESOLVER,
  transactionHash: updateTransactionHash,
  blockNumber: String(updateBlockNumber),
  paused: false,
})}\n`);
}

main().catch((error) => {
  process.stderr.write(`Cutover stopped safely: ${safeCutoverErrorMessage(error)}\n`);
  process.exitCode = 1;
});
