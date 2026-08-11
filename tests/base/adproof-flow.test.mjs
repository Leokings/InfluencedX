import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import ganache from 'ganache';
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  hashTypedData,
  keccak256,
  sha256,
  stringToHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const artifact = (name) => JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'artifacts', 'base', `${name}.json`), 'utf8'),
);

const localChain = defineChain({
  id: 31_337,
  name: 'AdProof local EVM',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1'] } },
});

const provider = ganache.provider({
  chain: { chainId: localChain.id, hardfork: 'shanghai' },
  logging: { quiet: true },
  wallet: { totalAccounts: 10, defaultBalance: 1_000 },
});
const initialAccounts = Object.values(provider.getInitialAccounts());
const accounts = initialAccounts.map(({ secretKey }) => privateKeyToAccount(secretKey));
const [owner, brand, creator, watcherA, watcherB, watcherC, treasury, relayer] = accounts;
const transport = custom(provider);
const publicClient = createPublicClient({ chain: localChain, transport });
const wallet = (account) => createWalletClient({ account, chain: localChain, transport });

async function deploy(name, args = [], account = owner) {
  const contract = artifact(name);
  const hash = await wallet(account).deployContract({
    abi: contract.abi,
    bytecode: contract.bytecode,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  return { address: receipt.contractAddress, abi: contract.abi };
}

async function write(contract, functionName, args = [], account = owner) {
  const hash = await wallet(account).writeContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  return receipt;
}

async function read(contract, functionName, args = []) {
  return publicClient.readContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
  });
}

async function expectWriteFailure(contract, functionName, args, account = owner) {
  await assert.rejects(async () => {
    await wallet(account).writeContract({
      address: contract.address,
      abi: contract.abi,
      functionName,
      args,
    });
  });
}

const domain = (receiver) => ({
  name: 'XProofAttestationReceiver',
  version: '2',
  chainId: localChain.id,
  verifyingContract: receiver,
});

const creatorVerificationTypes = {
  CreatorVerification: [
    { name: 'attestationId', type: 'bytes32' },
    { name: 'wallet', type: 'address' },
    { name: 'identityHash', type: 'bytes32' },
    { name: 'handleHash', type: 'bytes32' },
    { name: 'verificationPostHash', type: 'bytes32' },
    { name: 'challengeHash', type: 'bytes32' },
    { name: 'metricsHash', type: 'bytes32' },
    { name: 'verifiedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'genlayerContract', type: 'bytes32' },
    { name: 'genlayerTxHash', type: 'bytes32' },
    { name: 'relayDeadline', type: 'uint64' },
  ],
};

const ownershipIntentTypes = {
  OwnershipIntent: [
    { name: 'attestationId', type: 'bytes32' },
    { name: 'wallet', type: 'address' },
    { name: 'handleHash', type: 'bytes32' },
    { name: 'verificationPostHash', type: 'bytes32' },
    { name: 'challengeHash', type: 'bytes32' },
    { name: 'credentialExpiresAt', type: 'uint64' },
    { name: 'genlayerContract', type: 'bytes32' },
  ],
};

const campaignResolutionTypes = {
  CampaignResolution: [
    { name: 'requestId', type: 'bytes32' },
    { name: 'assignmentId', type: 'uint256' },
    { name: 'outcome', type: 'uint8' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'genlayerContract', type: 'bytes32' },
    { name: 'genlayerTxHash', type: 'bytes32' },
    { name: 'resolvedAt', type: 'uint64' },
    { name: 'relayDeadline', type: 'uint64' },
  ],
};

const metricsAttestationTypes = {
  MetricsAttestation: [
    { name: 'attestationId', type: 'bytes32' },
    { name: 'wallet', type: 'address' },
    { name: 'identityHash', type: 'bytes32' },
    { name: 'metricsHash', type: 'bytes32' },
    { name: 'measuredAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'genlayerContract', type: 'bytes32' },
    { name: 'genlayerTxHash', type: 'bytes32' },
    { name: 'relayDeadline', type: 'uint64' },
  ],
};

async function sortedSignatures(primaryType, types, message, signers, receiver) {
  const sorted = [...signers].sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
  return Promise.all(sorted.map((account) => account.signTypedData({
    domain: domain(receiver),
    types,
    primaryType,
    message,
  })));
}

function ownershipIntent(item) {
  return {
    attestationId: item.attestationId,
    wallet: item.wallet,
    handleHash: item.handleHash,
    verificationPostHash: item.verificationPostHash,
    challengeHash: item.challengeHash,
    credentialExpiresAt: item.expiresAt,
    genlayerContract: item.genlayerContract,
  };
}

function signOwnershipIntent(item, signer, receiver) {
  return signer.signTypedData({
    domain: domain(receiver),
    types: ownershipIntentTypes,
    primaryType: 'OwnershipIntent',
    message: ownershipIntent(item),
  });
}

async function latestTimestamp() {
  return Number((await publicClient.getBlock()).timestamp);
}

async function increaseTime(seconds) {
  await provider.request({ method: 'evm_increaseTime', params: [seconds] });
  await provider.request({ method: 'evm_mine', params: [] });
}

test('threshold identity relay and PASS settlement preserve escrow invariants', async () => {
  const usdc = await deploy('MockUSDC');
  const registry = await deploy('AdProofCreatorRegistry', [owner.address]);
  const genlayerContract = keccak256(stringToHex('genlayer:resolver'));
  const escrow = await deploy('AdProofEscrow', [
    owner.address,
    usdc.address,
    registry.address,
    treasury.address,
    250,
  ]);
  const receiver = await deploy('AdProofAttestationReceiver', [
    owner.address,
    registry.address,
    escrow.address,
    genlayerContract,
    [watcherA.address, watcherB.address, watcherC.address],
    2n,
  ]);
  await write(registry, 'setAttestationReceiver', [receiver.address]);
  await write(escrow, 'setResolutionReceiver', [receiver.address]);
  await expectWriteFailure(receiver, 'setThreshold', [1n]);
  await expectWriteFailure(receiver, 'setWatcher', [watcherC.address, false]);

  const now = await latestTimestamp();
  const identityHash = sha256(stringToHex('x-user-id:2244994945'));
  const verification = {
    attestationId: keccak256(stringToHex('verification:1')),
    wallet: creator.address,
    identityHash,
    handleHash: keccak256(stringToHex('xdevelopers')),
    verificationPostHash: keccak256(stringToHex('1346889436626259968')),
    challengeHash: sha256(stringToHex('APV1-test-challenge')),
    metricsHash: keccak256(stringToHex('metrics:v1')),
    verifiedAt: BigInt(now),
    expiresAt: BigInt(now + 7_200),
    genlayerContract,
    genlayerTxHash: keccak256(stringToHex('genlayer:verification-tx')),
    relayDeadline: BigInt(now + 600),
  };
  const ownershipSignature = await signOwnershipIntent(verification, creator, receiver.address);
  assert.equal(
    await read(receiver, 'ownershipIntentDigest', [verification]),
    hashTypedData({
      domain: domain(receiver.address),
      types: ownershipIntentTypes,
      primaryType: 'OwnershipIntent',
      message: ownershipIntent(verification),
    }),
  );
  const verificationSignatures = await sortedSignatures(
    'CreatorVerification',
    creatorVerificationTypes,
    verification,
    [watcherA, watcherB],
    receiver.address,
  );

  const wrongSourceVerification = {
    ...verification,
    attestationId: keccak256(stringToHex('verification:wrong-source')),
    genlayerContract: keccak256(stringToHex('genlayer:unapproved-resolver')),
  };
  const wrongSourceSignatures = await sortedSignatures(
    'CreatorVerification',
    creatorVerificationTypes,
    wrongSourceVerification,
    [watcherA, watcherB],
    receiver.address,
  );
  await expectWriteFailure(
    receiver,
    'submitCreatorVerification',
    [wrongSourceVerification, ownershipSignature, wrongSourceSignatures],
    relayer,
  );

  const mutations = [
    { attestationId: keccak256(stringToHex('verification:mutated-request')) },
    { wallet: brand.address },
    { handleHash: keccak256(stringToHex('mutated-handle')) },
    { verificationPostHash: keccak256(stringToHex('mutated-post')) },
    { challengeHash: sha256(stringToHex('mutated-challenge')) },
    { expiresAt: verification.expiresAt + 1n },
  ];
  for (const mutation of mutations) {
    const mutated = { ...verification, ...mutation };
    const mutatedWatcherSignatures = await sortedSignatures(
      'CreatorVerification',
      creatorVerificationTypes,
      mutated,
      [watcherA, watcherB],
      receiver.address,
    );
    await expectWriteFailure(
      receiver,
      'submitCreatorVerification',
      [mutated, ownershipSignature, mutatedWatcherSignatures],
      relayer,
    );
  }

  const expiredVerification = {
    ...verification,
    attestationId: keccak256(stringToHex('verification:expired-intent')),
    verifiedAt: BigInt(now - 100),
    expiresAt: BigInt(now - 1),
  };
  const expiredOwnershipSignature = await signOwnershipIntent(expiredVerification, creator, receiver.address);
  const expiredWatcherSignatures = await sortedSignatures(
    'CreatorVerification',
    creatorVerificationTypes,
    expiredVerification,
    [watcherA, watcherB],
    receiver.address,
  );
  await expectWriteFailure(
    receiver,
    'submitCreatorVerification',
    [expiredVerification, expiredOwnershipSignature, expiredWatcherSignatures],
    relayer,
  );

  await expectWriteFailure(
    receiver,
    'submitCreatorVerification',
    [verification, ownershipSignature, verificationSignatures.slice(0, 1)],
    relayer,
  );
  await write(
    receiver,
    'submitCreatorVerification',
    [verification, ownershipSignature, verificationSignatures],
    relayer,
  );
  assert.equal(await read(registry, 'isVerified', [creator.address, identityHash]), true);
  const intentDigest = await read(receiver, 'ownershipIntentDigest', [verification]);
  assert.equal(await read(receiver, 'usedOwnershipIntents', [intentDigest]), true);
  await expectWriteFailure(
    receiver,
    'submitCreatorVerification',
    [verification, ownershipSignature, verificationSignatures],
    relayer,
  );

  const contractWallet = await deploy('Mock1271', [creator.address]);
  const contractIdentityHash = sha256(stringToHex('x-user-id:contract-wallet'));
  const contractVerification = {
    ...verification,
    attestationId: keccak256(stringToHex('verification:eip1271')),
    wallet: contractWallet.address,
    identityHash: contractIdentityHash,
    handleHash: keccak256(stringToHex('contract_creator')),
    verificationPostHash: keccak256(stringToHex('contract-post')),
    challengeHash: sha256(stringToHex('APV1-contract-wallet')),
    genlayerTxHash: keccak256(stringToHex('genlayer:eip1271-tx')),
  };
  const contractOwnershipSignature = await signOwnershipIntent(
    contractVerification,
    creator,
    receiver.address,
  );
  const contractWatcherSignatures = await sortedSignatures(
    'CreatorVerification',
    creatorVerificationTypes,
    contractVerification,
    [watcherB, watcherC],
    receiver.address,
  );
  await write(
    receiver,
    'submitCreatorVerification',
    [contractVerification, contractOwnershipSignature, contractWatcherSignatures],
    relayer,
  );
  assert.equal(await read(registry, 'isVerified', [contractWallet.address, contractIdentityHash]), true);

  const identityProfileBeforeMetrics = await read(registry, 'getProfile', [creator.address]);
  const metrics = {
    attestationId: keccak256(stringToHex('metrics:1')),
    wallet: creator.address,
    identityHash,
    metricsHash: keccak256(stringToHex('metrics:v2')),
    measuredAt: BigInt(now + 1),
    expiresAt: BigInt(now + 86_400),
    genlayerContract,
    genlayerTxHash: keccak256(stringToHex('genlayer:metrics-tx')),
    relayDeadline: BigInt(now + 600),
  };
  const metricsSignatures = await sortedSignatures(
    'MetricsAttestation',
    metricsAttestationTypes,
    metrics,
    [watcherA, watcherB],
    receiver.address,
  );
  await write(receiver, 'submitMetrics', [metrics, metricsSignatures], relayer);
  const identityProfileAfterMetrics = await read(registry, 'getProfile', [creator.address]);
  assert.equal(identityProfileAfterMetrics.expiresAt, identityProfileBeforeMetrics.expiresAt);
  assert.equal(identityProfileAfterMetrics.metricsExpiresAt, metrics.expiresAt);
  assert.equal(await read(registry, 'hasFreshMetrics', [creator.address]), true);

  const budget = 500_000_000n;
  const payout = 100_000_000n;
  await write(usdc, 'mint', [brand.address, budget]);
  await write(usdc, 'approve', [escrow.address, budget], brand);
  await write(escrow, 'createCampaign', [
    keccak256(stringToHex('campaign-terms-v1')),
    budget,
    BigInt(now + 600),
    BigInt(now + 1_200),
    BigInt(now + 3_600),
    60n,
  ], brand);
  assert.equal(await read(escrow, 'campaignCount'), 1n);

  const agreementHash = keccak256(stringToHex('agreement-1'));
  await write(escrow, 'selectCreator', [1n, creator.address, identityHash, agreementHash, payout], brand);
  await write(escrow, 'acceptAssignment', [1n], creator);
  await write(escrow, 'submitEvidence', [
    1n,
    keccak256(stringToHex('post:2034567890')),
    keccak256(stringToHex('submission:1')),
  ], creator);
  await increaseTime(61);
  await write(escrow, 'requestResolution', [1n], relayer);

  const assignment = await read(escrow, 'assignments', [1n]);
  const requestId = assignment[9];
  assert.notEqual(requestId, `0x${'00'.repeat(32)}`);

  const resolvedAt = await latestTimestamp();
  const resolution = {
    requestId,
    assignmentId: 1n,
    outcome: 1,
    evidenceHash: keccak256(stringToHex('evidence:pass')),
    genlayerContract,
    genlayerTxHash: keccak256(stringToHex('genlayer:resolution-tx')),
    resolvedAt: BigInt(resolvedAt),
    relayDeadline: BigInt(resolvedAt + 600),
  };
  const resolutionSignatures = await sortedSignatures(
    'CampaignResolution',
    campaignResolutionTypes,
    resolution,
    [watcherA, watcherC],
    receiver.address,
  );
  await write(receiver, 'submitCampaignResolution', [resolution, resolutionSignatures], relayer);

  // Keep three independent requests outstanding at once, then settle PASS,
  // FAIL, and UNDETERMINED. This catches accidental global request state and
  // cross-assignment replay bugs in the threshold receiver/escrow boundary.
  const concurrentPayout = 50_000_000n;
  for (let assignmentId = 2n; assignmentId <= 4n; assignmentId += 1n) {
    await write(escrow, 'selectCreator', [
      1n,
      creator.address,
      identityHash,
      keccak256(stringToHex(`agreement-${assignmentId}`)),
      concurrentPayout,
    ], brand);
    await write(escrow, 'acceptAssignment', [assignmentId], creator);
    await write(escrow, 'submitEvidence', [
      assignmentId,
      keccak256(stringToHex(`post:${assignmentId}`)),
      keccak256(stringToHex(`submission:${assignmentId}`)),
    ], creator);
  }
  await increaseTime(61);

  const pendingRequests = [];
  for (let assignmentId = 2n; assignmentId <= 4n; assignmentId += 1n) {
    await write(escrow, 'requestResolution', [assignmentId], relayer);
    const pendingAssignment = await read(escrow, 'assignments', [assignmentId]);
    assert.equal(pendingAssignment[12], 4);
    pendingRequests.push({ assignmentId, requestId: pendingAssignment[9] });
  }
  assert.equal(new Set(pendingRequests.map(({ requestId: id }) => id)).size, 3);

  const concurrentOutcomes = [1, 2, 3];
  for (let index = 0; index < pendingRequests.length; index += 1) {
    const { assignmentId, requestId: concurrentRequestId } = pendingRequests[index];
    const concurrentResolvedAt = await latestTimestamp();
    const concurrentResolution = {
      requestId: concurrentRequestId,
      assignmentId,
      outcome: concurrentOutcomes[index],
      evidenceHash: keccak256(stringToHex(`evidence:${assignmentId}`)),
      genlayerContract,
      genlayerTxHash: keccak256(stringToHex(`genlayer:resolution-tx:${assignmentId}`)),
      resolvedAt: BigInt(concurrentResolvedAt),
      relayDeadline: BigInt(concurrentResolvedAt + 600),
    };
    const concurrentSignatures = await sortedSignatures(
      'CampaignResolution',
      campaignResolutionTypes,
      concurrentResolution,
      [watcherB, watcherC],
      receiver.address,
    );
    await write(
      receiver,
      'submitCampaignResolution',
      [concurrentResolution, concurrentSignatures],
      relayer,
    );
  }

  assert.equal((await read(escrow, 'assignments', [2n]))[12], 6);
  assert.equal((await read(escrow, 'assignments', [3n]))[12], 7);
  assert.equal((await read(escrow, 'assignments', [4n]))[12], 5);
  assert.equal(await read(escrow, 'claimable', [creator.address]), 146_250_000n);
  assert.equal(await read(escrow, 'claimable', [treasury.address]), 3_750_000n);
  assert.equal(await read(escrow, 'claimable', [brand.address]), 50_000_000n);
  assert.equal(await read(usdc, 'balanceOf', [escrow.address]), budget);

  await write(escrow, 'withdraw', [], creator);
  await write(escrow, 'withdraw', [], treasury);
  await write(escrow, 'withdraw', [], brand);
  assert.equal(await read(usdc, 'balanceOf', [creator.address]), 146_250_000n);
  assert.equal(await read(usdc, 'balanceOf', [treasury.address]), 3_750_000n);
  assert.equal(await read(usdc, 'balanceOf', [brand.address]), 50_000_000n);
  assert.equal(await read(usdc, 'balanceOf', [escrow.address]), 300_000_000n);

  await expectWriteFailure(
    receiver,
    'submitCampaignResolution',
    [resolution, resolutionSignatures],
    relayer,
  );
});

test('Base contracts contain commitments rather than raw X content fields', () => {
  const sources = [
    'AdProofCreatorRegistry.sol',
    'AdProofEscrow.sol',
    'AdProofAttestationReceiver.sol',
  ].map((name) => fs.readFileSync(path.join(projectRoot, 'contracts', 'base', name), 'utf8'));
  const joined = sources.join('\n').toLowerCase();
  assert.equal(joined.includes('tweettext'), false);
  assert.equal(joined.includes('rawcontent'), false);
  assert.equal(joined.includes('followercount'), false);
  assert.equal(joined.includes('currenthandle'), false);
});
