import assert from "node:assert/strict";
import test from "node:test";

import { callFingerprint, validateOperationRequest, validateQueueMessage } from "../lib/envelope";
import { OperationIngressService } from "../lib/operation-ingress";
import { OperationService, transactionBindingError } from "../lib/operation-service";
import { GateBusyError, PoisonMessageError } from "../lib/problem";
import {
  CONTRACT,
  configFixture,
  expireEnvelope,
  FakeClient,
  FakeQueue,
  finalizedReceipt,
  MemoryRepository,
  NOW_EPOCH,
  resolveEnvelope,
  resolvePendingState,
  resolvePassState,
  resolvePreState,
  SIGNER,
  TX_HASH,
} from "./helpers";

function setup() {
  const repository = new MemoryRepository();
  const client = new FakeClient();
  const queue = new FakeQueue();
  const service = new OperationService(
    repository,
    client,
    queue,
    () => new Date(NOW_EPOCH * 1_000),
  );
  const ingress = new OperationIngressService(repository, queue);
  return { repository, client, queue, service, ingress };
}

function message(operationId: string) {
  return validateQueueMessage({ schemaVersion: 1, operationId });
}

test("ingress persists and replays one deterministic operation idempotently", async () => {
  const { repository, ingress, queue } = setup();
  const envelope = resolveEnvelope();
  const first = await ingress.accept(envelope);
  const replay = await ingress.accept(envelope);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(repository.records.size, 1);
  assert.deepEqual(queue.submits, [
    { operationId: envelope.operationId, generation: 1 },
    { operationId: envelope.operationId, generation: 2 },
  ]);
});

test("distinct operations are serialized behind one fenced signer", async () => {
  const { ingress, service, client } = setup();
  const firstEnvelope = resolveEnvelope();
  const secondEnvelope = expireEnvelope();
  await ingress.accept(firstEnvelope);
  await ingress.accept(secondEnvelope);
  let release!: () => void;
  client.submitBarrier = new Promise<void>((resolve) => { release = resolve; });
  const first = service.process(message(firstEnvelope.operationId), 1);
  while (client.activeSubmits === 0) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(service.process(message(secondEnvelope.operationId), 1), GateBusyError);
  release();
  await first;
  assert.equal(client.submitCalls, 1);
  assert.equal(client.maxActiveSubmits, 1);
});

test("successful duplicate delivery cannot sign a second transaction", async () => {
  const { ingress, service, client } = setup();
  const envelope = resolveEnvelope();
  await ingress.accept(envelope);
  await service.process(message(envelope.operationId), 1);
  client.receipt = finalizedReceipt(envelope);
  client.finalState = resolvePassState();
  await service.process(message(envelope.operationId), 2);
  await service.process(message(envelope.operationId), 3);
  assert.equal(client.submitCalls, 1);
});

test("unknown jobs and tampered durable envelopes are poisoned before signing", async () => {
  const { repository, ingress, service, client } = setup();
  const envelope = resolveEnvelope();
  await assert.rejects(service.process(message(envelope.operationId), 1), PoisonMessageError);
  await ingress.accept(envelope);
  const current = repository.records.get(envelope.operationId)!;
  repository.patchForTest(envelope.operationId, {
    envelope: Object.freeze({ ...envelope, valueAtto: "1" as "0" }),
  });
  await assert.rejects(service.process(message(envelope.operationId), 1), PoisonMessageError);
  assert.equal(repository.records.get(envelope.operationId)?.status, "POISONED");
  assert.equal(client.submitCalls, 0);
  assert.ok(current);
});

test("wrong contract binding and wrong contract identity both fail without signing", async () => {
  const first = setup();
  const envelope = resolveEnvelope();
  await first.ingress.accept(envelope);
  first.client.contractAddress = `0x${"99".repeat(20)}`;
  await assert.rejects(first.service.process(message(envelope.operationId), 1), PoisonMessageError);
  assert.equal(first.client.submitCalls, 0);

  const second = setup();
  await second.ingress.accept(envelope);
  second.client.readError = new Error("MARKETPLACE_CONTRACT_IDENTITY_MISMATCH");
  await second.service.process(message(envelope.operationId), 1);
  assert.equal(second.repository.records.get(envelope.operationId)?.status, "PRECHECK_FAILED");
  assert.equal(second.client.submitCalls, 0);
});

test("wrong or premature contract state fails precheck without signing", async () => {
  const { repository, ingress, service, client } = setup();
  const envelope = resolveEnvelope();
  await ingress.accept(envelope);
  client.preState = {
    ...resolvePreState(),
    assignment: { ...resolvePreState().assignment, status: "ACCEPTED" },
  };
  await service.process(message(envelope.operationId), 1);
  assert.equal(repository.records.get(envelope.operationId)?.status, "PRECHECK_FAILED");
  assert.equal(repository.records.get(envelope.operationId)?.errorCode, "PRE_STATE_ASSIGNMENT_NOT_RESOLVABLE");
  assert.equal(client.submitCalls, 0);
});

test("replaying a precheck failure publishes a fresh queue generation", async () => {
  const { repository, ingress, service, client, queue } = setup();
  const envelope = resolveEnvelope();
  await ingress.accept(envelope);
  client.preState = {
    ...resolvePreState(),
    assignment: { ...resolvePreState().assignment, status: "ACCEPTED" },
  };
  await service.process(message(envelope.operationId), 1);
  assert.equal(repository.records.get(envelope.operationId)?.status, "PRECHECK_FAILED");

  await ingress.accept(envelope);
  assert.deepEqual(queue.submits, [
    { operationId: envelope.operationId, generation: 1 },
    { operationId: envelope.operationId, generation: 2 },
  ]);
});

test("transport ambiguity quarantines the operation and permanently fences the signer", async () => {
  const { repository, ingress, service, client } = setup();
  const envelope = resolveEnvelope();
  await ingress.accept(envelope);
  client.submitError = new Error("connection closed after acceptance");
  await service.process(message(envelope.operationId), 1);
  assert.equal(repository.records.get(envelope.operationId)?.status, "RECONCILIATION_REQUIRED");
  await service.process(message(envelope.operationId), 2);
  assert.equal(client.submitCalls, 1);

  const second = expireEnvelope();
  await ingress.accept(second);
  await assert.rejects(service.process(message(second.operationId), 1), GateBusyError);
});

test("a crash after broadcast but before hash persistence is quarantined on redelivery", async () => {
  const { repository, ingress, service, client } = setup();
  const envelope = resolveEnvelope();
  await ingress.accept(envelope);
  repository.failRecordSubmitted = true;
  await assert.rejects(service.process(message(envelope.operationId), 1), /simulated database crash/);
  assert.equal(repository.records.get(envelope.operationId)?.status, "BROADCASTING");
  await service.process(message(envelope.operationId), 2);
  assert.equal(repository.records.get(envelope.operationId)?.status, "RECONCILIATION_REQUIRED");
  assert.equal(client.submitCalls, 1);
});

test("FINALIZED is accepted only with nested StudioNet success, return status, and matching post-state", async () => {
  const { repository, ingress, service, client } = setup();
  const envelope = resolveEnvelope();
  await ingress.accept(envelope);
  await service.process(message(envelope.operationId), 1);
  client.receipt = finalizedReceipt(envelope);
  client.finalState = resolvePassState();
  await service.process(message(envelope.operationId), 2);
  const record = repository.records.get(envelope.operationId);
  assert.equal(record?.status, "FINALIZED");
  assert.equal(record?.executionResult, "FINISHED_WITH_RETURN");
  assert.ok(record?.postStateFingerprint);
});

test("a finalized resolution parent is polled until its ordered child messages settle", async () => {
  const { repository, ingress, service, client, queue } = setup();
  const envelope = resolveEnvelope();
  await ingress.accept(envelope);
  await service.process(message(envelope.operationId), 1);
  client.receipt = finalizedReceipt(envelope);
  client.finalState = resolvePendingState();

  await service.process(message(envelope.operationId), 2);
  const pending = repository.records.get(envelope.operationId);
  assert.equal(pending?.status, "POLLING");
  assert.equal(pending?.errorCode, "RESOLUTION_CHILD_PENDING");
  assert.deepEqual(queue.polls, [
    { operationId: envelope.operationId, attempt: 0 },
    { operationId: envelope.operationId, attempt: 1 },
  ]);
  assert.equal(client.submitCalls, 1);

  client.finalState = resolvePassState();
  await service.process(message(envelope.operationId), 3);
  const settled = repository.records.get(envelope.operationId);
  assert.equal(settled?.status, "FINALIZED");
  assert.equal(settled?.errorCode, null);
  assert.ok(settled?.postStateFingerprint);
  assert.equal(client.submitCalls, 1);
});

test("absent or mismatched nested leader execution fails closed", async () => {
  for (const consensus_data of [
    undefined,
    { leader_receipt: [] },
    { leader_receipt: [{ mode: "leader", execution_result: "FAILED", result: { status: "return" } }] },
    { leader_receipt: [{ mode: "leader", execution_result: "SUCCESS", result: { status: "revert" } }] },
    { leader_receipt: [
      { mode: "leader", execution_result: "SUCCESS", result: { status: "return" } },
      { mode: "leader", execution_result: "SUCCESS", result: { status: "return" } },
    ] },
  ]) {
    const { repository, ingress, service, client } = setup();
    const envelope = resolveEnvelope();
    await ingress.accept(envelope);
    await service.process(message(envelope.operationId), 1);
    client.receipt = finalizedReceipt(envelope, { consensus_data });
    await service.process(message(envelope.operationId), 2);
    assert.equal(repository.records.get(envelope.operationId)?.status, "EXECUTION_FAILED");
  }
});

test("finality also requires MAJORITY_AGREE", async () => {
  const { repository, ingress, service, client } = setup();
  const envelope = resolveEnvelope();
  await ingress.accept(envelope);
  await service.process(message(envelope.operationId), 1);
  client.receipt = finalizedReceipt(envelope, { result_name: "MINORITY_DISAGREE" });
  await service.process(message(envelope.operationId), 2);
  assert.equal(repository.records.get(envelope.operationId)?.status, "EXECUTION_FAILED");
});

test("a successful receipt with the wrong post-state is quarantined", async () => {
  const { repository, ingress, service, client } = setup();
  const envelope = resolveEnvelope();
  await ingress.accept(envelope);
  await service.process(message(envelope.operationId), 1);
  client.receipt = finalizedReceipt(envelope);
  client.finalState = resolvePreState();
  await service.process(message(envelope.operationId), 2);
  assert.equal(repository.records.get(envelope.operationId)?.status, "RECONCILIATION_REQUIRED");
});

test("receipt binding rejects the wrong sender, contract, method, args, value, or hash", () => {
  const envelope = resolveEnvelope();
  const record = {
    txHash: TX_HASH,
    contractAddress: CONTRACT,
    functionName: envelope.action,
    callFingerprint: "unused",
    envelope,
  };
  // Use the actual call fingerprint from the durable record shape.
  const bound = { ...record, callFingerprint: callFingerprint(envelope) };
  assert.equal(transactionBindingError(finalizedReceipt(envelope), bound, SIGNER), null);
  for (const [patch, expected] of [
    [{ hash: `0x${"00".repeat(32)}` }, "TRANSACTION_HASH_MISMATCH"],
    [{ sender: `0x${"00".repeat(20)}` }, "TRANSACTION_SENDER_MISMATCH"],
    [{ recipient: `0x${"00".repeat(20)}` }, "TRANSACTION_CONTRACT_MISMATCH"],
    [{ rawValueAtto: "1" }, "TRANSACTION_VALUE_MISMATCH"],
    [{ tx_data_decoded: { call_data: { method: "request_withdrawal", args: envelope.args } } }, "TRANSACTION_METHOD_MISMATCH"],
    [{ tx_data_decoded: { call_data: { method: envelope.action, args: [] } } }, "TRANSACTION_ARGUMENTS_MISMATCH"],
  ] as const) {
    assert.equal(transactionBindingError(finalizedReceipt(envelope, patch), bound, SIGNER), expected);
  }
});

test("live snake_case tx_data without a 0x prefix is decoded and bound exactly", () => {
  const envelope = validateOperationRequest({
    schemaVersion: 1,
    action: "resolve_assignment",
    assignmentId: `0x${"11".repeat(32)}`,
    requestId: `0x${"22".repeat(32)}`,
  }, configFixture());
  // Captured StudioNet shape: raw app-data RLP in snake_case, with the RPC's
  // leading 0x removed. The contents were produced by the GenLayer ABI codec.
  const txData = "f8adb8aa1604617267731594043078313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131319404307832323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232066d6574686f6494017265736f6c76655f61737369676e6d656e7400";
  const record = {
    txHash: TX_HASH,
    contractAddress: CONTRACT,
    functionName: envelope.action,
    callFingerprint: callFingerprint(envelope),
    envelope,
  };
  const receipt = finalizedReceipt(envelope, {
    tx_data_decoded: undefined,
    tx_data: txData,
  });
  assert.equal(transactionBindingError(receipt, record, SIGNER), null);
  assert.equal(transactionBindingError({ ...receipt, tx_data: `0x${txData}` }, record, SIGNER), null);
});
