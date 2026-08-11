import assert from "node:assert/strict";
import test from "node:test";

import { submissionCallFingerprint, validateQueueMessage } from "../lib/envelope";
import { GateBusyError, PoisonMessageError } from "../lib/problem";
import { SubmissionIngressService } from "../lib/submission-ingress";
import { assertResolverResult, SubmissionService, transactionBindingError } from "../lib/submission-service";
import {
  FakeBradburyClient,
  FakeQueue,
  finalizedReceipt,
  makeEnvelope,
  MemoryRepository,
  ownershipResult,
  SIGNER,
  TX_HASH,
} from "./helpers";

function setup() {
  const repository = new MemoryRepository();
  const client = new FakeBradburyClient();
  const queue = new FakeQueue();
  const processor = new SubmissionService(repository, client, queue);
  const ingress = new SubmissionIngressService(repository, queue);
  const service = {
    accept: ingress.accept.bind(ingress),
    process: processor.process.bind(processor),
  };
  return { repository, client, queue, service, ingress };
}

function message(requestId: string) {
  return validateQueueMessage({ schemaVersion: 1, requestId });
}

test("accepts quickly, persists QUEUED, and idempotently replays the same envelope", async () => {
  const { repository, queue, ingress } = setup();
  const envelope = makeEnvelope();
  const first = await ingress.accept(envelope);
  const replay = await ingress.accept(envelope);
  assert.equal(first.replayed, false);
  assert.equal(first.submission.status, "QUEUED");
  assert.equal(replay.replayed, true);
  assert.equal(repository.records.size, 1);
  assert.deepEqual(queue.submits, [envelope.requestId, envelope.requestId]);
});

test("duplicate at-least-once deliveries never broadcast twice", async () => {
  const { service, client } = setup();
  const envelope = makeEnvelope();
  await service.accept(envelope);
  let release!: () => void;
  client.submitBarrier = new Promise<void>((resolve) => { release = resolve; });

  const first = service.process(message(envelope.requestId), 1);
  while (client.activeSubmits === 0) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(service.process(message(envelope.requestId), 2), GateBusyError);
  release();
  await first;
  await service.process(message(envelope.requestId), 3);
  assert.equal(client.submitCalls, 1);
});

test("overlapping distinct requests are serialized account-wide with max signer concurrency one", async () => {
  const { service, client } = setup();
  const firstEnvelope = makeEnvelope();
  const secondEnvelope = makeEnvelope({
    baseWallet: `0x${"34".repeat(20)}`,
    challenge: `APV2-${"b".repeat(24)}`,
  });
  await service.accept(firstEnvelope);
  await service.accept(secondEnvelope);
  let release!: () => void;
  client.submitBarrier = new Promise<void>((resolve) => { release = resolve; });

  const first = service.process(message(firstEnvelope.requestId), 1);
  while (client.activeSubmits === 0) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(service.process(message(secondEnvelope.requestId), 1), GateBusyError);
  release();
  await first;
  client.submitBarrier = null;
  await service.process(message(secondEnvelope.requestId), 2);

  assert.equal(client.submitCalls, 2);
  assert.equal(client.maxActiveSubmits, 1);
});

test("an ambiguous broadcast is quarantined and duplicate delivery cannot resubmit", async () => {
  const { repository, service, client } = setup();
  const envelope = makeEnvelope();
  await service.accept(envelope);
  client.submitError = new Error("connection closed after acceptance");
  await service.process(message(envelope.requestId), 1);
  assert.equal(repository.records.get(envelope.requestId)?.status, "RECONCILIATION_REQUIRED");
  await service.process(message(envelope.requestId), 2);
  assert.equal(client.submitCalls, 1);

  const secondEnvelope = makeEnvelope({ baseWallet: `0x${"56".repeat(20)}`, challenge: `APV2-${"c".repeat(24)}` });
  await service.accept(secondEnvelope);
  await assert.rejects(service.process(message(secondEnvelope.requestId), 1), GateBusyError);
  assert.equal(client.submitCalls, 1);
});

test("a crash after broadcast but before hash persistence freezes BROADCASTING behind the durable gate", async () => {
  const { repository, service, client } = setup();
  const envelope = makeEnvelope();
  await service.accept(envelope);
  repository.failRecordSubmitted = true;
  await assert.rejects(service.process(message(envelope.requestId), 1), /simulated database crash/);
  assert.equal(repository.records.get(envelope.requestId)?.status, "BROADCASTING");
  await assert.rejects(service.process(message(envelope.requestId), 2), GateBusyError);
  assert.equal(client.submitCalls, 1);
});

test("precheck failures never broadcast and remain safely retryable", async () => {
  const { repository, service, client } = setup();
  const envelope = makeEnvelope();
  await service.accept(envelope);
  client.precheckError = new Error("RPC unavailable");
  await assert.rejects(service.process(message(envelope.requestId), 1), (error: unknown) => (error as { code?: string }).code === "BRADBURY_PRECHECK_UNAVAILABLE");
  assert.equal(client.submitCalls, 0);
  assert.equal(repository.records.get(envelope.requestId)?.status, "PRECHECK_FAILED");
  client.precheckError = null;
  await service.process(message(envelope.requestId), 2);
  assert.equal(client.submitCalls, 1);
});

test("an existing resolver result is quarantined without a broadcast", async () => {
  const { repository, service, client } = setup();
  const envelope = makeEnvelope();
  await service.accept(envelope);
  client.precheckResult = ownershipResult(envelope.requestId, "REJECTED");
  await service.process(message(envelope.requestId), 1);
  const record = repository.records.get(envelope.requestId);
  assert.equal(record?.status, "RECONCILIATION_REQUIRED");
  assert.equal(record?.resultOutcome, "REJECTED");
  assert.equal(client.submitCalls, 0);
});

test("unknown and missing-envelope queue jobs are poisoned without touching the signer", async () => {
  const { repository, service, client } = setup();
  const envelope = makeEnvelope();
  await assert.rejects(service.process(message(envelope.requestId), 1), PoisonMessageError);
  await service.accept(envelope);
  repository.removeEnvelope(envelope.requestId);
  await assert.rejects(service.process(message(envelope.requestId), 1), PoisonMessageError);
  assert.equal(repository.records.get(envelope.requestId)?.status, "POISONED");
  assert.equal(client.submitCalls, 0);
});

test("polling binds the exact transaction and final resolver outcome", async () => {
  const { repository, service, client, queue } = setup();
  const envelope = makeEnvelope();
  await service.accept(envelope);
  await service.process(message(envelope.requestId), 1);
  client.receipt = finalizedReceipt(envelope);
  client.finalResult = ownershipResult(envelope.requestId, "VERIFIED");
  await service.process(message(envelope.requestId), 2);
  const record = repository.records.get(envelope.requestId);
  assert.equal(record?.status, "FINALIZED");
  assert.equal(record?.resultOutcome, "VERIFIED");
  assert.equal(record?.txHash, TX_HASH);
  assert.deepEqual(queue.polls[0], { requestId: envelope.requestId, attempt: 0 });
});

test("non-final receipts schedule a new idempotent poll attempt", async () => {
  const { repository, service, client, queue } = setup();
  const envelope = makeEnvelope();
  await service.accept(envelope);
  await service.process(message(envelope.requestId), 1);
  client.receipt = finalizedReceipt(envelope, { statusName: "ACCEPTED", txExecutionResultName: null });
  await service.process(message(envelope.requestId), 2);
  assert.equal(repository.records.get(envelope.requestId)?.status, "POLLING");
  assert.deepEqual(queue.polls.at(-1), { requestId: envelope.requestId, attempt: 1 });
});

test("receipt binding rejects every mismatched state-changing field", () => {
  const envelope = makeEnvelope();
  const record = {
    requestId: envelope.requestId,
    txHash: TX_HASH,
    functionName: "verify_ownership" as const,
    callFingerprint: submissionCallFingerprint(envelope),
  };
  assert.equal(transactionBindingError(finalizedReceipt(envelope), record, SIGNER), null);

  const cases: Array<[Record<string, unknown>, string]> = [
    [{ hash: undefined }, "TRANSACTION_HASH_MISSING_FROM_RECEIPT"],
    [{ hash: `0x${"cd".repeat(32)}` }, "TRANSACTION_HASH_MISMATCH"],
    [{ sender: undefined }, "TRANSACTION_SENDER_MISSING"],
    [{ sender: `0x${"99".repeat(20)}` }, "TRANSACTION_SENDER_MISMATCH"],
    [{ recipient: undefined }, "TRANSACTION_RESOLVER_MISSING"],
    [{ recipient: `0x${"99".repeat(20)}` }, "TRANSACTION_RESOLVER_MISMATCH"],
    [{ value: undefined }, "TRANSACTION_VALUE_INVALID"],
    [{ value: "" }, "TRANSACTION_VALUE_INVALID"],
    [{ value: " " }, "TRANSACTION_VALUE_INVALID"],
    [{ value: false }, "TRANSACTION_VALUE_INVALID"],
    [{ value: [] }, "TRANSACTION_VALUE_INVALID"],
    [{ value: "00" }, "TRANSACTION_VALUE_INVALID"],
    [{ value: 1 }, "TRANSACTION_VALUE_MISMATCH"],
    [{ txDataDecoded: { callData: { args: [] } } }, "TRANSACTION_METHOD_MISSING"],
    [{ txDataDecoded: { callData: { method: "other", args: [] } } }, "TRANSACTION_METHOD_MISMATCH"],
    [{ txDataDecoded: { callData: { method: "verify_ownership" } } }, "TRANSACTION_ARGUMENTS_MISSING"],
    [{ txDataDecoded: { callData: { method: "verify_ownership", args: [envelope.requestId] } } }, "TRANSACTION_ARGUMENTS_INVALID"],
  ];
  for (const [override, expected] of cases) {
    assert.equal(transactionBindingError(finalizedReceipt(envelope, override), record, SIGNER), expected);
  }
  const missingValue = finalizedReceipt(envelope);
  delete missingValue.value;
  assert.equal(transactionBindingError(missingValue, record, SIGNER), null);
});

test("Bradbury's value-less consensus receipt is accepted only because the signer adapter hard-codes zero value", async () => {
  const envelope = makeEnvelope();
  const record = {
    requestId: envelope.requestId,
    txHash: TX_HASH,
    functionName: "verify_ownership" as const,
    callFingerprint: submissionCallFingerprint(envelope),
  };
  const receipt = finalizedReceipt(envelope);
  delete receipt.value;

  assert.equal(transactionBindingError(receipt, record, SIGNER), null);

  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../lib/bradbury-client.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /value:\s*0n/);
});

test("a VERIFIED resolver result requires all eleven exact proof flags", () => {
  const envelope = makeEnvelope();
  const verified = ownershipResult(envelope.requestId, "VERIFIED");
  assert.equal(assertResolverResult(verified, envelope.requestId), "VERIFIED");
  for (const field of [
    "request_match",
    "post_id_match",
    "protocol_match",
    "wallet_match",
    "issued_at_match",
    "expires_at_match",
    "credential_expires_at_match",
    "challenge_match",
    "publication_in_window",
    "identity_match",
    "author_match",
  ]) {
    assert.throws(
      () => assertResolverResult({ ...verified, [field]: false }, envelope.requestId),
      /missing an exact proof check/,
    );
  }
});
