import { createHash, randomBytes } from 'node:crypto';

import { getAddress, isAddress } from 'viem';

export const OWNERSHIP_PROTOCOL_DOMAIN = 'xproof-x-ownership-v2';

const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const USER_ID_PATTERN = /^[0-9]{1,25}$/;
const POST_ID_PATTERN = /^[0-9]{5,25}$/;
const CHALLENGE_PATTERN = /^APV2-[A-Za-z0-9_-]{24}$/;

function sha256(value) {
  return `0x${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function normalizeWallet(wallet) {
  if (typeof wallet !== 'string') throw new Error('Invalid Base wallet');
  const normalized = wallet.trim();
  if (!isAddress(normalized)) throw new Error('Invalid Base wallet');
  return getAddress(normalized);
}

function normalizeHandle(handle) {
  if (typeof handle !== 'string') throw new Error('Invalid X handle');
  const trimmed = handle.trim();
  const normalized = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (!HANDLE_PATTERN.test(normalized)) throw new Error('Invalid X handle');
  return normalized;
}

function validatePostId(postId) {
  const normalized = String(postId ?? '').trim();
  if (!POST_ID_PATTERN.test(normalized)) throw new Error('Invalid X post ID');
  return normalized;
}

function validateChallenge(challenge) {
  const normalized = typeof challenge === 'string' ? challenge.trim() : '';
  if (!CHALLENGE_PATTERN.test(normalized)) {
    throw new Error('Invalid APV2 ownership challenge');
  }
  return normalized;
}

function validateEpoch(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${label}`);
  return value;
}

function normalizeEnvelopeFields({
  wallet,
  handle,
  postId,
  challenge,
  issuedAtEpoch,
  expiresAtEpoch,
  credentialExpiresAtEpoch,
}) {
  const normalizedWallet = normalizeWallet(wallet);
  const normalizedHandle = normalizeHandle(handle);
  const normalizedPostId = validatePostId(postId);
  const normalizedChallenge = validateChallenge(challenge);
  const issued = validateEpoch(issuedAtEpoch, 'issue time');
  const expires = validateEpoch(expiresAtEpoch, 'challenge expiry');
  const credentialExpires = validateEpoch(credentialExpiresAtEpoch, 'credential expiry');

  if (expires <= issued || expires - issued < 300 || expires - issued > 3_600) {
    throw new Error('Challenge TTL must be between 5 and 60 minutes');
  }
  if (
    credentialExpires <= issued
    || credentialExpires - issued < 24 * 60 * 60
    || credentialExpires - issued > 90 * 24 * 60 * 60
  ) throw new Error('Credential TTL must be between 1 and 90 days');

  return {
    wallet: normalizedWallet,
    handle: normalizedHandle,
    postId: normalizedPostId,
    challenge: normalizedChallenge,
    issuedAtEpoch: issued,
    expiresAtEpoch: expires,
    credentialExpiresAtEpoch: credentialExpires,
  };
}

function ownershipEnvelope(fields) {
  return [
    OWNERSHIP_PROTOCOL_DOMAIN,
    fields.wallet.toLowerCase(),
    fields.handle.toLowerCase(),
    fields.postId,
    fields.challenge,
    fields.issuedAtEpoch,
    fields.expiresAtEpoch,
    fields.credentialExpiresAtEpoch,
  ].join('|');
}

function ownershipTweetText({ wallet, challenge, issuedAtEpoch, expiresAtEpoch, credentialExpiresAtEpoch }) {
  return [
    'XProof v2',
    `w=${wallet}`,
    `n=${challenge}`,
    `i=${issuedAtEpoch}`,
    `e=${expiresAtEpoch}`,
    `c=${credentialExpiresAtEpoch}`,
  ].join(' ');
}

export function identityCommitment(xUserId) {
  if (!USER_ID_PATTERN.test(xUserId)) throw new Error('Invalid immutable X user ID');
  return sha256(`x-user-id:${xUserId}`);
}

export function ownershipRequestId(fields) {
  return sha256(ownershipEnvelope(normalizeEnvelopeFields(fields)));
}

export function createOwnershipChallenge({
  wallet,
  handle,
  nowEpoch = Math.floor(Date.now() / 1_000),
  challengeTtlSeconds = 15 * 60,
  credentialTtlSeconds = 30 * 24 * 60 * 60,
}) {
  const normalizedWallet = normalizeWallet(wallet);
  const normalizedHandle = normalizeHandle(handle);
  const issuedAtEpoch = validateEpoch(nowEpoch, 'issue time');
  if (!Number.isSafeInteger(challengeTtlSeconds) || challengeTtlSeconds < 300 || challengeTtlSeconds > 3_600) {
    throw new Error('Challenge TTL must be between 5 and 60 minutes');
  }
  if (
    !Number.isSafeInteger(credentialTtlSeconds)
    || credentialTtlSeconds < 24 * 60 * 60
    || credentialTtlSeconds > 90 * 24 * 60 * 60
  ) throw new Error('Credential TTL must be between 1 and 90 days');

  const challenge = `APV2-${randomBytes(18).toString('base64url')}`;
  const expiresAtEpoch = issuedAtEpoch + challengeTtlSeconds;
  const credentialExpiresAtEpoch = issuedAtEpoch + credentialTtlSeconds;
  if (!Number.isSafeInteger(expiresAtEpoch) || !Number.isSafeInteger(credentialExpiresAtEpoch)) {
    throw new Error('Ownership challenge timestamps exceed the safe integer range');
  }

  return {
    protocol: OWNERSHIP_PROTOCOL_DOMAIN,
    protocolVersion: 2,
    requestId: null,
    postId: null,
    wallet: normalizedWallet,
    handle: normalizedHandle,
    challenge,
    challengeDigest: sha256(challenge),
    tweetText: ownershipTweetText({
      wallet: normalizedWallet,
      challenge,
      issuedAtEpoch,
      expiresAtEpoch,
      credentialExpiresAtEpoch,
    }),
    issuedAtEpoch,
    expiresAtEpoch,
    credentialExpiresAtEpoch,
  };
}

export function finalizeOwnershipChallenge(ownershipChallenge, postId) {
  if (!ownershipChallenge || typeof ownershipChallenge !== 'object' || Array.isArray(ownershipChallenge)) {
    throw new Error('Invalid ownership challenge');
  }
  const fields = normalizeEnvelopeFields({ ...ownershipChallenge, postId });
  const envelope = ownershipEnvelope(fields);

  return {
    protocol: OWNERSHIP_PROTOCOL_DOMAIN,
    protocolVersion: 2,
    requestId: sha256(envelope),
    postId: fields.postId,
    wallet: fields.wallet,
    handle: fields.handle,
    challenge: fields.challenge,
    challengeDigest: sha256(fields.challenge),
    tweetText: ownershipTweetText(fields),
    issuedAtEpoch: fields.issuedAtEpoch,
    expiresAtEpoch: fields.expiresAtEpoch,
    credentialExpiresAtEpoch: fields.credentialExpiresAtEpoch,
  };
}
