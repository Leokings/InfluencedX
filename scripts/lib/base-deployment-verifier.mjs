import {
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  padHex,
} from 'viem';

const BASE_SEPOLIA_CHAIN_ID = 84_532;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function assertVerification(condition, message) {
  if (!condition) throw new Error(`Base Sepolia verification failed: ${message}`);
}

function sameHex(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && left.toLowerCase() === right.toLowerCase();
}

function checkedAddress(label, value) {
  assertVerification(isAddress(value), `${label} is not an EVM address`);
  return getAddress(value);
}

function checkedHash(label, value) {
  assertVerification(isHex(value, { strict: true }) && value.length === 66, `${label} is not a transaction hash`);
  return value;
}

function codeByteLength(code) {
  return (code.length - 2) / 2;
}

function artifactFor(artifacts, key) {
  const artifact = artifacts[key];
  assertVerification(artifact && Array.isArray(artifact.abi), `artifact ${key} has no ABI`);
  assertVerification(isHex(artifact.bytecode, { strict: true }) && artifact.bytecode !== '0x', `artifact ${key} has no creation bytecode`);
  assertVerification(
    isHex(artifact.deployedBytecode, { strict: true }) && artifact.deployedBytecode !== '0x',
    `artifact ${key} has no deployed bytecode`,
  );
  return artifact;
}

function validateManifest(manifest, artifacts, expectedChainId) {
  assertVerification(manifest && typeof manifest === 'object', 'deployment manifest is not an object');
  assertVerification(manifest.schemaVersion === 2, 'deployment manifest schemaVersion must be 2');
  assertVerification(manifest.chainId === expectedChainId, `manifest chainId must be ${expectedChainId}`);

  const addresses = {
    deployer: checkedAddress('deployer', manifest.deployer),
    initialOwner: checkedAddress('initialOwner', manifest.initialOwner),
    finalOwner: checkedAddress('finalOwner', manifest.finalOwner),
    treasury: checkedAddress('treasury', manifest.treasury),
    usdc: checkedAddress('usdc', manifest.usdc),
    genlayerResolver: checkedAddress('genlayerResolver', manifest.genlayerResolver),
  };
  assertVerification(sameHex(addresses.deployer, addresses.initialOwner), 'initialOwner must equal deployer');

  assertVerification(isHex(manifest.genlayerContract, { strict: true }) && manifest.genlayerContract.length === 66,
    'genlayerContract must be bytes32');
  assertVerification(
    sameHex(manifest.genlayerContract, padHex(addresses.genlayerResolver, { size: 32 })),
    'genlayerContract does not encode genlayerResolver',
  );
  assertVerification(Number.isSafeInteger(manifest.feeBps) && manifest.feeBps >= 0 && manifest.feeBps <= 1_000,
    'feeBps is invalid');
  assertVerification(Number.isSafeInteger(manifest.threshold) && manifest.threshold >= 2,
    'watcher threshold is invalid');
  assertVerification(Array.isArray(manifest.watchers) && manifest.watchers.length === 3,
    'manifest must contain exactly three watchers');
  const watchers = manifest.watchers.map((watcher, index) => checkedAddress(`watchers[${index}]`, watcher));
  assertVerification(new Set(watchers.map((watcher) => watcher.toLowerCase())).size === watchers.length,
    'watchers must be unique');
  assertVerification(manifest.threshold <= watchers.length, 'watcher threshold exceeds watcher count');

  assertVerification(manifest.contracts && typeof manifest.contracts === 'object', 'contracts are missing');
  const contracts = {};
  for (const key of ['registry', 'escrow', 'receiver']) {
    artifactFor(artifacts, key);
    const deployment = manifest.contracts[key];
    assertVerification(deployment && typeof deployment === 'object', `${key} deployment is missing`);
    contracts[key] = {
      address: checkedAddress(`${key}.address`, deployment.address),
      transactionHash: checkedHash(`${key}.transactionHash`, deployment.transactionHash),
      blockNumber: String(deployment.blockNumber),
    };
    assertVerification(/^\d+$/.test(contracts[key].blockNumber), `${key}.blockNumber is invalid`);
  }
  assertVerification(new Set(Object.values(contracts).map(({ address }) => address.toLowerCase())).size === 3,
    'contract addresses must be unique');

  const wiringTransactions = {
    registry: checkedHash('wiringTransactions.registry', manifest.wiringTransactions?.registry),
    escrow: checkedHash('wiringTransactions.escrow', manifest.wiringTransactions?.escrow),
  };
  const ownershipTransactions = manifest.ownershipTransferTransactions ?? {};
  for (const key of Object.keys(ownershipTransactions)) {
    assertVerification(['registry', 'escrow', 'receiver'].includes(key), `unexpected ownership transaction ${key}`);
    checkedHash(`ownershipTransferTransactions.${key}`, ownershipTransactions[key]);
  }
  if (manifest.ownershipAcceptanceRequired) {
    assertVerification(
      ['registry', 'escrow', 'receiver'].every((key) => ownershipTransactions[key]),
      'ownership acceptance is required but ownership transfer transactions are incomplete',
    );
  } else {
    assertVerification(Object.keys(ownershipTransactions).length === 0,
      'ownership transfer transactions exist while ownershipAcceptanceRequired is false');
  }

  const domain = manifest.receiverEip712Domain;
  assertVerification(domain?.name === 'XProofAttestationReceiver', 'receiver EIP-712 name is invalid');
  assertVerification(domain?.version === '2', 'receiver EIP-712 version is invalid');
  assertVerification(domain?.chainId === expectedChainId, 'receiver EIP-712 chainId is invalid');
  assertVerification(sameHex(domain?.verifyingContract, contracts.receiver.address),
    'receiver EIP-712 verifyingContract is invalid');

  return { addresses, watchers, contracts, wiringTransactions, ownershipTransactions };
}

async function verifyDeploymentTransaction({
  key,
  deployment,
  artifact,
  constructorArgs,
  deployer,
  publicClient,
  code,
}) {
  const receipt = await publicClient.getTransactionReceipt({ hash: deployment.transactionHash });
  assertVerification(sameHex(receipt.transactionHash, deployment.transactionHash),
    `${key} receipt transaction hash differs from manifest`);
  assertVerification(receipt.status === 'success', `${key} deployment receipt is not successful`);
  assertVerification(sameHex(receipt.contractAddress, deployment.address),
    `${key} receipt contract address differs from manifest`);
  assertVerification(String(receipt.blockNumber) === deployment.blockNumber,
    `${key} receipt block differs from manifest`);
  assertVerification(sameHex(receipt.from, deployer), `${key} receipt sender differs from deployer`);

  const transaction = await publicClient.getTransaction({ hash: deployment.transactionHash });
  assertVerification(sameHex(transaction.hash, deployment.transactionHash),
    `${key} transaction hash differs from manifest`);
  assertVerification(sameHex(transaction.from, deployer), `${key} transaction sender differs from deployer`);
  assertVerification(transaction.to == null, `${key} transaction is not contract creation`);
  assertVerification(String(transaction.blockNumber) === deployment.blockNumber,
    `${key} transaction block differs from manifest`);
  const expectedInput = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: constructorArgs,
  });
  assertVerification(sameHex(transaction.input, expectedInput),
    `${key} deployment input differs from artifact and constructor configuration`);

  assertVerification(code && code !== '0x', `${key} has no deployed bytecode`);
  const actualBytes = codeByteLength(code);
  const expectedBytes = codeByteLength(artifact.deployedBytecode);
  assertVerification(actualBytes === expectedBytes,
    `${key} runtime bytecode length ${actualBytes} differs from artifact length ${expectedBytes}`);
  const runtimeExact = sameHex(code, artifact.deployedBytecode);
  if (key === 'registry') {
    assertVerification(runtimeExact, 'registry runtime bytecode differs from artifact');
  }

  return {
    address: deployment.address,
    transactionHash: deployment.transactionHash,
    blockNumber: deployment.blockNumber,
    nonce: transaction.nonce.toString(),
    receiptStatus: receipt.status,
    creationInputHash: keccak256(transaction.input),
    runtimeBytes: actualBytes,
    runtimeHash: keccak256(code),
    expectedRuntimeHash: keccak256(artifact.deployedBytecode),
    runtimeVerification: runtimeExact ? 'exact' : 'creation-input+length+immutable-getters',
  };
}

async function verifyCallTransaction({
  label,
  transactionHash,
  target,
  artifact,
  functionName,
  args,
  deployer,
  publicClient,
}) {
  const receipt = await publicClient.getTransactionReceipt({ hash: transactionHash });
  assertVerification(sameHex(receipt.transactionHash, transactionHash), `${label} receipt hash differs from manifest`);
  assertVerification(receipt.status === 'success', `${label} receipt is not successful`);
  assertVerification(sameHex(receipt.to, target), `${label} receipt target differs from manifest`);
  assertVerification(sameHex(receipt.from, deployer), `${label} receipt sender differs from deployer`);
  const transaction = await publicClient.getTransaction({ hash: transactionHash });
  assertVerification(sameHex(transaction.hash, transactionHash), `${label} transaction hash differs from manifest`);
  assertVerification(sameHex(transaction.from, deployer), `${label} transaction sender differs from deployer`);
  assertVerification(sameHex(transaction.to, target), `${label} transaction target differs from manifest`);
  assertVerification(
    sameHex(transaction.input, encodeFunctionData({ abi: artifact.abi, functionName, args })),
    `${label} transaction input differs from expected ${functionName} call`,
  );
  return {
    transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    receiptStatus: receipt.status,
    target,
    functionName,
  };
}

async function read(publicClient, blockNumber, address, abi, functionName, args = []) {
  return publicClient.readContract({ address, abi, functionName, args, blockNumber });
}

async function verifyOwnership({ publicClient, blockNumber, address, abi, initialOwner, finalOwner, acceptanceRequired }) {
  const owner = await read(publicClient, blockNumber, address, abi, 'owner');
  const pendingOwner = await read(publicClient, blockNumber, address, abi, 'pendingOwner');
  if (!acceptanceRequired) {
    assertVerification(sameHex(owner, finalOwner), `${address} owner differs from finalOwner`);
    assertVerification(sameHex(pendingOwner, ZERO_ADDRESS), `${address} has an unexpected pending owner`);
    return { owner, pendingOwner, state: 'final' };
  }
  const awaitingAcceptance = sameHex(owner, initialOwner) && sameHex(pendingOwner, finalOwner);
  const alreadyAccepted = sameHex(owner, finalOwner) && sameHex(pendingOwner, ZERO_ADDRESS);
  assertVerification(awaitingAcceptance || alreadyAccepted, `${address} ownership state is unexpected`);
  return { owner, pendingOwner, state: alreadyAccepted ? 'final' : 'awaiting-acceptance' };
}

export async function verifyBaseSepoliaDeployment({
  manifest,
  artifacts,
  publicClient,
  expectedChainId = BASE_SEPOLIA_CHAIN_ID,
  now = () => new Date(),
}) {
  const validated = validateManifest(manifest, artifacts, expectedChainId);
  const actualChainId = await publicClient.getChainId();
  assertVerification(actualChainId === expectedChainId,
    `RPC chainId ${actualChainId} is not Base Sepolia (${expectedChainId})`);
  const verificationBlock = await publicClient.getBlockNumber();

  const { addresses, watchers, contracts, wiringTransactions, ownershipTransactions } = validated;
  const registryArtifact = artifacts.registry;
  const escrowArtifact = artifacts.escrow;
  const receiverArtifact = artifacts.receiver;

  const usdcCode = await publicClient.getCode({ address: addresses.usdc, blockNumber: verificationBlock });
  assertVerification(usdcCode && usdcCode !== '0x', 'configured USDC address has no bytecode');

  const registryCode = await publicClient.getCode({ address: contracts.registry.address, blockNumber: verificationBlock });
  const escrowCode = await publicClient.getCode({ address: contracts.escrow.address, blockNumber: verificationBlock });
  const receiverCode = await publicClient.getCode({ address: contracts.receiver.address, blockNumber: verificationBlock });

  const contractEvidence = {
    registry: await verifyDeploymentTransaction({
      key: 'registry',
      deployment: contracts.registry,
      artifact: registryArtifact,
      constructorArgs: [addresses.initialOwner],
      deployer: addresses.deployer,
      publicClient,
      code: registryCode,
    }),
    escrow: await verifyDeploymentTransaction({
      key: 'escrow',
      deployment: contracts.escrow,
      artifact: escrowArtifact,
      constructorArgs: [
        addresses.initialOwner,
        addresses.usdc,
        contracts.registry.address,
        addresses.treasury,
        manifest.feeBps,
      ],
      deployer: addresses.deployer,
      publicClient,
      code: escrowCode,
    }),
    receiver: await verifyDeploymentTransaction({
      key: 'receiver',
      deployment: contracts.receiver,
      artifact: receiverArtifact,
      constructorArgs: [
        addresses.initialOwner,
        contracts.registry.address,
        contracts.escrow.address,
        manifest.genlayerContract,
        watchers,
        BigInt(manifest.threshold),
      ],
      deployer: addresses.deployer,
      publicClient,
      code: receiverCode,
    }),
  };

  const wiringEvidence = {
    registry: await verifyCallTransaction({
      label: 'registry wiring',
      transactionHash: wiringTransactions.registry,
      target: contracts.registry.address,
      artifact: registryArtifact,
      functionName: 'setAttestationReceiver',
      args: [contracts.receiver.address],
      deployer: addresses.deployer,
      publicClient,
    }),
    escrow: await verifyCallTransaction({
      label: 'escrow wiring',
      transactionHash: wiringTransactions.escrow,
      target: contracts.escrow.address,
      artifact: escrowArtifact,
      functionName: 'setResolutionReceiver',
      args: [contracts.receiver.address],
      deployer: addresses.deployer,
      publicClient,
    }),
  };

  const ownershipTransactionEvidence = {};
  for (const key of ['registry', 'escrow', 'receiver']) {
    if (!ownershipTransactions[key]) continue;
    ownershipTransactionEvidence[key] = await verifyCallTransaction({
      label: `${key} ownership transfer`,
      transactionHash: ownershipTransactions[key],
      target: contracts[key].address,
      artifact: artifacts[key],
      functionName: 'transferOwnership',
      args: [addresses.finalOwner],
      deployer: addresses.deployer,
      publicClient,
    });
  }

  const ownership = {
    registry: await verifyOwnership({
      publicClient,
      blockNumber: verificationBlock,
      address: contracts.registry.address,
      abi: registryArtifact.abi,
      initialOwner: addresses.initialOwner,
      finalOwner: addresses.finalOwner,
      acceptanceRequired: manifest.ownershipAcceptanceRequired,
    }),
    escrow: await verifyOwnership({
      publicClient,
      blockNumber: verificationBlock,
      address: contracts.escrow.address,
      abi: escrowArtifact.abi,
      initialOwner: addresses.initialOwner,
      finalOwner: addresses.finalOwner,
      acceptanceRequired: manifest.ownershipAcceptanceRequired,
    }),
    receiver: await verifyOwnership({
      publicClient,
      blockNumber: verificationBlock,
      address: contracts.receiver.address,
      abi: receiverArtifact.abi,
      initialOwner: addresses.initialOwner,
      finalOwner: addresses.finalOwner,
      acceptanceRequired: manifest.ownershipAcceptanceRequired,
    }),
  };

  const registryReceiver = await read(
    publicClient, verificationBlock, contracts.registry.address, registryArtifact.abi, 'attestationReceiver',
  );
  assertVerification(sameHex(registryReceiver, contracts.receiver.address),
    'registry attestationReceiver does not equal receiver');

  const escrowConfiguration = {
    usdc: await read(publicClient, verificationBlock, contracts.escrow.address, escrowArtifact.abi, 'usdc'),
    creatorRegistry: await read(
      publicClient, verificationBlock, contracts.escrow.address, escrowArtifact.abi, 'creatorRegistry',
    ),
    treasury: await read(publicClient, verificationBlock, contracts.escrow.address, escrowArtifact.abi, 'treasury'),
    protocolFeeBps: await read(
      publicClient, verificationBlock, contracts.escrow.address, escrowArtifact.abi, 'protocolFeeBps',
    ),
    resolutionReceiver: await read(
      publicClient, verificationBlock, contracts.escrow.address, escrowArtifact.abi, 'resolutionReceiver',
    ),
    paused: await read(publicClient, verificationBlock, contracts.escrow.address, escrowArtifact.abi, 'paused'),
  };
  assertVerification(sameHex(escrowConfiguration.usdc, addresses.usdc), 'escrow USDC differs from manifest');
  assertVerification(sameHex(escrowConfiguration.creatorRegistry, contracts.registry.address),
    'escrow creatorRegistry differs from registry');
  assertVerification(sameHex(escrowConfiguration.treasury, addresses.treasury), 'escrow treasury differs from manifest');
  assertVerification(Number(escrowConfiguration.protocolFeeBps) === manifest.feeBps,
    'escrow protocolFeeBps differs from manifest');
  assertVerification(sameHex(escrowConfiguration.resolutionReceiver, contracts.receiver.address),
    'escrow resolutionReceiver differs from receiver');

  const receiverConfiguration = {
    creatorRegistry: await read(
      publicClient, verificationBlock, contracts.receiver.address, receiverArtifact.abi, 'creatorRegistry',
    ),
    escrow: await read(publicClient, verificationBlock, contracts.receiver.address, receiverArtifact.abi, 'escrow'),
    genlayerContract: await read(
      publicClient, verificationBlock, contracts.receiver.address, receiverArtifact.abi, 'genlayerContract',
    ),
    threshold: await read(publicClient, verificationBlock, contracts.receiver.address, receiverArtifact.abi, 'threshold'),
    watcherCount: await read(
      publicClient, verificationBlock, contracts.receiver.address, receiverArtifact.abi, 'watcherCount',
    ),
    paused: await read(publicClient, verificationBlock, contracts.receiver.address, receiverArtifact.abi, 'paused'),
  };
  assertVerification(sameHex(receiverConfiguration.creatorRegistry, contracts.registry.address),
    'receiver creatorRegistry differs from registry');
  assertVerification(sameHex(receiverConfiguration.escrow, contracts.escrow.address),
    'receiver escrow differs from escrow');
  assertVerification(sameHex(receiverConfiguration.genlayerContract, manifest.genlayerContract),
    'receiver genlayerContract differs from manifest');
  assertVerification(Number(receiverConfiguration.threshold) === manifest.threshold,
    'receiver threshold differs from manifest');
  assertVerification(Number(receiverConfiguration.watcherCount) === watchers.length,
    'receiver watcherCount differs from manifest');

  const watcherEvidence = [];
  for (const watcher of watchers) {
    const enabled = await read(
      publicClient, verificationBlock, contracts.receiver.address, receiverArtifact.abi, 'isWatcher', [watcher],
    );
    assertVerification(enabled === true, `receiver watcher ${watcher} is not enabled`);
    watcherEvidence.push({ address: watcher, enabled });
  }

  return {
    schemaVersion: 1,
    ok: true,
    verifiedAt: now().toISOString(),
    network: {
      name: 'Base Sepolia',
      chainId: actualChainId,
      verificationBlock: verificationBlock.toString(),
    },
    manifest: {
      schemaVersion: manifest.schemaVersion,
      deployedAt: manifest.deployedAt,
      deployer: addresses.deployer,
    },
    contracts: contractEvidence,
    receipts: {
      wiring: wiringEvidence,
      ownershipTransfers: ownershipTransactionEvidence,
    },
    ownership,
    configuration: {
      registry: { attestationReceiver: registryReceiver },
      escrow: {
        usdc: escrowConfiguration.usdc,
        creatorRegistry: escrowConfiguration.creatorRegistry,
        treasury: escrowConfiguration.treasury,
        protocolFeeBps: Number(escrowConfiguration.protocolFeeBps),
        resolutionReceiver: escrowConfiguration.resolutionReceiver,
        paused: escrowConfiguration.paused,
      },
      receiver: {
        creatorRegistry: receiverConfiguration.creatorRegistry,
        escrow: receiverConfiguration.escrow,
        genlayerContract: receiverConfiguration.genlayerContract,
        threshold: Number(receiverConfiguration.threshold),
        watcherCount: Number(receiverConfiguration.watcherCount),
        watchers: watcherEvidence,
        paused: receiverConfiguration.paused,
      },
      genlayerResolver: addresses.genlayerResolver,
    },
    externalContracts: {
      usdc: {
        address: addresses.usdc,
        codeBytes: codeByteLength(usdcCode),
        codeHash: keccak256(usdcCode),
      },
    },
  };
}

export { BASE_SEPOLIA_CHAIN_ID };
