import {
  MAX_CHALLENGE_SECONDS,
  MAX_CREDENTIAL_SECONDS,
  MIN_CHALLENGE_SECONDS,
  MIN_CREDENTIAL_SECONDS,
  SUBMITTER_SCHEMA_VERSION,
  X_EPOCH_MS,
} from './constants.mjs';
import { SubmitterProblem } from './problem.mjs';

const ENVELOPE_KEYS = Object.freeze([
  'baseWallet',
  'challenge',
  'credentialExpiresAtEpoch',
  'expectedHandle',
  'expiresAtEpoch',
  'issuedAtEpoch',
  'postId',
  'requestId',
  'schemaVersion',
]);

export async function validateOwnershipEnvelope(value, { nowEpoch = currentEpoch() } = {}) {
  if (!isPlainObject(value)) {
    throw invalid('The submission body must be a JSON object.');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((key, index) => key !== ENVELOPE_KEYS[index])) {
    throw invalid('The submission body contains missing or unsupported fields.');
  }
  if (value.schemaVersion !== SUBMITTER_SCHEMA_VERSION) {
    throw invalid(`schemaVersion must be ${SUBMITTER_SCHEMA_VERSION}.`);
  }

  const requestId = normalizeHash(value.requestId, 'requestId');
  const baseWallet = normalizeAddress(value.baseWallet);
  const expectedHandle = normalizeHandle(value.expectedHandle);
  const postId = normalizePostId(value.postId);
  const challenge = normalizeChallenge(value.challenge);
  const issuedAtEpoch = safeEpoch(value.issuedAtEpoch, 'issuedAtEpoch');
  const expiresAtEpoch = safeEpoch(value.expiresAtEpoch, 'expiresAtEpoch');
  const credentialExpiresAtEpoch = safeEpoch(
    value.credentialExpiresAtEpoch,
    'credentialExpiresAtEpoch',
  );
  const now = safeEpoch(nowEpoch, 'current time');

  const challengeSeconds = expiresAtEpoch - issuedAtEpoch;
  if (issuedAtEpoch > now) throw invalid('The challenge issue time is in the future.');
  if (expiresAtEpoch < now) throw invalid('The ownership challenge has expired.');
  if (challengeSeconds < MIN_CHALLENGE_SECONDS || challengeSeconds > MAX_CHALLENGE_SECONDS) {
    throw invalid('The challenge window must be between 5 and 60 minutes.');
  }

  const credentialSeconds = credentialExpiresAtEpoch - issuedAtEpoch;
  if (credentialExpiresAtEpoch <= now) throw invalid('The ownership credential has expired.');
  if (credentialSeconds < MIN_CREDENTIAL_SECONDS || credentialSeconds > MAX_CREDENTIAL_SECONDS) {
    throw invalid('The credential lifetime must be between 24 hours and 90 days.');
  }

  const publishedAtEpoch = postEpoch(postId);
  if (publishedAtEpoch < issuedAtEpoch || publishedAtEpoch > expiresAtEpoch) {
    throw invalid('The X post timestamp is outside the challenge window.');
  }

  const normalized = Object.freeze({
    schemaVersion: SUBMITTER_SCHEMA_VERSION,
    requestId,
    baseWallet,
    expectedHandle,
    postId,
    challenge,
    issuedAtEpoch,
    expiresAtEpoch,
    credentialExpiresAtEpoch,
  });
  const expectedRequestId = await ownershipRequestId(normalized);
  if (requestId !== expectedRequestId) {
    throw invalid('requestId does not match the APV2 ownership envelope.');
  }
  return normalized;
}

export async function ownershipRequestId(envelope) {
  const canonical = [
    'xproof-x-ownership-v2',
    String(envelope.baseWallet).toLowerCase(),
    String(envelope.expectedHandle).toLowerCase(),
    String(envelope.postId),
    String(envelope.challenge),
    String(envelope.issuedAtEpoch),
    String(envelope.expiresAtEpoch),
    String(envelope.credentialExpiresAtEpoch),
  ].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function envelopeFingerprint(envelope) {
  return JSON.stringify(ENVELOPE_KEYS.reduce((result, key) => {
    result[key] = envelope[key];
    return result;
  }, {}));
}

export function submissionArgs(envelope) {
  return Object.freeze([
    envelope.requestId,
    envelope.baseWallet,
    envelope.expectedHandle,
    envelope.postId,
    envelope.challenge,
    envelope.issuedAtEpoch,
    envelope.expiresAtEpoch,
    envelope.credentialExpiresAtEpoch,
  ]);
}

export async function submissionCallFingerprint(envelopeOrArgs) {
  const args = Array.isArray(envelopeOrArgs)
    ? normalizeSubmissionArgs(envelopeOrArgs)
    : submissionArgs(envelopeOrArgs);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(args)),
  );
  return `0x${Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

export function postEpoch(postId) {
  return Number(((BigInt(postId) >> 22n) + X_EPOCH_MS) / 1_000n);
}

function normalizeHash(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw invalid(`${label} must be a 32-byte hex hash.`);
  }
  return value.toLowerCase();
}

function normalizeAddress(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw invalid('baseWallet must be a 20-byte EVM address.');
  }
  return value.toLowerCase();
}

function normalizeHandle(value) {
  if (typeof value !== 'string') throw invalid('expectedHandle must be an X handle.');
  const handle = value.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw invalid('expectedHandle is invalid.');
  return handle;
}

function normalizePostId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{5,24}$/.test(value)) {
    throw invalid('postId must be a decimal X post ID.');
  }
  const postId = BigInt(value);
  if (postId > 18_446_744_073_709_551_615n) throw invalid('postId is outside the supported range.');
  return value;
}

function normalizeChallenge(value) {
  if (typeof value !== 'string' || !/^APV2-[A-Za-z0-9_-]{24}$/.test(value)) {
    throw invalid('challenge must be an APV2 ownership challenge.');
  }
  return value;
}

function normalizeSubmissionArgs(value) {
  if (!Array.isArray(value) || value.length !== 8) {
    throw invalid('Decoded verify_ownership arguments are incomplete.');
  }
  const requestId = normalizeHash(String(value[0]), 'requestId');
  const baseWallet = normalizeAddress(String(value[1]));
  const expectedHandle = normalizeHandle(String(value[2]));
  const postId = normalizePostId(String(value[3]));
  const challenge = normalizeChallenge(String(value[4]));
  const issuedAtEpoch = safeDecodedEpoch(value[5], 'issuedAtEpoch');
  const expiresAtEpoch = safeDecodedEpoch(value[6], 'expiresAtEpoch');
  const credentialExpiresAtEpoch = safeDecodedEpoch(
    value[7],
    'credentialExpiresAtEpoch',
  );
  return [
    requestId,
    baseWallet,
    expectedHandle,
    postId,
    challenge,
    issuedAtEpoch,
    expiresAtEpoch,
    credentialExpiresAtEpoch,
  ];
}

function safeDecodedEpoch(value, label) {
  if (
    typeof value === 'bigint' ||
    (typeof value === 'string' && /^[1-9][0-9]*$/.test(value))
  ) {
    const asBigInt = BigInt(value);
    if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw invalid(`${label} is outside the safe integer range.`);
    }
    return Number(asBigInt);
  }
  return safeEpoch(value, label);
}

function safeEpoch(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid(`${label} must be a positive epoch-second integer.`);
  return value;
}

function currentEpoch() {
  return Math.floor(Date.now() / 1_000);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function invalid(message) {
  return new SubmitterProblem(400, 'INVALID_OWNERSHIP_ENVELOPE', message);
}
