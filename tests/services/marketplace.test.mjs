import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  createOwnershipChallenge,
  finalizeOwnershipChallenge,
  identityCommitment,
  OWNERSHIP_PROTOCOL_DOMAIN,
  ownershipRequestId,
} from '../../src/identity/challenge.mjs';
import { estimateCreatorPay } from '../../src/marketplace/pay-estimate.mjs';

test('APV2 ownership challenge is pre-post and does not require a caller-supplied X user ID', () => {
  const input = {
    wallet: '0x52908400098527886e0f7030069857d2e4169ee7',
    handle: '@XDevelopers',
    nowEpoch: 1_800_000_000,
  };
  const first = createOwnershipChallenge(input);
  const second = createOwnershipChallenge(input);
  assert.equal(first.protocol, OWNERSHIP_PROTOCOL_DOMAIN);
  assert.equal(first.requestId, null);
  assert.equal(first.postId, null);
  assert.equal('identityHash' in first, false);
  assert.equal(first.handle, 'XDevelopers');
  assert.notEqual(first.challenge, second.challenge);
  assert.match(first.tweetText, /^XProof v2 w=0x[0-9a-fA-F]{40} n=APV2-[A-Za-z0-9_-]{24} i=1800000000 e=1800000900 c=1802592000$/);
  assert.match(first.tweetText, /w=0x52908400098527886E0F7030069857D2E4169EE7 /);
  assert.equal(first.expiresAtEpoch, 1_800_000_900);
});

test('finalized APV2 request ID hashes the exact normalized post-bound envelope', () => {
  const draft = createOwnershipChallenge({
    wallet: `0x${'11'.repeat(20)}`,
    handle: '@XDevelopers',
    nowEpoch: 1_800_000_000,
  });
  const postId = '1900000000000000000';
  const finalized = finalizeOwnershipChallenge(draft, postId);
  const envelope = [
    'xproof-x-ownership-v2',
    `0x${'11'.repeat(20)}`,
    'xdevelopers',
    postId,
    draft.challenge,
    draft.issuedAtEpoch,
    draft.expiresAtEpoch,
    draft.credentialExpiresAtEpoch,
  ].join('|');
  const expected = `0x${createHash('sha256').update(envelope, 'utf8').digest('hex')}`;

  assert.equal(finalized.requestId, expected);
  assert.equal(finalized.postId, postId);
  assert.equal(finalized.tweetText, draft.tweetText);
  assert.notEqual(finalizeOwnershipChallenge(draft, '1900000000000000001').requestId, finalized.requestId);
  assert.equal(identityCommitment('2244994945').length, 66);
});

test('APV2 normalized envelope matches the published cross-runtime test vector', () => {
  assert.equal(
    ownershipRequestId({
      wallet: ` 0x${'11'.repeat(20)} `,
      handle: ' @XDevelopers ',
      postId: '1900000000000000000',
      challenge: ' APV2-abcdefghijklmnopqrstuvwx ',
      issuedAtEpoch: 1_800_000_000,
      expiresAtEpoch: 1_800_000_900,
      credentialExpiresAtEpoch: 1_802_592_000,
    }),
    '0x1398bdfc25c11bd297ce1f457a0f9df5d9fd07b385a89209e5fc91ca980c0ce6',
  );
});

test('estimated pay is a range and penalizes high-risk engagement evidence', () => {
  const metrics = {
    followers: 100_000,
    median_likes: 500,
    median_replies: 40,
    median_reposts: 60,
    posts_analyzed: 10,
    account_created_at_ms: 1_500_000_000_000,
    engagement_consistency: 'LOW_RISK',
  };
  const healthy = estimateCreatorPay({ metrics, contentType: 'video', nowEpoch: 1_800_000_000 });
  const risky = estimateCreatorPay({
    metrics: { ...metrics, engagement_consistency: 'HIGH_RISK' },
    contentType: 'video',
    nowEpoch: 1_800_000_000,
  });
  assert.ok(healthy.minimumUsdc < healthy.targetUsdc);
  assert.ok(healthy.targetUsdc < healthy.maximumUsdc);
  assert.ok(risky.targetUsdc < healthy.targetUsdc);
  assert.equal(risky.confidence, 'LOW');
  assert.ok(risky.riskFlags.includes('ENGAGEMENT_OUTLIER_HIGH_RISK'));
});
