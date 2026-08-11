import {
  getAddress,
  isAddress,
  isHex,
  keccak256,
  padHex,
  recoverTypedDataAddress,
  size,
  stringToHex,
  zeroHash,
} from 'viem';

export const BASE_SEPOLIA_CHAIN_ID = 84_532;
export const RELAY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
export const ATTESTATION_DOMAIN_NAME = 'XProofAttestationReceiver';
export const ATTESTATION_DOMAIN_VERSION = '2';

export const OWNERSHIP_INTENT_TYPES = Object.freeze({
  OwnershipIntent: [
    { name: 'attestationId', type: 'bytes32' },
    { name: 'wallet', type: 'address' },
    { name: 'handleHash', type: 'bytes32' },
    { name: 'verificationPostHash', type: 'bytes32' },
    { name: 'challengeHash', type: 'bytes32' },
    { name: 'credentialExpiresAt', type: 'uint64' },
    { name: 'genlayerContract', type: 'bytes32' },
  ],
});

export const ATTESTATION_TYPES = Object.freeze({
  CreatorVerification: {
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
  },
  MetricsAttestation: {
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
  },
  CampaignResolution: {
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
  },
});

const INTEGER_FIELDS = new Set([
  'verifiedAt',
  'expiresAt',
  'relayDeadline',
  'measuredAt',
  'assignmentId',
  'outcome',
  'resolvedAt',
  'credentialExpiresAt',
]);

const OWNERSHIP_BINDING_CHECKS = Object.freeze([
  'request_match',
  'post_id_match',
  'protocol_match',
  'wallet_match',
  'issued_at_match',
  'expires_at_match',
  'credential_expires_at_match',
  'challenge_match',
  'publication_in_window',
  'identity_match',
  'author_match',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertBytes32(value, label) {
  invariant(typeof value === 'string' && isHex(value) && size(value) === 32, `${label} must be bytes32`);
  return value.toLowerCase();
}

export function canonicalJson(value) {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function genLayerAddressToBytes32(address) {
  invariant(isAddress(address), 'GenLayer resolver must be an address');
  return padHex(getAddress(address), { size: 32 }).toLowerCase();
}

export function attestationDomain(receiver, chainId = BASE_SEPOLIA_CHAIN_ID) {
  invariant(isAddress(receiver), 'Base receiver must be an address');
  invariant(Number.isSafeInteger(chainId) && chainId > 0, 'Invalid Base chain ID');
  return {
    name: ATTESTATION_DOMAIN_NAME,
    version: ATTESTATION_DOMAIN_VERSION,
    chainId,
    verifyingContract: getAddress(receiver),
  };
}

function sharedSource(resolver, txHash) {
  return {
    genlayerContract: genLayerAddressToBytes32(resolver),
    genlayerTxHash: assertBytes32(txHash, 'GenLayer transaction hash'),
  };
}

function validateResultEnvelope(result, expectedKind) {
  invariant(result && typeof result === 'object' && !Array.isArray(result), 'GenLayer result must be an object');
  invariant(result.kind === expectedKind, `Expected ${expectedKind} GenLayer result`);
  assertBytes32(result.request_id, 'Request ID');
}

export function buildAttestation({ result, resolver, txHash, receiver, chainId = BASE_SEPOLIA_CHAIN_ID }) {
  invariant(isAddress(receiver), 'Base receiver must be an address');
  const source = sharedSource(resolver, txHash);
  let primaryType;
  let message;

  if (result.kind === 'OWNERSHIP') {
    validateResultEnvelope(result, 'OWNERSHIP');
    invariant(result.outcome === 'VERIFIED', 'Only VERIFIED ownership results can be relayed');
    for (const field of OWNERSHIP_BINDING_CHECKS) {
      invariant(result[field] === true, `Ownership ${field} check failed`);
    }
    invariant(isAddress(result.base_wallet), 'Ownership result has invalid Base wallet');
    const verifiedAt = BigInt(result.verified_at_epoch);
    const expiresAt = BigInt(result.credential_expires_at_epoch);
    invariant(verifiedAt > 0n && expiresAt > verifiedAt, 'Invalid ownership validity window');
    primaryType = 'CreatorVerification';
    message = {
      attestationId: assertBytes32(result.request_id, 'Attestation ID'),
      wallet: getAddress(result.base_wallet),
      identityHash: assertBytes32(result.identity_hash, 'Identity hash'),
      handleHash: keccak256(stringToHex(`x-handle:${String(result.handle).toLowerCase()}`)),
      verificationPostHash: keccak256(stringToHex(`x-post:${result.post_id}`)),
      challengeHash: assertBytes32(result.challenge_hash, 'Challenge hash'),
      metricsHash: zeroHash,
      verifiedAt,
      expiresAt,
      ...source,
      relayDeadline: verifiedAt + BigInt(RELAY_WINDOW_SECONDS),
    };
  } else if (result.kind === 'METRICS') {
    validateResultEnvelope(result, 'METRICS');
    invariant(result.outcome === 'VERIFIED' && result.identity_match === true, 'Only identity-matched metrics can be relayed');
    invariant(isAddress(result.base_wallet), 'Metrics result has invalid Base wallet');
    const measuredAt = BigInt(result.measured_at_epoch);
    const expiresAt = BigInt(result.metrics_expires_at_epoch);
    invariant(measuredAt > 0n && expiresAt > measuredAt, 'Invalid metrics validity window');
    primaryType = 'MetricsAttestation';
    message = {
      attestationId: assertBytes32(result.request_id, 'Attestation ID'),
      wallet: getAddress(result.base_wallet),
      identityHash: assertBytes32(result.identity_hash, 'Identity hash'),
      metricsHash: keccak256(stringToHex(canonicalJson(result))),
      measuredAt,
      expiresAt,
      ...source,
      relayDeadline: measuredAt + BigInt(RELAY_WINDOW_SECONDS),
    };
  } else if (result.kind === 'CAMPAIGN') {
    validateResultEnvelope(result, 'CAMPAIGN');
    const outcomes = { PASS: 1n, FAIL: 2n, UNDETERMINED: 3n };
    invariant(outcomes[result.outcome], 'Invalid campaign outcome');
    invariant(Number.isSafeInteger(result.assignment_id) && result.assignment_id > 0, 'Invalid Base assignment ID');
    assertBytes32(result.agreement_hash, 'Agreement hash');
    assertBytes32(result.submission_hash, 'Submission hash');
    const resolvedAt = BigInt(result.resolved_at_epoch);
    invariant(resolvedAt > 0n, 'Invalid resolution timestamp');
    primaryType = 'CampaignResolution';
    message = {
      requestId: assertBytes32(result.request_id, 'Request ID'),
      assignmentId: BigInt(result.assignment_id),
      outcome: outcomes[result.outcome],
      evidenceHash: assertBytes32(result.evidence_hash, 'Evidence hash'),
      ...source,
      resolvedAt,
      relayDeadline: resolvedAt + BigInt(RELAY_WINDOW_SECONDS),
    };
  } else {
    throw new Error(`Unsupported GenLayer result kind: ${result.kind}`);
  }

  return {
    primaryType,
    domain: attestationDomain(receiver, chainId),
    types: ATTESTATION_TYPES[primaryType],
    message,
  };
}

export function buildOwnershipIntent({ attestation, receiver, chainId = BASE_SEPOLIA_CHAIN_ID }) {
  const message = attestation?.message ?? attestation;
  invariant(message && typeof message === 'object' && !Array.isArray(message), 'Creator attestation must be an object');
  invariant(isAddress(message.wallet), 'Ownership intent wallet must be an address');
  return {
    primaryType: 'OwnershipIntent',
    domain: attestationDomain(receiver, chainId),
    types: OWNERSHIP_INTENT_TYPES,
    message: {
      attestationId: assertBytes32(message.attestationId, 'Ownership intent attestation ID'),
      wallet: getAddress(message.wallet),
      handleHash: assertBytes32(message.handleHash, 'Ownership intent handle hash'),
      verificationPostHash: assertBytes32(message.verificationPostHash, 'Ownership intent post hash'),
      challengeHash: assertBytes32(message.challengeHash, 'Ownership intent challenge hash'),
      credentialExpiresAt: BigInt(message.expiresAt),
      genlayerContract: assertBytes32(message.genlayerContract, 'Ownership intent GenLayer contract'),
    },
  };
}

export function coerceBundle(bundle) {
  invariant(ATTESTATION_TYPES[bundle.primaryType], 'Unsupported attestation type');
  invariant(bundle.domain?.name === ATTESTATION_DOMAIN_NAME, 'Unexpected attestation domain name');
  invariant(bundle.domain?.version === ATTESTATION_DOMAIN_VERSION, 'Unexpected attestation domain version');
  const message = Object.fromEntries(Object.entries(bundle.message).map(([key, value]) => [
    key,
    INTEGER_FIELDS.has(key) ? BigInt(value) : value,
  ]));
  return {
    primaryType: bundle.primaryType,
    domain: attestationDomain(bundle.domain.verifyingContract, Number(bundle.domain.chainId)),
    types: ATTESTATION_TYPES[bundle.primaryType],
    message,
  };
}

export async function recoverBundleSigner(bundle, signature) {
  const typed = coerceBundle(bundle);
  return recoverTypedDataAddress({ ...typed, signature });
}

export function serializeBigInts(value) {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2);
}
