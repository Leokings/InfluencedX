import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  assertGenLayerTransactionBinding,
  normalizeGenLayerReceipt,
} from '../../src/relay/genlayer-source.mjs';

const requestId = `0x${'12'.repeat(32)}`;

function receipt(method, firstArg = requestId) {
  return {
    txDataDecoded: {
      callData: new Map([
        ['args', [firstArg, 'other-argument']],
        ['method', method],
      ]),
    },
  };
}

const campaignBinding = Object.freeze({
  requestId,
  expectedHandle: 'creator_name',
  postId: '2109876543210987654',
  requiredPhrasesJson: '["InfluencedX","creator escrow"]',
  forbiddenPhrasesJson: '["guaranteed profit"]',
  requireAdDisclosure: true,
  semanticBrief: 'Explain the product accurately.',
  resolveNotBeforeEpoch: 1_800_000_500n,
  assignmentId: 42n,
  agreementHash: `0x${'56'.repeat(32)}`,
  submissionHash: `0x${'78'.repeat(32)}`,
});

function campaignResult(overrides = {}) {
  return {
    kind: 'CAMPAIGN',
    request_id: campaignBinding.requestId,
    assignment_id: Number(campaignBinding.assignmentId),
    agreement_hash: campaignBinding.agreementHash,
    submission_hash: campaignBinding.submissionHash,
    handle: campaignBinding.expectedHandle,
    post_id: campaignBinding.postId,
    outcome: 'PASS',
    ...overrides,
  };
}

function campaignReceipt(args = campaignArguments()) {
  return {
    txDataDecoded: {
      callData: new Map([
        ['args', args],
        ['method', 'resolve_submission'],
      ]),
    },
  };
}

function campaignArguments() {
  return [
    campaignBinding.requestId,
    campaignBinding.expectedHandle,
    campaignBinding.postId,
    campaignBinding.requiredPhrasesJson,
    campaignBinding.forbiddenPhrasesJson,
    campaignBinding.requireAdDisclosure,
    campaignBinding.semanticBrief,
    Number(campaignBinding.resolveNotBeforeEpoch),
    Number(campaignBinding.assignmentId),
    campaignBinding.agreementHash,
    campaignBinding.submissionHash,
  ];
}

test('source transaction is bound to result kind and request ID', () => {
  assert.doesNotThrow(() => assertGenLayerTransactionBinding(
    receipt('snapshot_metrics'),
    { kind: 'METRICS' },
    requestId,
  ));
});

test('source transaction with the wrong resolver method is rejected', () => {
  assert.throws(() => assertGenLayerTransactionBinding(
    receipt('verify_ownership'),
    { kind: 'CAMPAIGN' },
    requestId,
  ), /expected resolve_submission/);
});

test('source transaction with another request ID is rejected', () => {
  assert.throws(() => assertGenLayerTransactionBinding(
    receipt('resolve_submission', `0x${'34'.repeat(32)}`),
    { kind: 'CAMPAIGN' },
    requestId,
  ), /request ID does not match/);
});

test('campaign source transaction binds all eleven canonical resolver arguments and result fields', () => {
  assert.doesNotThrow(() => assertGenLayerTransactionBinding(
    campaignReceipt(),
    campaignResult(),
    requestId,
    campaignBinding,
  ));
});

test('campaign source transaction is rejected when any canonical resolver argument changes', () => {
  const mutations = [
    `0x${'91'.repeat(32)}`,
    'another_handle',
    '2109876543210987655',
    '["InfluencedX"]',
    '[]',
    false,
    'A different brief.',
    Number(campaignBinding.resolveNotBeforeEpoch) + 1,
    Number(campaignBinding.assignmentId) + 1,
    `0x${'92'.repeat(32)}`,
    `0x${'93'.repeat(32)}`,
  ];
  for (let index = 0; index < mutations.length; index += 1) {
    const args = campaignArguments();
    args[index] = mutations[index];
    assert.throws(() => assertGenLayerTransactionBinding(
      campaignReceipt(args),
      campaignResult(),
      requestId,
      campaignBinding,
    ), /does not match|request ID/);
  }
});

test('campaign source result is rejected when it diverges from verified calldata or Base state', () => {
  const mutations = [
    { request_id: `0x${'94'.repeat(32)}` },
    { handle: 'another_handle' },
    { post_id: '2109876543210987655' },
    { assignment_id: 43 },
    { agreement_hash: `0x${'95'.repeat(32)}` },
    { submission_hash: `0x${'96'.repeat(32)}` },
  ];
  for (const mutation of mutations) {
    assert.throws(() => assertGenLayerTransactionBinding(
      campaignReceipt(),
      campaignResult(mutation),
      requestId,
      campaignBinding,
    ), /does not match|not canonical/);
  }
});

test('campaign result cannot pass source validation without a verified Base binding', () => {
  assert.throws(() => assertGenLayerTransactionBinding(
    campaignReceipt(),
    campaignResult(),
    requestId,
  ), /requires verified Base campaign binding/);
});

test('simplified Bradbury numeric receipt preserves distinct finality and execution labels', () => {
  const normalized = normalizeGenLayerReceipt({
    status: 7,
    txExecutionResult: 1,
  });
  assert.equal(normalized.statusName, 'FINALIZED');
  assert.equal(normalized.txExecutionResultName, 'FINISHED_WITH_RETURN');
});

test('simplified snake-case lifecycle label is accepted without inventing execution success', () => {
  const normalized = normalizeGenLayerReceipt({
    status: 7,
    status_name: 'FINALIZED',
    tx_execution_result: 2,
  });
  assert.equal(normalized.statusName, 'FINALIZED');
  assert.equal(normalized.txExecutionResultName, 'FINISHED_WITH_ERROR');
});

test('finality reader requests full calldata for method and request rebinding', async () => {
  const source = await fs.readFile(
    new URL('../../src/relay/genlayer-source.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /fullTransaction:\s*true/);
  assert.match(source, /assertGenLayerTransactionBinding\(receipt, result, requestId, campaignBinding\)/);
});
