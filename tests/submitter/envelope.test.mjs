import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ownershipRequestId,
  submissionArgs,
  validateOwnershipEnvelope,
} from '../../services/bradbury-submitter/src/envelope.mjs';
import { NOW_EPOCH, makeEnvelope, snowflakeAt } from './helpers.mjs';

test('normalizes and validates the complete APV2 envelope', async () => {
  const envelope = await makeEnvelope({
    baseWallet: `0x${'AB'.repeat(20)}`,
    expectedHandle: '@XProof_Creator',
  });
  envelope.requestId = await ownershipRequestId({
    ...envelope,
    baseWallet: envelope.baseWallet.toLowerCase(),
    expectedHandle: 'xproof_creator',
  });
  const normalized = await validateOwnershipEnvelope(envelope, { nowEpoch: NOW_EPOCH });
  assert.equal(normalized.baseWallet, envelope.baseWallet.toLowerCase());
  assert.equal(normalized.expectedHandle, 'xproof_creator');
  assert.deepEqual(submissionArgs(normalized), [
    normalized.requestId,
    normalized.baseWallet,
    normalized.expectedHandle,
    normalized.postId,
    normalized.challenge,
    normalized.issuedAtEpoch,
    normalized.expiresAtEpoch,
    normalized.credentialExpiresAtEpoch,
  ]);
});

test('rejects extra fields instead of accepting arbitrary call controls', async () => {
  const envelope = await makeEnvelope({ extra: { functionName: 'snapshot_metrics' } });
  await assert.rejects(
    validateOwnershipEnvelope(envelope, { nowEpoch: NOW_EPOCH }),
    (error) => error.code === 'INVALID_OWNERSHIP_ENVELOPE' && /unsupported fields/.test(error.message),
  );
});

test('rejects an APV2 request ID that does not bind the envelope', async () => {
  const envelope = await makeEnvelope({ requestId: `0x${'00'.repeat(32)}` });
  await assert.rejects(
    validateOwnershipEnvelope(envelope, { nowEpoch: NOW_EPOCH }),
    /requestId does not match/,
  );
});

test('rejects expired challenges before any submitter call', async () => {
  const issuedAtEpoch = NOW_EPOCH - 901;
  const envelope = await makeEnvelope({
    issuedAtEpoch,
    expiresAtEpoch: NOW_EPOCH - 1,
    postEpoch: issuedAtEpoch + 30,
  });
  await assert.rejects(
    validateOwnershipEnvelope(envelope, { nowEpoch: NOW_EPOCH }),
    /challenge has expired/,
  );
});

test('rejects a post snowflake outside the signed challenge window', async () => {
  const envelope = await makeEnvelope();
  envelope.postId = snowflakeAt(envelope.issuedAtEpoch - 5);
  envelope.requestId = await ownershipRequestId(envelope);
  await assert.rejects(
    validateOwnershipEnvelope(envelope, { nowEpoch: NOW_EPOCH }),
    /post timestamp is outside/,
  );
});

test('rejects unsupported credential lifetimes', async () => {
  const issuedAtEpoch = NOW_EPOCH - 60;
  const envelope = await makeEnvelope({
    issuedAtEpoch,
    credentialExpiresAtEpoch: issuedAtEpoch + 60 * 60,
  });
  await assert.rejects(
    validateOwnershipEnvelope(envelope, { nowEpoch: NOW_EPOCH }),
    /credential lifetime/,
  );
});
