import assert from 'node:assert/strict';
import test from 'node:test';

import { OwnershipSubmissionCoordinator } from '../../services/bradbury-submitter/src/coordinator.mjs';
import { PINNED_BRADBURY_RESOLVER } from '../../services/bradbury-submitter/src/constants.mjs';
import {
  MemoryStore,
  NOW_EPOCH,
  NOW_MS,
  TX_HASH,
  finalizedReceipt,
  makeEnvelope,
  ownershipResult,
} from './helpers.mjs';

function fakeClient(overrides = {}) {
  const calls = { precheck: 0, submit: 0, poll: 0, readFinal: 0 };
  return {
    calls,
    async readExistingResult() {
      calls.precheck += 1;
      return null;
    },
    async submitOwnership() {
      calls.submit += 1;
      return TX_HASH;
    },
    async getTransaction(requestId) {
      calls.poll += 1;
      return finalizedReceipt(requestId);
    },
    async readFinalResult(requestId) {
      calls.readFinal += 1;
      return ownershipResult(requestId);
    },
    ...overrides,
  };
}

function coordinator(store, client, overrides = {}) {
  return new OwnershipSubmissionCoordinator({
    store,
    client,
    now: () => NOW_MS,
    pollIntervalMs: 30_000,
    ...overrides,
  });
}

test('submits the fixed ownership call once and schedules polling', async () => {
  const store = new MemoryStore();
  const client = fakeClient();
  const envelope = await makeEnvelope();
  const first = await coordinator(store, client).submit(envelope);
  assert.equal(first.replayed, false);
  assert.equal(first.submission.status, 'SUBMITTED');
  assert.equal(first.submission.txHash, TX_HASH);
  assert.equal(first.submission.functionName, 'verify_ownership');
  assert.equal(first.submission.resolver, PINNED_BRADBURY_RESOLVER);
  assert.equal(client.calls.precheck, 1);
  assert.equal(client.calls.submit, 1);
  assert.deepEqual(store.alarms, [
    NOW_MS + 30_000,
    NOW_MS + 30_000,
    NOW_MS + 30_000,
  ]);
});

test('replays the persisted submission without broadcasting twice', async () => {
  const store = new MemoryStore();
  const client = fakeClient();
  const envelope = await makeEnvelope();
  const service = coordinator(store, client);
  await service.submit(envelope);
  const replay = await service.submit(envelope);
  assert.equal(replay.replayed, true);
  assert.equal(replay.submission.txHash, TX_HASH);
  assert.equal(client.calls.submit, 1);
});

test('quarantines an already-resolved request instead of broadcasting it', async () => {
  const store = new MemoryStore();
  const envelope = await makeEnvelope();
  const client = fakeClient({
    async readExistingResult() {
      this.calls.precheck += 1;
      return ownershipResult(envelope.requestId, 'REJECTED');
    },
  });
  const result = await coordinator(store, client).submit(envelope);
  assert.equal(result.submission.status, 'RECONCILIATION_REQUIRED');
  assert.equal(result.submission.errorCode, 'RESULT_EXISTS_WITHOUT_LOCAL_TRANSACTION');
  assert.equal(client.calls.submit, 0);
});

test('does not broadcast when the Bradbury duplicate precheck is unavailable', async () => {
  const store = new MemoryStore();
  const client = fakeClient({
    async readExistingResult() {
      this.calls.precheck += 1;
      throw new Error('rpc unavailable');
    },
  });
  await assert.rejects(
    coordinator(store, client).submit(await makeEnvelope()),
    (error) => error.code === 'BRADBURY_PRECHECK_UNAVAILABLE',
  );
  assert.equal(store.record.status, 'PRECHECK_FAILED');
  assert.equal(client.calls.submit, 0);
});

test('a watchdog makes an interrupted precheck retryable without broadcasting', async () => {
  const store = new MemoryStore();
  const envelope = await makeEnvelope();
  store.record = {
    schemaVersion: 1,
    requestId: envelope.requestId,
    network: 'testnet-bradbury',
    resolver: PINNED_BRADBURY_RESOLVER,
    functionName: 'verify_ownership',
    status: 'PRECHECKING',
    txHash: null,
    pollAttempts: 0,
    createdAt: NOW_MS,
    updatedAt: NOW_MS,
  };
  const status = await coordinator(store, fakeClient()).poll();
  assert.equal(status.status, 'PRECHECK_FAILED');
  assert.equal(status.errorCode, 'PRECHECK_INTERRUPTED');
});

test('quarantines an ambiguous broadcast and never retries it automatically', async () => {
  const store = new MemoryStore();
  const client = fakeClient({
    async submitOwnership() {
      this.calls.submit += 1;
      throw new Error('connection closed');
    },
  });
  const envelope = await makeEnvelope();
  await assert.rejects(
    coordinator(store, client).submit(envelope),
    (error) => error.code === 'BROADCAST_OUTCOME_UNKNOWN',
  );
  assert.equal(store.record.status, 'RECONCILIATION_REQUIRED');
  const replay = await coordinator(store, client).submit(envelope);
  assert.equal(replay.submission.status, 'RECONCILIATION_REQUIRED');
  assert.equal(client.calls.submit, 1);
});

test('polls a transaction through FINALIZED and verifies the resolver result', async () => {
  const store = new MemoryStore();
  const envelope = await makeEnvelope();
  const client = fakeClient({
    async getTransaction() {
      this.calls.poll += 1;
      return finalizedReceipt(envelope);
    },
  });
  const service = coordinator(store, client);
  await service.submit(envelope);
  const final = await service.poll();
  assert.equal(final.status, 'FINALIZED');
  assert.equal(final.lifecycleStatus, 'FINALIZED');
  assert.equal(final.executionResult, 'FINISHED_WITH_RETURN');
  assert.equal(final.resultOutcome, 'VERIFIED');
  assert.equal(client.calls.readFinal, 1);
});

test('FINALIZED lifecycle with execution error is not treated as success', async () => {
  const store = new MemoryStore();
  const envelope = await makeEnvelope();
  const client = fakeClient({
    async getTransaction() {
      this.calls.poll += 1;
      return finalizedReceipt(envelope, {
        txExecutionResultName: 'FINISHED_WITH_ERROR',
      });
    },
  });
  const service = coordinator(store, client);
  await service.submit(envelope);
  const final = await service.poll();
  assert.equal(final.status, 'EXECUTION_FAILED');
  assert.equal(final.errorCode, 'GENLAYER_EXECUTION_FAILED');
  assert.equal(client.calls.readFinal, 0);
});

test('quarantines a receipt targeting another resolver or request', async () => {
  const store = new MemoryStore();
  const envelope = await makeEnvelope();
  const client = fakeClient({
    async getTransaction() {
      this.calls.poll += 1;
      return finalizedReceipt(envelope, { recipient: `0x${'34'.repeat(20)}` });
    },
  });
  const service = coordinator(store, client);
  await service.submit(envelope);
  const status = await service.poll();
  assert.equal(status.status, 'RECONCILIATION_REQUIRED');
  assert.equal(status.errorCode, 'TRANSACTION_RESOLVER_MISMATCH');
});

test('quarantines finalized receipts with missing or incomplete decoded call data', async () => {
  const envelope = await makeEnvelope();
  for (const [receipt, expectedCode] of [
    [{
      statusName: 'FINALIZED',
      txExecutionResultName: 'FINISHED_WITH_RETURN',
      txDataDecoded: { callData: { method: 'verify_ownership', args: [] } },
    }, 'TRANSACTION_RESOLVER_MISSING'],
    [finalizedReceipt(envelope, { txDataDecoded: { callData: { args: [] } } }), 'TRANSACTION_METHOD_MISSING'],
    [finalizedReceipt(envelope, { txDataDecoded: { callData: { method: 'verify_ownership' } } }), 'TRANSACTION_ARGUMENTS_MISSING'],
    [finalizedReceipt(envelope, { txDataDecoded: { callData: { method: 'verify_ownership', args: [envelope.requestId] } } }), 'TRANSACTION_ARGUMENTS_INVALID'],
  ]) {
    const store = new MemoryStore();
    const client = fakeClient({ async getTransaction() { return receipt; } });
    const service = coordinator(store, client);
    await service.submit(envelope);
    const status = await service.poll();
    assert.equal(status.status, 'RECONCILIATION_REQUIRED');
    assert.equal(status.errorCode, expectedCode);
  }
});

test('quarantines a receipt whose decoded APV2 arguments differ from the submitted envelope', async () => {
  const store = new MemoryStore();
  const envelope = await makeEnvelope();
  const receipt = finalizedReceipt(envelope);
  receipt.txDataDecoded.callData.args[4] = `APV2-${'z'.repeat(24)}`;
  const client = fakeClient({ async getTransaction() { return receipt; } });
  const service = coordinator(store, client);
  await service.submit(envelope);
  const status = await service.poll();
  assert.equal(status.status, 'RECONCILIATION_REQUIRED');
  assert.equal(status.errorCode, 'TRANSACTION_ARGUMENTS_MISMATCH');
});

test('transient polling failures keep the same transaction and reschedule', async () => {
  const store = new MemoryStore();
  const client = fakeClient({
    async getTransaction() {
      this.calls.poll += 1;
      throw new Error('temporary rpc failure');
    },
  });
  const service = coordinator(store, client);
  await service.submit(await makeEnvelope());
  const status = await service.poll();
  assert.equal(status.status, 'SUBMITTED');
  assert.equal(status.txHash, TX_HASH);
  assert.equal(status.errorCode, 'BRADBURY_POLL_UNAVAILABLE');
  assert.equal(store.alarms.length, 4);
});

test('polling exhaustion is terminal and cannot trigger resubmission', async () => {
  const store = new MemoryStore();
  const client = fakeClient();
  const envelope = await makeEnvelope();
  const service = coordinator(store, client, { maxPollAttempts: 0 });
  await service.submit(envelope);
  const exhausted = await service.poll();
  assert.equal(exhausted.status, 'POLLING_EXHAUSTED');
  const replay = await service.submit(envelope);
  assert.equal(replay.submission.status, 'POLLING_EXHAUSTED');
  assert.equal(client.calls.submit, 1);
});
