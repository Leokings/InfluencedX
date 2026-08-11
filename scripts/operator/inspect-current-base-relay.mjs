import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
} from 'viem';
import { baseSepolia } from 'viem/chains';

import { CURRENT_PREVIEW_RELAY } from './current-preview-relay.mjs';

const RECEIVER_ABI = parseAbi([
  'function usedAttestations(bytes32) view returns (bool)',
]);

const REGISTRY_ABI = parseAbi([
  'function getProfile(address wallet) view returns ((uint256 profileId,address wallet,bytes32 identityHash,bytes32 handleHash,bytes32 verificationPostHash,bytes32 metricsHash,uint64 verifiedAt,uint64 expiresAt,uint64 metricsMeasuredAt,uint64 metricsExpiresAt,bool active) profile)',
]);

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(CURRENT_PREVIEW_RELAY.rpcUrl),
});

const [block, nonceLatest, noncePending, attestationUsed, profile] = await Promise.all([
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
    address: CURRENT_PREVIEW_RELAY.baseRegistry,
    abi: REGISTRY_ABI,
    functionName: 'getProfile',
    args: [CURRENT_PREVIEW_RELAY.expectedWallet],
  }),
]);

process.stdout.write(`${JSON.stringify({
  network: 'base-sepolia',
  block: block.toString(),
  relayer: getAddress(CURRENT_PREVIEW_RELAY.simulationAccount),
  nonceLatest,
  noncePending,
  attestationUsed,
  profile: {
    profileId: profile.profileId.toString(),
    wallet: profile.wallet,
    identityHash: profile.identityHash,
    handleHash: profile.handleHash,
    verificationPostHash: profile.verificationPostHash,
    verifiedAt: profile.verifiedAt.toString(),
    expiresAt: profile.expiresAt.toString(),
    active: profile.active,
  },
})}\n`);
