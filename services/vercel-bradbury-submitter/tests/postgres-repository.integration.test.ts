import assert from "node:assert/strict";
import test from "node:test";

import { DataType, newDb } from "pg-mem";
import type pg from "pg";

import { envelopeFingerprint, submissionCallFingerprint } from "../lib/envelope";
import { PostgresSubmissionRepository } from "../lib/postgres-repository";
import type { SubmissionEnvelope } from "../lib/types";
import {
  makeCampaignEnvelope,
  makeEnvelope,
  makeMetricsEnvelope,
  metricsResult,
  TX_HASH,
} from "./helpers";

async function setup() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({ name: "clock_timestamp", returns: DataType.timestamptz, implementation: () => new Date() });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  await pool.query(`
    CREATE TABLE xproof_bradbury_submission_status (
      request_id text PRIMARY KEY,
      status text NOT NULL,
      network text NOT NULL,
      resolver text NOT NULL,
      function_name text NOT NULL,
      lifecycle_status text,
      execution_result text,
      result_outcome text,
      result_json jsonb,
      tx_hash text UNIQUE,
      queue_message_id text,
      enqueue_attempts integer NOT NULL DEFAULT 0,
      delivery_count integer NOT NULL DEFAULT 0,
      poll_attempts integer NOT NULL DEFAULT 0,
      error_code text,
      broadcast_started_at timestamptz,
      submitted_at timestamptz,
      last_polled_at timestamptz,
      finalized_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE xproof_bradbury_submission_jobs (
      request_id text PRIMARY KEY REFERENCES xproof_bradbury_submission_status(request_id),
      schema_version smallint NOT NULL,
      envelope_json jsonb,
      envelope_fingerprint text NOT NULL,
      call_fingerprint text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE xproof_bradbury_signer_gate (
      gate_name text PRIMARY KEY,
      fencing_token bigint NOT NULL DEFAULT 0,
      holder_id uuid,
      active_request_id text REFERENCES xproof_bradbury_submission_status(request_id),
      phase text,
      lease_expires_at timestamptz,
      acquired_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    INSERT INTO xproof_bradbury_signer_gate (gate_name) VALUES ('bradbury-signer-v1');
  `);
  return {
    pool,
    repository: new PostgresSubmissionRepository(pool as unknown as pg.Pool),
  };
}

async function create(
  repository: PostgresSubmissionRepository,
  envelope: SubmissionEnvelope = makeEnvelope(),
) {
  return repository.createOrReplay(envelope, envelopeFingerprint(envelope), submissionCallFingerprint(envelope));
}

test("Postgres repository persists a singleton signer claim and releases only a known-hash broadcast", async () => {
  const { pool, repository } = await setup();
  const first = makeEnvelope();
  const second = makeEnvelope({ baseWallet: `0x${"34".repeat(20)}`, challenge: `APV2-${"b".repeat(24)}` });
  await create(repository, first);
  await create(repository, second);

  const winner = await repository.claimPrecheck(first.requestId, "11111111-1111-4111-8111-111111111111", 120_000);
  assert.ok(winner);
  assert.equal(await repository.claimPrecheck(second.requestId, "22222222-2222-4222-8222-222222222222", 120_000), null);
  assert.equal(await repository.beginBroadcast(winner), true);
  await repository.recordSubmitted(winner, TX_HASH);

  const loserRequest = winner.requestId === first.requestId ? second.requestId : first.requestId;
  const next = await repository.claimPrecheck(loserRequest, "33333333-3333-4333-8333-333333333333", 120_000);
  assert.ok(next, "known-hash persistence must release the singleton gate");

  const purged = await pool.query("SELECT envelope_json FROM xproof_bradbury_submission_jobs WHERE request_id = $1", [winner.requestId]);
  assert.equal(purged.rows[0].envelope_json, null);
  await pool.end();
});

test("Postgres repository retains a non-expiring account-wide gate after ambiguous BROADCASTING", async () => {
  const { pool, repository } = await setup();
  const first = makeEnvelope();
  const second = makeEnvelope({ baseWallet: `0x${"56".repeat(20)}`, challenge: `APV2-${"c".repeat(24)}` });
  await create(repository, first);
  await create(repository, second);
  const claim = await repository.claimPrecheck(first.requestId, "44444444-4444-4444-8444-444444444444", 120_000);
  assert.ok(claim);
  assert.equal(await repository.beginBroadcast(claim), true);
  await repository.quarantineBroadcast(claim, "BROADCAST_OUTCOME_UNKNOWN");

  assert.equal(await repository.claimPrecheck(second.requestId, "55555555-5555-4555-8555-555555555555", 120_000), null);
  const gate = await pool.query("SELECT phase, active_request_id, lease_expires_at FROM xproof_bradbury_signer_gate");
  assert.equal(gate.rows[0].phase, "BROADCASTING");
  assert.equal(gate.rows[0].active_request_id, first.requestId);
  assert.equal(gate.rows[0].lease_expires_at, null);
  await pool.end();
});

test("Postgres status projection contains no private envelope", async () => {
  const { pool, repository } = await setup();
  const envelope = makeEnvelope();
  await create(repository, envelope);
  await repository.recordQueueAccepted(envelope.requestId, "msg_123");
  const projection = await repository.getProjection(envelope.requestId);
  assert.equal(projection?.requestId, envelope.requestId);
  assert.equal(projection?.queueMessageId, "msg_123");
  assert.equal("envelope" in (projection ?? {}), false);
  assert.equal("challenge" in (projection ?? {}), false);
  await pool.end();
});

test("Postgres repository persists a campaign as the fixed resolve_submission method", async () => {
  const { pool, repository } = await setup();
  const envelope = makeCampaignEnvelope();
  await create(repository, envelope);
  const record = await repository.get(envelope.requestId);
  const projection = await repository.getProjection(envelope.requestId);
  assert.equal(record?.functionName, "resolve_submission");
  assert.deepEqual(record?.envelope, envelope);
  assert.equal(projection?.functionName, "resolve_submission");
  assert.equal("envelope" in (projection ?? {}), false);
  await pool.end();
});

test("Postgres repository persists only the sanitized finalized metrics projection", async () => {
  const { pool, repository } = await setup();
  const envelope = makeMetricsEnvelope();
  await create(repository, envelope);
  const claim = await repository.claimPrecheck(
    envelope.requestId,
    "66666666-6666-4666-8666-666666666666",
    120_000,
  );
  assert.ok(claim);
  assert.equal(await repository.beginBroadcast(claim), true);
  await repository.recordSubmitted(claim, TX_HASH);
  const sanitized = metricsResult(envelope);
  await repository.recordPoll(envelope.requestId, {
    status: "FINALIZED",
    lifecycleStatus: "FINALIZED",
    executionResult: "FINISHED_WITH_RETURN",
    resultOutcome: "VERIFIED",
    resultData: sanitized,
    pollAttempts: 1,
    lastPolledAt: new Date(),
    finalizedAt: new Date(),
    errorCode: null,
  });
  const projection = await repository.getProjection(envelope.requestId);
  assert.equal(projection?.functionName, "snapshot_metrics");
  assert.deepEqual(projection?.resultData, sanitized);
  assert.equal("envelope" in (projection ?? {}), false);
  assert.equal("followers" in (projection ?? {}), false);
  const stored = await pool.query(
    "SELECT s.result_json, j.envelope_json FROM xproof_bradbury_submission_status s JOIN xproof_bradbury_submission_jobs j ON j.request_id = s.request_id WHERE s.request_id = $1",
    [envelope.requestId],
  );
  assert.deepEqual(stored.rows[0].result_json, sanitized);
  assert.equal(stored.rows[0].envelope_json, null);
  await pool.end();
});
