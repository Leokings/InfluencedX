import assert from "node:assert/strict";
import test from "node:test";

import {
  metricsSubmissionArgs,
  submissionCallFingerprint,
  submissionFunctionName,
  validateMetricsEnvelope,
  validateQueueMessage,
} from "../lib/envelope";
import { SubmissionIngressService } from "../lib/submission-ingress";
import {
  assertResolverResult,
  sanitizeVerifiedMetricsResult,
  SubmissionService,
  transactionBindingError,
} from "../lib/submission-service";
import {
  FakeBradburyClient,
  FakeQueue,
  finalizedMetricsReceipt,
  makeMetricsEnvelope,
  MemoryRepository,
  metricsResult,
  NOW_EPOCH,
  SIGNER,
  TX_HASH,
} from "./helpers";

function setup() {
  const repository = new MemoryRepository();
  const client = new FakeBradburyClient();
  const queue = new FakeQueue();
  return {
    repository,
    client,
    queue,
    ingress: new SubmissionIngressService(repository, queue),
    processor: new SubmissionService(repository, client, queue),
  };
}

const message = (requestId: string) =>
  validateQueueMessage({ schemaVersion: 1, requestId });

test("metrics envelope is exact, profile-bound, request-bound, and fresh", async () => {
  const envelope = makeMetricsEnvelope();
  assert.deepEqual(
    await validateMetricsEnvelope(envelope, { nowEpoch: NOW_EPOCH }),
    envelope,
  );
  assert.equal(submissionFunctionName(envelope), "snapshot_metrics");
  assert.deepEqual(Object.keys(envelope).sort(), [
    "baseWallet",
    "expectedHandle",
    "identityHash",
    "kind",
    "metricsExpiresAtEpoch",
    "requestId",
    "schemaVersion",
  ]);
  for (const mutation of [
    { followers: 1_000_000 },
    { functionName: "resolve_submission" },
    { requestId: `0x${"99".repeat(32)}` },
    { baseWallet: `0x${"AA".repeat(20)}` },
    { identityHash: `0x${"BB".repeat(32)}` },
    { expectedHandle: "@InfluencedX" },
    { metricsExpiresAtEpoch: NOW_EPOCH },
    { metricsExpiresAtEpoch: NOW_EPOCH + 7 * 24 * 60 * 60 + 1 },
  ]) {
    await assert.rejects(
      validateMetricsEnvelope({ ...envelope, ...mutation }, { nowEpoch: NOW_EPOCH }),
      (error: unknown) => (error as { code?: string }).code === "INVALID_METRICS_ENVELOPE",
    );
  }
});

test("metrics jobs call only snapshot_metrics and persist a sanitized verified result", async () => {
  const { repository, client, ingress, processor } = setup();
  const envelope = makeMetricsEnvelope();
  await ingress.accept(envelope);
  await processor.process(message(envelope.requestId), 1);
  assert.equal(client.submitMetricsCalls, 1);
  assert.equal(client.submitOwnershipCalls, 0);
  assert.equal(client.submitCampaignCalls, 0);

  client.receipt = finalizedMetricsReceipt(envelope);
  client.finalResult = metricsResult(envelope);
  await processor.process(message(envelope.requestId), 2);
  const record = repository.records.get(envelope.requestId);
  assert.equal(record?.status, "FINALIZED");
  assert.equal(record?.resultOutcome, "VERIFIED");
  assert.deepEqual(record?.resultData, metricsResult(envelope));
});

test("metrics receipt binds the fixed method and all five canonical arguments", () => {
  const envelope = makeMetricsEnvelope();
  const record = {
    requestId: envelope.requestId,
    txHash: TX_HASH,
    functionName: "snapshot_metrics" as const,
    callFingerprint: submissionCallFingerprint(envelope),
  };
  assert.equal(transactionBindingError(finalizedMetricsReceipt(envelope), record, SIGNER), null);
  const args = [...metricsSubmissionArgs(envelope)];
  const replacements = [
    `0x${"99".repeat(32)}`,
    `0x${"34".repeat(20)}`,
    `0x${"77".repeat(32)}`,
    "other_handle",
    envelope.metricsExpiresAtEpoch + 1,
  ];
  for (let index = 0; index < args.length; index += 1) {
    const mutated = [...args];
    mutated[index] = replacements[index];
    assert.equal(
      transactionBindingError(finalizedMetricsReceipt(envelope, {
        txDataDecoded: { callData: { method: "snapshot_metrics", args: mutated } },
      }), record, SIGNER),
      "TRANSACTION_ARGUMENTS_MISMATCH",
    );
  }
  assert.equal(
    transactionBindingError(finalizedMetricsReceipt(envelope, {
      txDataDecoded: { callData: { method: "get_result", args } },
    }), record, SIGNER),
    "TRANSACTION_METHOD_MISMATCH",
  );
});

test("verified metrics finality rejects every identity binding and unsafe metric field", () => {
  const envelope = makeMetricsEnvelope();
  const result = metricsResult(envelope);
  assert.equal(
    assertResolverResult(result, envelope.requestId, "snapshot_metrics", envelope),
    "VERIFIED",
  );
  assert.deepEqual(sanitizeVerifiedMetricsResult(result), result);
  const mutations: Array<Record<string, unknown>> = [
    { request_id: `0x${"99".repeat(32)}` },
    { base_wallet: `0x${"34".repeat(20)}` },
    { identity_hash: `0x${"88".repeat(32)}` },
    { handle: "other_handle" },
    { metrics_expires_at_epoch: envelope.metricsExpiresAtEpoch + 1 },
    { measured_at_epoch: envelope.metricsExpiresAtEpoch },
    { identity_match: false },
    { protected: true },
    { x_user_id: "not-numeric" },
    { followers: Number.MAX_SAFE_INTEGER + 1 },
    {
      median_likes: Number.MAX_SAFE_INTEGER,
      median_replies: 1,
      median_reposts: 0,
    },
    { posts_analyzed: 21 },
    { engagement_consistency: "UNKNOWN" },
    { caller_supplied_count: 999_999_999 },
  ];
  for (const mutation of mutations) {
    assert.throws(() => assertResolverResult(
      { ...result, ...mutation },
      envelope.requestId,
      "snapshot_metrics",
      envelope,
    ));
  }
});
