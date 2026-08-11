import assert from 'node:assert/strict';
import test from 'node:test';

import { keccak256, recoverTypedDataAddress, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  buildAttestation,
  buildOwnershipIntent,
  canonicalJson,
  recoverBundleSigner,
} from '../../src/relay/attestations.mjs';

const watcher = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const resolver = `0x${'22'.repeat(20)}`;
const receiver = `0x${'33'.repeat(20)}`;
const txHash = `0x${'44'.repeat(32)}`;
const requestId = `0x${'55'.repeat(32)}`;

test('ownership result becomes the exact EIP-712 payload recoverable to a watcher', async () => {
  const result = {
    kind: 'OWNERSHIP',
    request_id: requestId,
    base_wallet: `0x${'66'.repeat(20)}`,
    identity_hash: `0x${'77'.repeat(32)}`,
    handle: 'XDevelopers',
    post_id: '1346889436626259968',
    challenge_hash: `0x${'ab'.repeat(32)}`,
    verified_at_epoch: 1_800_000_000,
    credential_expires_at_epoch: 1_802_592_000,
    identity_match: true,
    author_match: true,
    request_match: true,
    post_id_match: true,
    protocol_match: true,
    wallet_match: true,
    issued_at_match: true,
    expires_at_match: true,
    credential_expires_at_match: true,
    challenge_match: true,
    publication_in_window: true,
    outcome: 'VERIFIED',
  };
  const bundle = buildAttestation({ result, resolver, txHash, receiver });
  const signature = await watcher.signTypedData(bundle);
  assert.equal(await recoverBundleSigner(bundle, signature), watcher.address);
  assert.equal(bundle.primaryType, 'CreatorVerification');
  assert.equal(bundle.domain.name, 'XProofAttestationReceiver');
  assert.equal(bundle.domain.version, '2');
  assert.equal(bundle.message.attestationId, requestId);
  assert.equal(bundle.message.challengeHash, result.challenge_hash);
  assert.equal(bundle.message.metricsHash, `0x${'00'.repeat(32)}`);

  const intent = buildOwnershipIntent({ attestation: bundle, receiver });
  const creator = privateKeyToAccount(`0x${'12'.repeat(32)}`);
  const creatorBoundIntent = {
    ...intent,
    message: { ...intent.message, wallet: creator.address },
  };
  const ownershipSignature = await creator.signTypedData(creatorBoundIntent);
  assert.equal(
    await recoverTypedDataAddress({ ...creatorBoundIntent, signature: ownershipSignature }),
    creator.address,
  );
  assert.equal(intent.message.credentialExpiresAt, BigInt(result.credential_expires_at_epoch));
});

test('ownership intent commits every creator-controlled verification field', () => {
  const base = {
    attestationId: requestId,
    wallet: `0x${'66'.repeat(20)}`,
    handleHash: `0x${'77'.repeat(32)}`,
    verificationPostHash: `0x${'88'.repeat(32)}`,
    challengeHash: `0x${'99'.repeat(32)}`,
    expiresAt: 1_802_592_000n,
    genlayerContract: `0x${'00'.repeat(12)}${'22'.repeat(20)}`,
  };
  const intent = buildOwnershipIntent({ attestation: base, receiver });
  assert.deepEqual(Object.keys(intent.message), [
    'attestationId',
    'wallet',
    'handleHash',
    'verificationPostHash',
    'challengeHash',
    'credentialExpiresAt',
    'genlayerContract',
  ]);
});

test('a VERIFIED ownership envelope is rejected if any v2 binding check is false', () => {
  const bindingChecks = [
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
  ];
  const result = {
    kind: 'OWNERSHIP',
    request_id: requestId,
    base_wallet: `0x${'66'.repeat(20)}`,
    identity_hash: `0x${'77'.repeat(32)}`,
    handle: 'XDevelopers',
    post_id: '1346889436626259968',
    challenge_hash: `0x${'ab'.repeat(32)}`,
    verified_at_epoch: 1_800_000_000,
    credential_expires_at_epoch: 1_802_592_000,
    outcome: 'VERIFIED',
    ...Object.fromEntries(bindingChecks.map((field) => [field, true])),
  };
  for (const field of bindingChecks) {
    assert.throws(
      () => buildAttestation({
        result: { ...result, [field]: false },
        resolver,
        txHash,
        receiver,
      }),
      new RegExp(`Ownership ${field} check failed`),
    );
  }
});

test('campaign result is bound to assignment, request, outcome, and evidence', () => {
  const bundle = buildAttestation({
    resolver,
    txHash,
    receiver,
    result: {
      kind: 'CAMPAIGN',
      request_id: requestId,
      assignment_id: 42,
      agreement_hash: `0x${'88'.repeat(32)}`,
      submission_hash: `0x${'99'.repeat(32)}`,
      evidence_hash: `0x${'aa'.repeat(32)}`,
      resolved_at_epoch: 1_800_000_000,
      outcome: 'UNDETERMINED',
    },
  });
  assert.equal(bundle.primaryType, 'CampaignResolution');
  assert.equal(bundle.message.assignmentId, 42n);
  assert.equal(bundle.message.outcome, 3n);
  assert.equal(bundle.message.evidenceHash, `0x${'aa'.repeat(32)}`);
});

test('failed ownership result cannot be turned into a Base attestation', () => {
  assert.throws(() => buildAttestation({
    resolver,
    txHash,
    receiver,
    result: { kind: 'OWNERSHIP', request_id: requestId, outcome: 'REJECTED' },
  }), /Only VERIFIED/);
});

test('watchers reject ownership results that omit the GenLayer challenge commitment', () => {
  assert.throws(() => buildAttestation({
    resolver,
    txHash,
    receiver,
    result: {
      kind: 'OWNERSHIP',
      request_id: requestId,
      base_wallet: `0x${'66'.repeat(20)}`,
      identity_hash: `0x${'77'.repeat(32)}`,
      handle: 'XDevelopers',
      post_id: '1346889436626259968',
      verified_at_epoch: 1_800_000_000,
      credential_expires_at_epoch: 1_802_592_000,
      identity_match: true,
      author_match: true,
      request_match: true,
      post_id_match: true,
      protocol_match: true,
      wallet_match: true,
      issued_at_match: true,
      expires_at_match: true,
      credential_expires_at_match: true,
      challenge_match: true,
      publication_in_window: true,
      outcome: 'VERIFIED',
    },
  }), /Challenge hash must be bytes32/);
});

test('canonical result hashing includes nested evidence regardless of key order', () => {
  const left = { outcome: 'PASS', evidence: { views: 42, checks: ['author', 'retention'] } };
  const right = { evidence: { checks: ['author', 'retention'], views: 42 }, outcome: 'PASS' };
  const changed = { evidence: { checks: ['author', 'retention'], views: 43 }, outcome: 'PASS' };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.notEqual(canonicalJson(left), canonicalJson(changed));
});

test('25 campaign resolutions can be prepared and signed concurrently without collisions', async () => {
  const records = await Promise.all(Array.from({ length: 25 }, async (_item, index) => {
    const assignmentId = index + 1;
    const concurrentRequestId = keccak256(stringToHex(`request:${assignmentId}`));
    const concurrentTxHash = keccak256(stringToHex(`genlayer-tx:${assignmentId}`));
    const bundle = buildAttestation({
      resolver,
      txHash: concurrentTxHash,
      receiver,
      result: {
        kind: 'CAMPAIGN',
        request_id: concurrentRequestId,
        assignment_id: assignmentId,
        agreement_hash: keccak256(stringToHex(`agreement:${assignmentId}`)),
        submission_hash: keccak256(stringToHex(`submission:${assignmentId}`)),
        evidence_hash: keccak256(stringToHex(`evidence:${assignmentId}`)),
        resolved_at_epoch: 1_800_000_000 + assignmentId,
        outcome: assignmentId % 3 === 0 ? 'UNDETERMINED' : assignmentId % 2 === 0 ? 'FAIL' : 'PASS',
      },
    });
    const signature = await watcher.signTypedData(bundle);
    return {
      assignmentId: bundle.message.assignmentId,
      requestId: bundle.message.requestId,
      signer: await recoverBundleSigner(bundle, signature),
    };
  }));

  assert.equal(new Set(records.map(({ requestId: id }) => id)).size, 25);
  assert.deepEqual(records.map(({ assignmentId }) => assignmentId), Array.from({ length: 25 }, (_item, index) => BigInt(index + 1)));
  assert.equal(records.every(({ signer }) => signer === watcher.address), true);
});
