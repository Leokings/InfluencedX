import fs from 'node:fs/promises';

import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
} from 'viem';
import { baseSepolia } from 'viem/chains';

import { buildAttestation } from '../../src/relay/attestations.mjs';
import { readFinalizedGenLayerResult } from '../../src/relay/genlayer-source.mjs';
import {
  assertPreviewOperatorEnvironment,
  CURRENT_PREVIEW_RELAY,
} from './current-preview-relay.mjs';
import {
  bindingFromRelayConfiguration,
} from './preview-base-sepolia-relay.mjs';
import { PreviewRelayStore } from './preview-relay-store.mjs';

const APPLY_FLAG = '--apply-proven-no-broadcast';
const EXPECTED_SETUP_NONCE = 5;
const RPC_URLS = Object.freeze([
  CURRENT_PREVIEW_RELAY.rpcUrl,
  'https://base-sepolia-rpc.publicnode.com',
]);

const RECEIVER_ABI = parseAbi([
  'function usedAttestations(bytes32) view returns (bool)',
  'function usedOwnershipIntents(bytes32) view returns (bool)',
  'function ownershipIntentDigest((bytes32 attestationId,address wallet,bytes32 identityHash,bytes32 handleHash,bytes32 verificationPostHash,bytes32 challengeHash,bytes32 metricsHash,uint64 verifiedAt,uint64 expiresAt,bytes32 genlayerContract,bytes32 genlayerTxHash,uint64 relayDeadline) item) view returns (bytes32)',
]);

const REGISTRY_ABI = parseAbi([
  'function profileCount() view returns (uint256)',
  'function getProfile(address wallet) view returns ((uint256 profileId,address wallet,bytes32 identityHash,bytes32 handleHash,bytes32 verificationPostHash,bytes32 metricsHash,uint64 verifiedAt,uint64 expiresAt,uint64 metricsMeasuredAt,uint64 metricsExpiresAt,bool active) profile)',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function readRpcState(rpcUrl, attestation) {
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const intentDigest = await client.readContract({
    address: CURRENT_PREVIEW_RELAY.baseReceiver,
    abi: RECEIVER_ABI,
    functionName: 'ownershipIntentDigest',
    args: [attestation.message],
  });
  const [chainId, blockNumber, nonceLatest, noncePending, attestationUsed, intentUsed, profileCount, profile] = await Promise.all([
    client.getChainId(),
    client.getBlockNumber(),
    client.getTransactionCount({
      address: CURRENT_PREVIEW_RELAY.simulationAccount,
      blockTag: 'latest',
    }),
    client.getTransactionCount({
      address: CURRENT_PREVIEW_RELAY.simulationAccount,
      blockTag: 'pending',
    }),
    client.readContract({
      address: CURRENT_PREVIEW_RELAY.baseReceiver,
      abi: RECEIVER_ABI,
      functionName: 'usedAttestations',
      args: [CURRENT_PREVIEW_RELAY.requestId],
    }),
    client.readContract({
      address: CURRENT_PREVIEW_RELAY.baseReceiver,
      abi: RECEIVER_ABI,
      functionName: 'usedOwnershipIntents',
      args: [intentDigest],
    }),
    client.readContract({
      address: CURRENT_PREVIEW_RELAY.baseRegistry,
      abi: REGISTRY_ABI,
      functionName: 'profileCount',
    }),
    client.readContract({
      address: CURRENT_PREVIEW_RELAY.baseRegistry,
      abi: REGISTRY_ABI,
      functionName: 'getProfile',
      args: [CURRENT_PREVIEW_RELAY.expectedWallet],
    }),
  ]);
  invariant(chainId === CURRENT_PREVIEW_RELAY.chainId, 'A reconciliation RPC is not Base Sepolia');
  invariant(nonceLatest === EXPECTED_SETUP_NONCE && noncePending === EXPECTED_SETUP_NONCE,
    'The relayer nonce changed; transaction-hash reconciliation is required');
  invariant(attestationUsed === false && intentUsed === false,
    'The exact Base attestation or ownership intent was consumed');
  invariant(BigInt(profileCount) === 0n, 'The registry contains an unexpected creator profile');
  invariant(BigInt(profile.profileId) === 0n && profile.active === false,
    'The exact creator wallet already has a Base profile');
  return Object.freeze({
    rpcHost: new URL(rpcUrl).host,
    blockNumber: blockNumber.toString(),
    nonceLatest,
    noncePending,
    intentDigest: intentDigest.toLowerCase(),
  });
}

async function assertKnownSetupTransactions(client) {
  const manifest = JSON.parse(await fs.readFile(
    new URL('../../deployments/base-sepolia.json', import.meta.url),
    'utf8',
  ));
  invariant(getAddress(manifest.deployer) === CURRENT_PREVIEW_RELAY.simulationAccount,
    'The Base deployment manifest belongs to another deployer');
  const hashes = [
    manifest.contracts?.registry?.transactionHash,
    manifest.contracts?.escrow?.transactionHash,
    manifest.contracts?.receiver?.transactionHash,
    manifest.wiringTransactions?.registry,
    manifest.wiringTransactions?.escrow,
  ];
  invariant(hashes.every((hash) => /^0x[0-9a-fA-F]{64}$/.test(hash)),
    'The Base deployment manifest does not contain five setup transactions');
  const transactions = await Promise.all(hashes.map((hash) => client.getTransaction({ hash })));
  const receipts = await Promise.all(hashes.map((hash) => client.getTransactionReceipt({ hash })));
  invariant(transactions.every((transaction) => (
    getAddress(transaction.from) === CURRENT_PREVIEW_RELAY.simulationAccount
  )), 'A Base setup transaction belongs to another sender');
  invariant(new Set(transactions.map(({ nonce }) => nonce)).size === EXPECTED_SETUP_NONCE,
    'The Base setup transaction nonces are not unique');
  invariant(transactions.map(({ nonce }) => nonce).sort((left, right) => left - right)
    .every((nonce, index) => nonce === index),
  'The known Base setup transactions do not occupy nonces 0 through 4');
  invariant(receipts.every(({ status }) => status === 'success'),
    'A known Base setup transaction did not succeed');
}

async function main() {
  assertPreviewOperatorEnvironment(process.env);
  invariant(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === APPLY_FLAG),
    `Only the optional ${APPLY_FLAG} flag is accepted`);

  const binding = bindingFromRelayConfiguration(CURRENT_PREVIEW_RELAY);
  const { receipt, result } = await readFinalizedGenLayerResult({
    resolver: binding.resolver,
    txHash: binding.genlayerTxHash,
    requestId: binding.requestId,
  });
  invariant(receipt.statusName === 'FINALIZED'
    && receipt.txExecutionResultName === 'FINISHED_WITH_RETURN',
  'The GenLayer proof is not finalized successfully');
  const attestation = buildAttestation({
    result,
    resolver: binding.resolver,
    txHash: binding.genlayerTxHash,
    receiver: binding.baseReceiver,
    chainId: CURRENT_PREVIEW_RELAY.chainId,
  });
  invariant(attestation.message.attestationId === binding.requestId,
    'The finalized proof request binding changed');
  invariant(getAddress(attestation.message.wallet) === binding.expectedWallet,
    'The finalized proof wallet binding changed');

  const rpcStates = await Promise.all(RPC_URLS.map((rpcUrl) => readRpcState(rpcUrl, attestation)));
  invariant(new Set(rpcStates.map(({ intentDigest }) => intentDigest)).size === 1,
    'Reconciliation RPCs derived different ownership intent digests');
  const setupClient = createPublicClient({
    chain: baseSepolia,
    transport: http(CURRENT_PREVIEW_RELAY.rpcUrl),
  });
  await assertKnownSetupTransactions(setupClient);

  const store = new PreviewRelayStore({ databaseUrl: process.env.DATABASE_URL });
  await store.connect();
  try {
    if (process.argv[2] === APPLY_FLAG) {
      await store.resetAfterProvenNoBroadcast({
        binding,
        nowMs: Date.now(),
      });
    }
  } finally {
    await store.close();
  }

  process.stdout.write(`${JSON.stringify({
    requestId: binding.requestId,
    noBroadcastProven: true,
    resetApplied: process.argv[2] === APPLY_FLAG,
    expectedNextNonce: EXPECTED_SETUP_NONCE,
    rpcStates,
  })}\n`);
}

await main();
