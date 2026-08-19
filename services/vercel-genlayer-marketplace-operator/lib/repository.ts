import pg, { type PoolClient } from "pg";

import { PRECHECK_LEASE_MS, SIGNER_GATE } from "./constants";
import { OperatorProblem } from "./problem";
import type {
  OperationEnvelope,
  OperationProjection,
  OperationRecord,
  OperatorRepository,
  PollPatch,
  SignerClaim,
  StateSnapshot,
} from "./types";

const pools = new Map<string, pg.Pool>();

export function repositoryFor(databaseUrl: string): PostgresOperatorRepository {
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
  return new PostgresOperatorRepository(pool);
}

export async function closeRepositoryPools(): Promise<void> {
  const active = [...pools.values()];
  pools.clear();
  await Promise.all(active.map((pool) => pool.end()));
}

export class PostgresOperatorRepository implements OperatorRepository {
  constructor(private readonly pool: pg.Pool) {}

  async createOrReplay(
    envelope: OperationEnvelope,
    envelopeFingerprint: string,
    callFingerprint: string,
  ): Promise<{ record: OperationRecord; replayed: boolean }> {
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO influencedx_marketplace_operator_status
           (operation_id, status, network, chain_id, contract_address, action, function_name, value_atto)
         VALUES ($1, 'QUEUED', $2, $3, $4, $5, $5, $6)
         ON CONFLICT (operation_id) DO NOTHING`,
        [
          envelope.operationId,
          envelope.network,
          envelope.chainId,
          envelope.contractAddress,
          envelope.action,
          envelope.valueAtto,
        ],
      );
      await client.query(
        `INSERT INTO influencedx_marketplace_operator_jobs
           (operation_id, schema_version, envelope_json, envelope_fingerprint, call_fingerprint)
         VALUES ($1, 1, $2::jsonb, $3, $4)
         ON CONFLICT (operation_id) DO NOTHING`,
        [envelope.operationId, JSON.stringify(envelope), envelopeFingerprint, callFingerprint],
      );
      const record = await this.getWith(client, envelope.operationId, true);
      if (!record) throw storageError();
      if (
        record.envelopeFingerprint !== envelopeFingerprint ||
        record.callFingerprint !== callFingerprint
      ) {
        throw new OperatorProblem(409, "OPERATION_ID_COLLISION", "The operation ID is already bound to another exact call.");
      }
      return { record, replayed: inserted.rowCount === 0 };
    });
  }

  async recordQueueAccepted(operationId: string, messageId: string | null): Promise<OperationRecord> {
    await this.pool.query(
      `UPDATE influencedx_marketplace_operator_status
       SET queue_message_id = COALESCE(queue_message_id, $2),
           enqueue_attempts = enqueue_attempts + 1,
           updated_at = clock_timestamp()
       WHERE operation_id = $1`,
      [operationId, messageId],
    );
    return this.requireRecord(operationId);
  }

  get(operationId: string): Promise<OperationRecord | null> {
    return this.getWith(this.pool, operationId, false);
  }

  async getProjection(operationId: string): Promise<OperationProjection | null> {
    const result = await this.pool.query(`${PROJECTION_SELECT} WHERE operation_id = $1`, [operationId]);
    return result.rowCount ? mapProjection(result.rows[0]) : null;
  }

  async claimPrecheck(operationId: string, holderId: string, leaseMs: number): Promise<SignerClaim | null> {
    if (leaseMs !== PRECHECK_LEASE_MS) throw storageError();
    return this.transaction(async (client) => {
      const status = await client.query(
        `SELECT status FROM influencedx_marketplace_operator_status WHERE operation_id = $1 FOR UPDATE`,
        [operationId],
      );
      if (!status.rowCount || !["QUEUED", "PRECHECKING", "PRECHECK_FAILED"].includes(status.rows[0].status)) return null;
      const gate = await client.query(
        `SELECT fencing_token, active_operation_id, phase,
                (phase = 'PRECHECKING' AND lease_expires_at <= clock_timestamp()) AS precheck_expired
         FROM influencedx_marketplace_operator_signer_gate WHERE gate_name = $1 FOR UPDATE`,
        [SIGNER_GATE],
      );
      if (!gate.rowCount) throw storageError();
      const current = gate.rows[0];
      if (current.active_operation_id !== null && current.precheck_expired !== true) return null;
      const token = BigInt(current.fencing_token) + 1n;
      await client.query(
        `UPDATE influencedx_marketplace_operator_signer_gate
         SET fencing_token = $2, holder_id = $3::uuid, active_operation_id = $4,
             phase = 'PRECHECKING', lease_expires_at = clock_timestamp() + interval '2 minutes',
             acquired_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE gate_name = $1`,
        [SIGNER_GATE, token.toString(), holderId, operationId],
      );
      await client.query(
        `UPDATE influencedx_marketplace_operator_status
         SET status = 'PRECHECKING', error_code = NULL, updated_at = clock_timestamp()
         WHERE operation_id = $1`,
        [operationId],
      );
      return Object.freeze({ operationId, holderId, fencingToken: token });
    });
  }

  async recordPreState(claim: SignerClaim, state: StateSnapshot, fingerprint: string): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertClaim(client, claim, "PRECHECKING");
      await client.query(
        `UPDATE influencedx_marketplace_operator_jobs
         SET pre_state_json = $2::jsonb, updated_at = clock_timestamp()
         WHERE operation_id = $1`,
        [claim.operationId, JSON.stringify(state)],
      );
      await client.query(
        `UPDATE influencedx_marketplace_operator_status
         SET pre_state_fingerprint = $2, updated_at = clock_timestamp()
         WHERE operation_id = $1 AND status = 'PRECHECKING'`,
        [claim.operationId, fingerprint],
      );
    });
  }

  async failPrecheck(claim: SignerClaim, errorCode: string): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertClaim(client, claim, "PRECHECKING");
      await client.query(
        `UPDATE influencedx_marketplace_operator_status
         SET status = 'PRECHECK_FAILED', error_code = $2, updated_at = clock_timestamp()
         WHERE operation_id = $1`,
        [claim.operationId, errorCode],
      );
      await this.releaseGate(client, claim);
    });
  }

  async beginBroadcast(claim: SignerClaim): Promise<boolean> {
    return this.transaction(async (client) => {
      if (!(await this.hasClaim(client, claim, "PRECHECKING"))) return false;
      const status = await client.query(
        `UPDATE influencedx_marketplace_operator_status
         SET status = 'BROADCASTING', broadcast_started_at = clock_timestamp(),
             error_code = NULL, updated_at = clock_timestamp()
         WHERE operation_id = $1 AND status = 'PRECHECKING'
           AND pre_state_fingerprint IS NOT NULL`,
        [claim.operationId],
      );
      if (!status.rowCount) return false;
      await client.query(
        `UPDATE influencedx_marketplace_operator_signer_gate
         SET phase = 'BROADCASTING', lease_expires_at = NULL, updated_at = clock_timestamp()
         WHERE gate_name = $1 AND holder_id = $2::uuid AND fencing_token = $3
           AND active_operation_id = $4`,
        [SIGNER_GATE, claim.holderId, claim.fencingToken.toString(), claim.operationId],
      );
      return true;
    });
  }

  async recordSubmitted(claim: SignerClaim, txHash: string): Promise<OperationRecord> {
    return this.transaction(async (client) => {
      await this.assertClaim(client, claim, "BROADCASTING");
      const updated = await client.query(
        `UPDATE influencedx_marketplace_operator_status
         SET status = 'SUBMITTED', tx_hash = $2, submitted_at = clock_timestamp(),
             poll_attempts = 0, error_code = NULL, updated_at = clock_timestamp()
         WHERE operation_id = $1 AND status = 'BROADCASTING'`,
        [claim.operationId, txHash],
      );
      if (!updated.rowCount) throw storageError();
      await this.releaseGate(client, claim);
      const record = await this.getWith(client, claim.operationId, true);
      if (!record) throw storageError();
      return record;
    });
  }

  quarantineBroadcast(claim: SignerClaim, errorCode: string): Promise<OperationRecord> {
    return this.quarantine(claim, errorCode, "BROADCASTING");
  }

  async quarantineAmbiguousBroadcast(operationId: string, errorCode: string): Promise<OperationRecord> {
    await this.pool.query(
      `UPDATE influencedx_marketplace_operator_status
       SET status = 'RECONCILIATION_REQUIRED', error_code = $2, updated_at = clock_timestamp()
       WHERE operation_id = $1 AND status = 'BROADCASTING'`,
      [operationId, errorCode],
    );
    // The signer gate remains non-expiring. There is no safe proof that the
    // missing hash means StudioNet rejected the call.
    return this.requireRecord(operationId);
  }

  quarantineWithoutBroadcast(claim: SignerClaim, errorCode: string): Promise<OperationRecord> {
    return this.quarantine(claim, errorCode, "PRECHECKING");
  }

  async recordPoll(operationId: string, patch: PollPatch): Promise<OperationRecord> {
    return this.transaction(async (client) => {
      const current = await this.getWith(client, operationId, true);
      if (!current) throw new OperatorProblem(404, "OPERATION_NOT_FOUND", "Operation not found.");
      if (!["SUBMITTED", "POLLING"].includes(current.status)) return current;
      const next = {
        status: patch.status ?? current.status,
        lifecycleStatus: patch.lifecycleStatus === undefined ? current.lifecycleStatus : patch.lifecycleStatus,
        executionResult: patch.executionResult === undefined ? current.executionResult : patch.executionResult,
        postStateFingerprint: patch.postStateFingerprint === undefined ? current.postStateFingerprint : patch.postStateFingerprint,
        pollAttempts: patch.pollAttempts ?? current.pollAttempts,
        errorCode: patch.errorCode === undefined ? current.errorCode : patch.errorCode,
        lastPolledAt: patch.lastPolledAt === undefined ? current.lastPolledAt : patch.lastPolledAt,
        finalizedAt: patch.finalizedAt === undefined ? current.finalizedAt : patch.finalizedAt,
      };
      await client.query(
        `UPDATE influencedx_marketplace_operator_status
         SET status = $2, lifecycle_status = $3, execution_result = $4,
             post_state_fingerprint = $5, poll_attempts = $6, error_code = $7,
             last_polled_at = $8, finalized_at = $9, updated_at = clock_timestamp()
         WHERE operation_id = $1 AND status IN ('SUBMITTED', 'POLLING')`,
        [operationId, next.status, next.lifecycleStatus, next.executionResult,
          next.postStateFingerprint, next.pollAttempts, next.errorCode,
          next.lastPolledAt, next.finalizedAt],
      );
      const updated = await this.getWith(client, operationId, true);
      if (!updated) throw storageError();
      return updated;
    });
  }

  async markPoisoned(operationId: string, errorCode: string): Promise<void> {
    await this.pool.query(
      `UPDATE influencedx_marketplace_operator_status
       SET status = 'POISONED', error_code = $2, updated_at = clock_timestamp()
       WHERE operation_id = $1 AND status IN ('QUEUED', 'PRECHECK_FAILED')`,
      [operationId, errorCode],
    );
  }

  async noteDelivery(operationId: string, deliveryCount: number): Promise<void> {
    await this.pool.query(
      `UPDATE influencedx_marketplace_operator_status
       SET delivery_count = GREATEST(delivery_count, $2), updated_at = clock_timestamp()
       WHERE operation_id = $1`,
      [operationId, deliveryCount],
    );
  }

  private async quarantine(
    claim: SignerClaim,
    errorCode: string,
    phase: "PRECHECKING" | "BROADCASTING",
  ): Promise<OperationRecord> {
    return this.transaction(async (client) => {
      await this.assertClaim(client, claim, phase);
      await client.query(
        `UPDATE influencedx_marketplace_operator_status
         SET status = 'RECONCILIATION_REQUIRED', error_code = $2,
             updated_at = clock_timestamp()
         WHERE operation_id = $1`,
        [claim.operationId, errorCode],
      );
      if (phase === "PRECHECKING") await this.releaseGate(client, claim);
      // BROADCASTING intentionally retains a non-expiring gate. A transport
      // failure may have happened after the transaction reached StudioNet.
      const record = await this.getWith(client, claim.operationId, true);
      if (!record) throw storageError();
      return record;
    });
  }

  private async releaseGate(client: PoolClient, claim: SignerClaim): Promise<void> {
    const result = await client.query(
      `UPDATE influencedx_marketplace_operator_signer_gate
       SET holder_id = NULL, active_operation_id = NULL, phase = NULL,
           lease_expires_at = NULL, acquired_at = NULL, updated_at = clock_timestamp()
       WHERE gate_name = $1 AND holder_id = $2::uuid AND fencing_token = $3
         AND active_operation_id = $4`,
      [SIGNER_GATE, claim.holderId, claim.fencingToken.toString(), claim.operationId],
    );
    if (!result.rowCount) throw storageError();
  }

  private async hasClaim(client: PoolClient, claim: SignerClaim, phase: string): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM influencedx_marketplace_operator_signer_gate
       WHERE gate_name = $1 AND holder_id = $2::uuid AND fencing_token = $3
         AND active_operation_id = $4 AND phase = $5 FOR UPDATE`,
      [SIGNER_GATE, claim.holderId, claim.fencingToken.toString(), claim.operationId, phase],
    );
    return Boolean(result.rowCount);
  }

  private async assertClaim(client: PoolClient, claim: SignerClaim, phase: string): Promise<void> {
    if (!(await this.hasClaim(client, claim, phase))) {
      throw new OperatorProblem(503, "SIGNER_FENCE_LOST", "The signer fencing claim is no longer valid.");
    }
  }

  private async requireRecord(operationId: string): Promise<OperationRecord> {
    const record = await this.get(operationId);
    if (!record) throw new OperatorProblem(404, "OPERATION_NOT_FOUND", "Operation not found.");
    return record;
  }

  private async getWith(
    queryable: Pick<pg.Pool, "query"> | Pick<PoolClient, "query">,
    operationId: string,
    forUpdate: boolean,
  ): Promise<OperationRecord | null> {
    const result = await queryable.query(
      `${RECORD_SELECT} WHERE s.operation_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [operationId],
    );
    return result.rowCount ? mapRecord(result.rows[0]) : null;
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

const RECORD_SELECT = `
  SELECT s.*, j.envelope_json, j.envelope_fingerprint, j.call_fingerprint, j.pre_state_json
  FROM influencedx_marketplace_operator_status s
  JOIN influencedx_marketplace_operator_jobs j USING (operation_id)`;

const PROJECTION_SELECT = `
  SELECT operation_id, network, chain_id, contract_address, action, function_name, value_atto,
         status, lifecycle_status, execution_result, tx_hash, queue_message_id,
         enqueue_attempts, delivery_count, poll_attempts, error_code,
         pre_state_fingerprint, post_state_fingerprint, broadcast_started_at,
         submitted_at, last_polled_at, finalized_at, created_at, updated_at
  FROM influencedx_marketplace_operator_status`;

function mapRecord(row: Record<string, unknown>): OperationRecord {
  return Object.freeze({
    ...mapProjection(row),
    envelope: (row.envelope_json ?? null) as OperationEnvelope | null,
    envelopeFingerprint: String(row.envelope_fingerprint),
    callFingerprint: String(row.call_fingerprint),
    preState: (row.pre_state_json ?? null) as StateSnapshot | null,
  });
}

function mapProjection(row: Record<string, unknown>): OperationProjection {
  return Object.freeze({
    operationId: String(row.operation_id),
    network: String(row.network),
    chainId: Number(row.chain_id),
    contractAddress: String(row.contract_address),
    action: row.action as OperationRecord["action"],
    functionName: row.function_name as OperationRecord["functionName"],
    valueAtto: String(row.value_atto),
    preStateFingerprint: nullableString(row.pre_state_fingerprint),
    postStateFingerprint: nullableString(row.post_state_fingerprint),
    status: row.status as OperationRecord["status"],
    lifecycleStatus: nullableString(row.lifecycle_status),
    executionResult: nullableString(row.execution_result),
    txHash: nullableString(row.tx_hash),
    queueMessageId: nullableString(row.queue_message_id),
    enqueueAttempts: Number(row.enqueue_attempts),
    deliveryCount: Number(row.delivery_count),
    pollAttempts: Number(row.poll_attempts),
    errorCode: nullableString(row.error_code),
    broadcastStartedAt: nullableDate(row.broadcast_started_at),
    submittedAt: nullableDate(row.submitted_at),
    lastPolledAt: nullableDate(row.last_polled_at),
    finalizedAt: nullableDate(row.finalized_at),
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
  });
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : new Date(value as string | Date);
}

function storageError(): OperatorProblem {
  return new OperatorProblem(503, "OPERATOR_STORAGE_ERROR", "The marketplace operator store is unavailable.");
}
