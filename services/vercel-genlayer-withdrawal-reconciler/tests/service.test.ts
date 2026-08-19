import assert from "node:assert/strict";
import test from "node:test";

import { ReconciliationIngressService } from "../lib/operation-ingress";
import { ReconciliationService } from "../lib/operation-service";
import { GateBusyError } from "../lib/problem";
import {
  configFixture,
  FakeClient,
  FakeQueue,
  MemoryRepository,
  NOW_EPOCH,
  request,
  transferProof,
  WITHDRAWAL_ID,
} from "./helpers";

const now = () => new Date(NOW_EPOCH * 1_000);
const message = () => ({ schemaVersion: 1 as const, withdrawalId: WITHDRAWAL_ID });

async function setup() {
  const repository = new MemoryRepository();
  await repository.seed();
  const client = new FakeClient();
  const queue = new FakeQueue();
  const service = new ReconciliationService(repository, client, queue, now);
  return { repository, client, queue, service };
}

test("ingress is idempotent and queues only the withdrawal ID", async () => {
  const repository = new MemoryRepository();
  const queue = new FakeQueue();
  const ingress = new ReconciliationIngressService(repository, queue, configFixture());
  const first = await ingress.accept(request());
  const second = await ingress.accept(request());
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(queue.submits, [
    { withdrawalId: WITHDRAWAL_ID, generation: 1 },
    { withdrawalId: WITHDRAWAL_ID, generation: 2 },
  ]);
});

test("pending withdrawals are monitored without touching the owner signer", async () => {
  const { repository, client, queue, service } = await setup();
  client.withdrawal = { ...client.withdrawal!, status: "PENDING", emittedAtEpoch: 0 };
  await service.process(message(), 1);
  assert.equal(repository.records.get(WITHDRAWAL_ID)?.status, "WAITING_FOR_EMISSION");
  assert.equal(client.submitCalls.length, 0);
  assert.deepEqual(queue.discoveries, [{ withdrawalId: WITHDRAWAL_ID, attempt: 1 }]);
});

test("a finalized parent-child proof produces only confirm_withdrawal then exact finalized state", async () => {
  const { repository, client, queue, service } = await setup();
  await service.process(message(), 1);
  assert.deepEqual(client.submitCalls, [{ withdrawalId: WITHDRAWAL_ID, evidenceHash: transferProof().evidenceHash }]);
  assert.equal(repository.records.get(WITHDRAWAL_ID)?.status, "SUBMITTED");
  assert.deepEqual(queue.polls, [{ withdrawalId: WITHDRAWAL_ID, attempt: 0 }]);
  await service.process(message(), 2);
  const record = repository.records.get(WITHDRAWAL_ID)!;
  assert.equal(record.status, "FINALIZED");
  assert.equal(record.transferParentTxHash, transferProof().parentTxHash);
  assert.equal(record.transferChildTxHash, transferProof().childTxHash);
  assert.equal(record.evidenceHash, transferProof().evidenceHash);
});

test("definitive or ambiguous transfer evidence is governance-only and never signs", async () => {
  for (const code of ["TRANSFER_CHILD_TERMINATED_AFTER_RECOVERY_DELAY", "TRANSFER_AMOUNT_MISMATCH"]) {
    const { repository, client, service } = await setup();
    client.discovery = { kind: "MANUAL", code };
    await service.process(message(), 1);
    assert.equal(repository.records.get(WITHDRAWAL_ID)?.status, "RECONCILIATION_REQUIRED");
    assert.equal(repository.records.get(WITHDRAWAL_ID)?.errorCode, code);
    assert.equal(client.submitCalls.length, 0);
  }
});

test("an unknown broadcast result is quarantined behind a permanent signer fence", async () => {
  const first = await setup();
  first.client.submitError = new Error("unknown broadcast");
  await first.service.process(message(), 1);
  assert.equal(first.repository.records.get(WITHDRAWAL_ID)?.status, "RECONCILIATION_REQUIRED");

  const otherId = `0x${"ab".repeat(32)}`;
  await first.repository.seed(request(otherId));
  const otherClient = new FakeClient();
  otherClient.withdrawal = { ...otherClient.withdrawal!, withdrawalId: otherId };
  otherClient.discovery = { kind: "PROVEN", proof: { ...transferProof(), withdrawalId: otherId } };
  const second = new ReconciliationService(first.repository, otherClient, first.queue, now);
  await assert.rejects(second.process({ schemaVersion: 1, withdrawalId: otherId }, 1), GateBusyError);
  assert.equal(otherClient.submitCalls.length, 0);
});

test("a crash after broadcast but before hash persistence is quarantined on redelivery", async () => {
  const { repository, service } = await setup();
  repository.failRecordSubmitted = true;
  await assert.rejects(service.process(message(), 1), /simulated database crash/);
  assert.equal(repository.records.get(WITHDRAWAL_ID)?.status, "BROADCASTING");
  await service.process(message(), 2);
  assert.equal(repository.records.get(WITHDRAWAL_ID)?.status, "RECONCILIATION_REQUIRED");
});

test("wrong confirmation receipt or accounting is never reported finalized", async () => {
  for (const mutate of [
    (client: FakeClient) => { client.receipt = { ...client.receipt, sender: client.withdrawal!.account }; },
    (client: FakeClient) => { client.afterCounts = { ...client.afterCounts, totalWithdrawnAtto: "99" }; },
  ]) {
    const { repository, client, service } = await setup();
    await service.process(message(), 1);
    mutate(client);
    await service.process(message(), 2);
    assert.equal(repository.records.get(WITHDRAWAL_ID)?.status, "RECONCILIATION_REQUIRED");
  }
});

test("an externally confirmed or restored withdrawal never causes another owner write", async () => {
  for (const status of ["CONFIRMED", "RESTORED_FAILED"] as const) {
    const { repository, client, service } = await setup();
    client.withdrawal = { ...client.withdrawal!, status };
    await service.process(message(), 1);
    assert.equal(repository.records.get(WITHDRAWAL_ID)?.status, "RECONCILIATION_REQUIRED");
    assert.equal(client.submitCalls.length, 0);
  }
});
