import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  parseAbiParameters,
  size,
} from 'viem';

import { BASE_SEPOLIA_CHAIN_ID } from './attestations.mjs';

const MAX_UINT32 = (1n << 32n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const RESOLUTION_REQUESTED_STATUS = 4n;
const verifiedCampaignBindings = new WeakSet();

export const CAMPAIGN_RECEIVER_READ_ABI = parseAbi([
  'function escrow() view returns (address)',
]);

export const CAMPAIGN_ESCROW_READ_ABI = parseAbi([
  'function assignments(uint256 assignmentId) view returns (uint256 campaignId, address creator, bytes32 identityHash, bytes32 agreementHash, uint256 payout, uint64 acceptedAt, uint64 submittedAt, bytes32 postIdHash, bytes32 submissionHash, bytes32 requestId, uint32 resolutionRound, uint16 feeBps, uint8 status)',
  'function campaigns(uint256 campaignId) view returns (address brand, bytes32 termsHash, uint256 deposited, uint256 allocated, uint256 disbursed, uint256 unallocatedWithdrawn, uint64 applicationDeadline, uint64 selectionDeadline, uint64 submissionDeadline, uint64 retentionSeconds)',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Validates the offchain campaign record that a watcher is willing to attest.
 * Strings are already required in their resolver-canonical form so the full
 * GenLayer calldata can be compared without lossy normalization.
 */
export function normalizeCampaignBinding(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value),
    'Campaign binding must be an object');
  const chainId = Number(unsignedInteger(value.chainId, 'Campaign chain ID', BigInt(Number.MAX_SAFE_INTEGER)));
  invariant(chainId === BASE_SEPOLIA_CHAIN_ID, 'Campaign binding must target Base Sepolia');
  const expectedHandle = canonicalHandle(value.expectedHandle);
  const postId = canonicalPostId(value.postId);
  const requiredPhrasesJson = canonicalPhrasesJson(value.requiredPhrasesJson, 'Required phrases');
  const forbiddenPhrasesJson = canonicalPhrasesJson(value.forbiddenPhrasesJson, 'Forbidden phrases');
  invariant(typeof value.requireAdDisclosure === 'boolean',
    'Campaign disclosure requirement must be boolean');
  const semanticBrief = canonicalSemanticBrief(value.semanticBrief);

  return Object.freeze({
    chainId,
    receiver: evmAddress(value.receiver, 'Campaign receiver'),
    escrow: evmAddress(value.escrow, 'Campaign escrow'),
    campaignId: unsignedInteger(value.campaignId, 'Campaign ID', MAX_UINT256, true),
    assignmentId: unsignedInteger(value.assignmentId, 'Assignment ID', MAX_UINT256, true),
    brand: evmAddress(value.brand, 'Campaign brand'),
    creator: evmAddress(value.creator, 'Campaign creator'),
    termsHash: bytes32(value.termsHash, 'Campaign terms hash'),
    agreementHash: bytes32(value.agreementHash, 'Campaign agreement hash'),
    submissionHash: bytes32(value.submissionHash, 'Campaign submission hash'),
    expectedHandle,
    postId,
    requiredPhrasesJson,
    forbiddenPhrasesJson,
    requireAdDisclosure: value.requireAdDisclosure,
    semanticBrief,
  });
}

/** Exact request ID formula in AdProofEscrow.requestResolution. */
export function deriveBaseCampaignRequestId({
  chainId,
  escrow,
  assignmentId,
  resolutionRound,
  agreementHash,
  submissionHash,
}) {
  const normalizedChainId = unsignedInteger(
    chainId,
    'Campaign chain ID',
    BigInt(Number.MAX_SAFE_INTEGER),
    true,
  );
  const normalizedAssignmentId = unsignedInteger(
    assignmentId,
    'Assignment ID',
    MAX_UINT256,
    true,
  );
  const normalizedRound = unsignedInteger(
    resolutionRound,
    'Resolution round',
    MAX_UINT32,
    true,
  );
  return keccak256(encodeAbiParameters(
    parseAbiParameters(
      'uint256 chainId, address escrow, uint256 assignmentId, uint32 resolutionRound, bytes32 agreementHash, bytes32 submissionHash',
    ),
    [
      normalizedChainId,
      evmAddress(escrow, 'Campaign escrow'),
      normalizedAssignmentId,
      Number(normalizedRound),
      bytes32(agreementHash, 'Campaign agreement hash'),
      bytes32(submissionHash, 'Campaign submission hash'),
    ],
  ));
}

/**
 * Reads the receiver's immutable escrow pointer plus the assignment/campaign,
 * validates all persisted commitments, and returns the only resolver calldata
 * a watcher may accept for this resolution request.
 */
export async function readBaseCampaignBinding({
  publicClient,
  receiver,
  requestId,
  expected,
}) {
  invariant(publicClient && typeof publicClient.getChainId === 'function'
    && typeof publicClient.readContract === 'function', 'Base public client is invalid');
  const binding = normalizeCampaignBinding(expected);
  const requestedReceiver = evmAddress(receiver, 'Campaign receiver');
  invariant(requestedReceiver === binding.receiver,
    'Campaign binding receiver does not match the attestation receiver');
  const normalizedRequestId = bytes32(requestId, 'Campaign request ID');
  const actualChainId = await publicClient.getChainId();
  invariant(actualChainId === binding.chainId,
    `Campaign Base RPC chain ${actualChainId} does not match ${binding.chainId}`);

  const receiverEscrow = getAddress(await publicClient.readContract({
    address: requestedReceiver,
    abi: CAMPAIGN_RECEIVER_READ_ABI,
    functionName: 'escrow',
  }));
  invariant(receiverEscrow === binding.escrow,
    'Campaign receiver is wired to a different escrow');

  const assignmentRaw = await publicClient.readContract({
    address: binding.escrow,
    abi: CAMPAIGN_ESCROW_READ_ABI,
    functionName: 'assignments',
    args: [binding.assignmentId],
  });
  const assignment = assignmentFields(assignmentRaw);
  invariant(assignment.campaignId === binding.campaignId,
    'Base assignment belongs to a different campaign');
  invariant(assignment.creator === binding.creator,
    'Base assignment belongs to a different creator');
  invariant(assignment.agreementHash === binding.agreementHash,
    'Base assignment agreement hash does not match the persisted agreement');
  invariant(assignment.submissionHash === binding.submissionHash,
    'Base assignment submission hash does not match the persisted submission');
  invariant(assignment.requestId === normalizedRequestId,
    'Base assignment stores a different resolution request ID');
  invariant(assignment.resolutionRound > 0n && assignment.resolutionRound <= MAX_UINT32,
    'Base assignment resolution round is invalid');
  invariant(assignment.status === RESOLUTION_REQUESTED_STATUS,
    'Base assignment is not awaiting resolution');
  invariant(assignment.submittedAt > 0n,
    'Base assignment has no submission timestamp');

  const campaignRaw = await publicClient.readContract({
    address: binding.escrow,
    abi: CAMPAIGN_ESCROW_READ_ABI,
    functionName: 'campaigns',
    args: [binding.campaignId],
  });
  const campaign = campaignFields(campaignRaw);
  invariant(campaign.brand === binding.brand,
    'Base campaign belongs to a different brand');
  invariant(campaign.termsHash === binding.termsHash,
    'Base campaign terms hash does not match persisted terms');
  invariant(campaign.retentionSeconds > 0n,
    'Base campaign retention period is invalid');

  const recomputedRequestId = deriveBaseCampaignRequestId({
    chainId: binding.chainId,
    escrow: binding.escrow,
    assignmentId: binding.assignmentId,
    resolutionRound: assignment.resolutionRound,
    agreementHash: assignment.agreementHash,
    submissionHash: assignment.submissionHash,
  });
  invariant(recomputedRequestId === normalizedRequestId,
    'Campaign request ID does not match the Base escrow formula');

  const resolveNotBeforeEpoch = assignment.submittedAt + campaign.retentionSeconds;
  invariant(resolveNotBeforeEpoch <= MAX_UINT64,
    'Campaign resolution timestamp exceeds uint64');
  const verified = Object.freeze({
    requestId: normalizedRequestId,
    expectedHandle: binding.expectedHandle,
    postId: binding.postId,
    requiredPhrasesJson: binding.requiredPhrasesJson,
    forbiddenPhrasesJson: binding.forbiddenPhrasesJson,
    requireAdDisclosure: binding.requireAdDisclosure,
    semanticBrief: binding.semanticBrief,
    resolveNotBeforeEpoch,
    assignmentId: binding.assignmentId,
    agreementHash: assignment.agreementHash,
    submissionHash: assignment.submissionHash,
  });
  verifiedCampaignBindings.add(verified);
  return verified;
}

export function assertVerifiedBaseCampaignBinding(value) {
  invariant(value && typeof value === 'object' && verifiedCampaignBindings.has(value),
    'Campaign binding was not verified against live Base state');
  return value;
}

function assignmentFields(raw) {
  invariant(Array.isArray(raw) && raw.length >= 13,
    'Base assignment response is invalid');
  return Object.freeze({
    campaignId: unsignedInteger(raw[0], 'Base campaign ID', MAX_UINT256, true),
    creator: evmAddress(raw[1], 'Base assignment creator'),
    agreementHash: bytes32(raw[3], 'Base agreement hash'),
    submittedAt: unsignedInteger(raw[6], 'Base submitted timestamp', MAX_UINT64),
    submissionHash: bytes32(raw[8], 'Base submission hash'),
    requestId: bytes32(raw[9], 'Base request ID'),
    resolutionRound: unsignedInteger(raw[10], 'Base resolution round', MAX_UINT32),
    status: unsignedInteger(raw[12], 'Base assignment status', 8n),
  });
}

function campaignFields(raw) {
  invariant(Array.isArray(raw) && raw.length >= 10,
    'Base campaign response is invalid');
  return Object.freeze({
    brand: evmAddress(raw[0], 'Base campaign brand'),
    termsHash: bytes32(raw[1], 'Base campaign terms hash'),
    retentionSeconds: unsignedInteger(raw[9], 'Base retention period', MAX_UINT64),
  });
}

function bytes32(value, label) {
  invariant(typeof value === 'string' && isHex(value) && size(value) === 32,
    `${label} must be bytes32`);
  return value.toLowerCase();
}

function evmAddress(value, label) {
  invariant(typeof value === 'string' && isAddress(value, { strict: false }),
    `${label} must be an EVM address`);
  return getAddress(value);
}

function unsignedInteger(value, label, maximum, positive = false) {
  let parsed;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) parsed = BigInt(value);
  else throw new Error(`${label} must be an unsigned integer`);
  invariant(parsed >= 0n && parsed <= maximum, `${label} is outside its supported range`);
  invariant(!positive || parsed > 0n, `${label} must be greater than zero`);
  return parsed;
}

function canonicalHandle(value) {
  invariant(typeof value === 'string' && /^[a-z0-9_]{1,15}$/.test(value),
    'Campaign expected handle must be canonical lowercase X handle');
  return value;
}

function canonicalPostId(value) {
  invariant(typeof value === 'string' && /^[1-9][0-9]{4,24}$/.test(value),
    'Campaign post ID must be canonical X post ID');
  invariant(BigInt(value) <= MAX_UINT64,
    'Campaign post ID is outside the supported X range');
  return value;
}

function canonicalPhrasesJson(value, label) {
  invariant(typeof value === 'string', `${label} must be canonical JSON`);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be canonical JSON`);
  }
  invariant(Array.isArray(parsed) && parsed.length <= 20,
    `${label} must be a short JSON array`);
  const phrases = parsed.map((phrase) => {
    invariant(typeof phrase === 'string', `${label} entries must be strings`);
    const normalized = phrase.trim();
    invariant(normalized.length > 0 && normalized.length <= 160,
      `${label} entries are invalid`);
    return normalized;
  });
  const canonical = JSON.stringify(phrases);
  invariant(value === canonical, `${label} JSON is not canonical`);
  return canonical;
}

function canonicalSemanticBrief(value) {
  invariant(typeof value === 'string', 'Campaign semantic brief must be a string');
  invariant(value === value.trim(), 'Campaign semantic brief is not canonical');
  invariant(value.length <= 2_000, 'Campaign semantic brief is too long');
  return value;
}
