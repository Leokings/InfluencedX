import pg, { type PoolClient } from "pg";

import {
  PINNED_STUDIONET_RESOLVER,
  PRECHECK_LEASE_MS,
  SIGNER_GATE,
  SUBMITTER_NETWORK,
} from "./constants";
import { submissionFunctionName } from "./envelope";
import { SubmitterProblem } from "./problem";
import type {
  PollPatch,
  ResolverOutcome,
  SignerClaim,
  SubmissionProjection,
  SubmissionRecord,
  SubmissionRepository,
  SubmissionEnvelope,
} from "./types";

const pools = new Map<string, pg.Pool>();

export function repositoryFor(databaseUrl: string): PostgresSubmissionRepository {
  let pool = pools.get(databaseUrl);
  if (!pool) {
    pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 4,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });
    pools.set(databaseUrl, pool);
  }
  return new PostgresSubmissionRepository(pool);
}

/** Operator/test cleanup only. Request handlers intentionally keep pools warm. */
export async function closeRepositoryPools(): Promise<void> {
  const active = [...pools.values()];
  pools.clear();
  await Promise.all(active.map((pool) => pool.end()));
}

export class PostgresSubmissionRepository implements SubmissionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async createOrReplay(
    envelope: SubmissionEnvelope,
    envelopeFingerprint: string,
    callFingerprint: string,
  ): Promise<{ record: SubmissionRecord; replayed: boolean }> {
    const functionName = submissionFunctionName(envelope);
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO xproof_bradbury_submission_status
           (request_id, status, network, resolver, function_name)
         VALUES ($1, 'QUEUED', $2, $3, $4)
         ON CONFLICT (request_id) DO NOTHING`,
        [envelope.requestId, SUBMITTER_NETWORK, PINNED_STUDIONET_RESOLVER.toLowerCase(), functionName],
      );
      await client.query(
        `INSERT INTO xproof_bradbury_submission_jobs
           (request_id, schema_version, envelope_json, envelope_fingerprint, call_fingerprint)
         VALUES ($1, 1, $2::jsonb, $3, $4)
         ON CONFLICT (request_id) DO NOTHING`,
        [envelope.requestId, JSON.stringify(envelope), envelopeFingerprint, callFingerprint],
      );
      const record = await this.getWith(client, envelope.requestId, true);
      if (!record) throw storageError();
      if (record.envelopeFingerprint !== envelopeFingerprint || record.callFingerprint !== callFingerprint) {
        throw new SubmitterProblem(409, "REQUEST_ID_COLLISION", "The request ID is already bound to a different submitter envelope.");
      }
      return { record, replayed: inserted.rowCount === 0 };
    });
  }

  async recordQueueAccepted(requestId: string, messageId: string | null): Promise<SubmissionRecord> {
    await this.pool.query(
      `UPDATE xproof_bradbury_submission_status
       SET queue_message_id = COALESCE(queue_message_id, $2),
           enqueue_attempts = enqueue_attempts + 1,
           updated_at = clock_timestamp()
       WHERE request_id = $1`,
      [requestId, messageId],
    );
    return this.requireRecord(requestId);
  }

  get(requestId: string): Promise<SubmissionRecord | null> {
    return this.getWith(this.pool, requestId, false);
  }

  async getProjection(requestId: string): Promise<SubmissionProjection | null> {
    const result = await this.pool.query(`${STATUS_SELECT} WHERE request_id = $1`, [requestId]);
    return result.rowCount ? mapProjection(result.rows[0]) : null;
  }

  async claimPrecheck(requestId: string, holderId: string, leaseMs: number): Promise<SignerClaim | null> {
    if (leaseMs !== PRECHECK_LEASE_MS) {
      throw new SubmitterProblem(500, "PRECHECK_LEASE_INVALID", "The signer precheck lease must use the pinned duration.");
    }
    return this.transaction(async (client) => {
      const status = await client.query(
        `SELECT status FROM xproof_bradbury_submission_status WHERE request_id = $1 FOR UPDATE`,
        [requestId],
      );
      if (!status.rowCount || !["QUEUED", "PRECHECKING", "PRECHECK_FAILED"].includes(status.rows[0].status)) return null;

      const gate = await client.query(
        `SELECT fencing_token, holder_id, active_request_id, phase, lease_expires_at,
                (phase = 'PRECHECKING' AND lease_expires_at <= clock_timestamp()) AS precheck_expired
         FROM xproof_bradbury_signer_gate WHERE gate_name = $1 FOR UPDATE`,
        [SIGNER_GATE],
      );
      if (!gate.rowCount) throw storageError();
      const current = gate.rows[0];
      const isFree = current.active_request_id === null;
      const expiredPrecheck = current.precheck_expired === true;
      if (!isFree && !expiredPrecheck) return null;

      const nextToken = BigInt(current.fencing_token) + 1n;
      await client.query(
        `UPDATE xproof_bradbury_signer_gate
         SET fencing_token = $2, holder_id = $3::uuid, active_request_id = $4,
             phase = 'PRECHECKING', lease_expires_at = clock_timestamp() + interval '2 minutes',
             acquired_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE gate_name = $1`,
        [SIGNER_GATE, nextToken.toString(), holderId, requestId],
      );
      await client.query(
        `UPDATE xproof_bradbury_submission_status
         SET status = 'PRECHECKING', error_code = NULL, updated_at = clock_timestamp()
         WHERE request_id = $1`,
        [requestId],
      );
      return Object.freeze({ requestId, holderId, fencingToken: nextToken });
    });
  }

  async failPrecheck(claim: SignerClaim, errorCode: string): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertClaim(client, claim, "PRECHECKING");
      await client.query(
        `UPDATE xproof_bradbury_submission_status
         SET status = 'PRECHECK_FAILED', error_code = $2, updated_at = clock_timestamp()
         WHERE request_id = $1`,
        [claim.requestId, errorCode],
      );
      await this.releaseGate(client, claim);
    });
  }

  async beginBroadcast(claim: SignerClaim): Promise<boolean> {
    return this.transaction(async (client) => {
      const valid = await this.hasClaim(client, claim, "PRECHECKING");
      if (!valid) return false;
      const status = await client.query(
        `UPDATE xproof_bradbury_submission_status
         SET status = 'BROADCASTING', broadcast_started_at = clock_timestamp(),
             error_code = NULL, updated_at = clock_timestamp()
         WHERE request_id = $1 AND status = 'PRECHECKING'`,
        [claim.requestId],
      );
      if (!status.rowCount) return false;
      await client.query(
        `UPDATE xproof_bradbury_signer_gate
         SET phase = 'BROADCASTING', lease_expires_at = NULL, updated_at = clock_timestamp()
         WHERE gate_name = $1 AND holder_id = $2::uuid AND fencing_token = $3 AND active_request_id = $4`,
        [SIGNER_GATE, claim.holderId, claim.fencingToken.toString(), claim.requestId],
      );
      return true;
    });
  }

  async recordSubmitted(claim: SignerClaim, txHash: string): Promise<SubmissionRecord> {
    return this.transaction(async (client) => {
      await this.assertClaim(client, claim, "BROADCASTING");
      const updated = await client.query(
        `UPDATE xproof_bradbury_submission_status
         SET status = 'SUBMITTED', tx_hash = $2, submitted_at = clock_timestamp(),
             poll_attempts = 0, error_code = NULL, updated_at = clock_timestamp()
         WHERE request_id = $1 AND status = 'BROADCASTING'
         RETURNING *`,
        [claim.requestId, txHash],
      );
      if (!updated.rowCount) throw storageError();
      await this.purgeEnvelope(client, claim.requestId);
      await this.releaseGate(client, claim);
      const record = await this.getWith(client, claim.requestId, true);
      if (!record) throw storageError();
      return record;
    });
  }

  quarantineBroadcast(claim: SignerClaim, errorCode: string): Promise<SubmissionRecord> {
    return this.quarantine(claim, errorCode, null, "BROADCASTING");
  }

  quarantineWithoutBroadcast(
    requestId: string,
    claim: SignerClaim,
    errorCode: string,
    resultOutcome: ResolverOutcome | null = null,
  ): Promise<SubmissionRecord> {
    if (requestId !== claim.requestId) throw storageError();
    return this.quarantine(claim, errorCode, resultOutcome, "PRECHECKING");
  }

  async recordPoll(requestId: string, patch: PollPatch): Promise<SubmissionRecord> {
    return this.transaction(async (client) => {
      const current = await this.getWith(client, requestId, true);
      if (!current) throw new SubmitterProblem(404, "SUBMISSION_NOT_FOUND", "Submission not found.");
      if (!["SUBMITTED", "POLLING"].includes(current.status)) return current;
      const next = {
        status: patch.status ?? current.status,
        lifecycleStatus: patch.lifecycleStatus === undefined ? current.lifecycleStatus : patch.lifecycleStatus,
        executionResult: patch.executionResult === undefined ? current.executionResult : patch.executionResult,
        resultOutcome: patch.resultOutcome === undefined ? current.resultOutcome : patch.resultOutcome,
        resultData: patch.resultData === undefined ? current.resultData : patch.resultData,
        pollAttempts: patch.pollAttempts ?? current.pollAttempts,
        errorCode: patch.errorCode === undefined ? current.errorCode : patch.errorCode,
        lastPolledAt: patch.lastPolledAt === undefined ? current.lastPolledAt : patch.lastPolledAt,
        finalizedAt: patch.finalizedAt === undefined ? current.finalizedAt : patch.finalizedAt,
      };
      await client.query(
        `UPDATE xproof_bradbury_submission_status
         SET status = $2, lifecycle_status = $3, execution_result = $4,
             result_outcome = $5, result_json = $6::jsonb, poll_attempts = $7, error_code = $8,
             last_polled_at = $9, finalized_at = $10, updated_at = clock_timestamp()
         WHERE request_id = $1 AND status IN ('SUBMITTED', 'POLLING')`,
        [requestId, next.status, next.lifecycleStatus, next.executionResult, next.resultOutcome,
          next.resultData === null ? null : JSON.stringify(next.resultData), next.pollAttempts,
          next.errorCode, next.lastPolledAt, next.finalizedAt],
      );
      const updated = await this.getWith(client, requestId, true);
      if (!updated) throw storageError();
      return updated;
    });
  }

  async markPoisoned(requestId: string, errorCode: string): Promise<void> {
    await this.pool.query(
      `UPDATE xproof_bradbury_submission_status
       SET status = 'POISONED', error_code = $2, updated_at = clock_timestamp()
       WHERE request_id = $1 AND status IN ('QUEUED', 'PRECHECK_FAILED')`,
      [requestId, errorCode],
    );
    await this.pool.query(
      `UPDATE xproof_bradbury_submission_jobs SET envelope_json = NULL, updated_at = clock_timestamp()
       WHERE request_id = $1
         AND EXISTS (SELECT 1 FROM xproof_bradbury_submission_status s WHERE s.request_id = $1 AND s.status = 'POISONED')`,
      [requestId],
    );
  }

  async noteDelivery(requestId: string, deliveryCount: number): Promise<void> {
    await this.pool.query(
      `UPDATE xproof_bradbury_submission_status
       SET delivery_count = GREATEST(delivery_count, $2), updated_at = clock_timestamp()
       WHERE request_id = $1`,
      [requestId, deliveryCount],
    );
  }

  private async quarantine(
    claim: SignerClaim,
    errorCode: string,
    resultOutcome: ResolverOutcome | null,
    expectedPhase: "PRECHECKING" | "BROADCASTING",
  ): Promise<SubmissionRecord> {
    return this.transaction(async (client) => {
      await this.assertClaim(client, claim, expectedPhase);
      await client.query(
        `UPDATE xproof_bradbury_submission_status
         SET status = 'RECONCILIATION_REQUIRED', error_code = $2,
             result_outcome = COALESCE($3, result_outcome), updated_at = clock_timestamp()
         WHERE request_id = $1`,
        [claim.requestId, errorCode, resultOutcome],
      );
      await this.purgeEnvelope(client, claim.requestId);
      if (expectedPhase === "PRECHECKING") {
        await this.releaseGate(client, claim);
      }
      // A BROADCASTING failure is intentionally different: the RPC may have
      // accepted the transaction before the caller observed an error. Keep the
      // account-wide gate non-expiring until an operator reconciles the signer.
      const record = await this.getWith(client, claim.requestId, true);
      if (!record) throw storageError();
      return record;
    });
  }

  private async purgeEnvelope(client: PoolClient, requestId: string): Promise<void> {
    await client.query(
      `UPDATE xproof_bradbury_submission_jobs
       SET envelope_json = NULL, updated_at = clock_timestamp()
       WHERE request_id = $1`,
      [requestId],
    );
  }

  private async releaseGate(client: PoolClient, claim: SignerClaim): Promise<void> {
    const result = await client.query(
      `UPDATE xproof_bradbury_signer_gate
       SET holder_id = NULL, active_request_id = NULL, phase = NULL,
           lease_expires_at = NULL, acquired_at = NULL, updated_at = clock_timestamp()
       WHERE gate_name = $1 AND holder_id = $2::uuid AND fencing_token = $3 AND active_request_id = $4`,
      [SIGNER_GATE, claim.holderId, claim.fencingToken.toString(), claim.requestId],
    );
    if (!result.rowCount) throw storageError();
  }

  private async hasClaim(client: PoolClient, claim: SignerClaim, phase: string): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM xproof_bradbury_signer_gate
       WHERE gate_name = $1 AND holder_id = $2::uuid AND fencing_token = $3
         AND active_request_id = $4 AND phase = $5 FOR UPDATE`,
      [SIGNER_GATE, claim.holderId, claim.fencingToken.toString(), claim.requestId, phase],
    );
    return Boolean(result.rowCount);
  }

  private async assertClaim(client: PoolClient, claim: SignerClaim, phase: string): Promise<void> {
    if (!(await this.hasClaim(client, claim, phase))) {
      throw new SubmitterProblem(503, "SIGNER_FENCE_LOST", "The signer fencing claim is no longer valid.");
    }
  }

  private async requireRecord(requestId: string): Promise<SubmissionRecord> {
    const record = await this.get(requestId);
    if (!record) throw new SubmitterProblem(404, "SUBMISSION_NOT_FOUND", "Submission not found.");
    return record;
  }

  private async getWith(
    queryable: Pick<pg.Pool, "query"> | Pick<PoolClient, "query">,
    requestId: string,
    forUpdate: boolean,
  ): Promise<SubmissionRecord | null> {
    const result = await queryable.query(
      `${RECORD_SELECT} WHERE s.request_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [requestId],
    );
    return result.rowCount ? mapRecord(result.rows[0]) : null;
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

const STATUS_COLUMNS = `request_id, status, network, resolver, function_name,
  lifecycle_status, execution_result, result_outcome, result_json, tx_hash, queue_message_id,
  enqueue_attempts, delivery_count, poll_attempts, error_code,
  broadcast_started_at, submitted_at, last_polled_at, finalized_at, created_at, updated_at`;
const STATUS_SELECT = `SELECT ${STATUS_COLUMNS} FROM xproof_bradbury_submission_status`;
const RECORD_SELECT = `SELECT s.*,
  j.envelope_json, j.envelope_fingerprint, j.call_fingerprint
  FROM xproof_bradbury_submission_status s
  JOIN xproof_bradbury_submission_jobs j ON j.request_id = s.request_id`;

function mapRecord(row: Record<string, unknown>): SubmissionRecord {
  return Object.freeze({
    ...mapProjection(row),
    envelope: row.envelope_json ? Object.freeze(row.envelope_json as SubmissionEnvelope) : null,
    envelopeFingerprint: String(row.envelope_fingerprint),
    callFingerprint: String(row.call_fingerprint),
  });
}

function mapProjection(row: Record<string, unknown>): SubmissionProjection {
  return Object.freeze({
    requestId: String(row.request_id),
    network: String(row.network),
    resolver: String(row.resolver),
    functionName: row.function_name as SubmissionProjection["functionName"],
    status: row.status as SubmissionProjection["status"],
    lifecycleStatus: nullable(row.lifecycle_status),
    executionResult: nullable(row.execution_result),
    resultOutcome: row.result_outcome as SubmissionProjection["resultOutcome"],
    resultData: row.result_json
      ? Object.freeze(row.result_json as NonNullable<SubmissionProjection["resultData"]>)
      : null,
    txHash: nullable(row.tx_hash),
    queueMessageId: nullable(row.queue_message_id),
    enqueueAttempts: Number(row.enqueue_attempts),
    deliveryCount: Number(row.delivery_count),
    pollAttempts: Number(row.poll_attempts),
    errorCode: nullable(row.error_code),
    broadcastStartedAt: dateOrNull(row.broadcast_started_at),
    submittedAt: dateOrNull(row.submitted_at),
    lastPolledAt: dateOrNull(row.last_polled_at),
    finalizedAt: dateOrNull(row.finalized_at),
    createdAt: dateRequired(row.created_at),
    updatedAt: dateRequired(row.updated_at),
  });
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function dateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : dateRequired(value);
}

function dateRequired(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw storageError();
  return date;
}

function storageError(): SubmitterProblem {
  return new SubmitterProblem(503, "SUBMITTER_STORAGE_UNAVAILABLE", "The durable submitter store is unavailable.");
}
