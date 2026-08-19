import pg, { type PoolClient } from "pg";

import {
  CONFIRM_METHOD,
  MARKETPLACE_ADDRESS,
  MARKETPLACE_OWNER,
  PRECHECK_LEASE_MS,
  RECONCILER_NETWORK,
  SIGNER_GATE,
  STUDIONET_CHAIN_ID,
  ZERO_VALUE_ATTO,
} from "./constants";
import { ReconcilerProblem } from "./problem";
import type {
  MarketplaceCounts,
  ReconciliationProjection,
  ReconciliationRecord,
  ReconciliationRepository,
  ReconciliationRequest,
  SignerClaim,
  TransferProof,
  WithdrawalState,
} from "./types";

const pools = new Map<string, pg.Pool>();

export function repositoryFor(databaseUrl: string): PostgresReconciliationRepository {
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
  return new PostgresReconciliationRepository(pool);
}

export async function closeRepositoryPools(): Promise<void> {
  const active = [...pools.values()];
  pools.clear();
  await Promise.all(active.map((pool) => pool.end()));
}

export class PostgresReconciliationRepository implements ReconciliationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async createOrReplay(request: ReconciliationRequest, requestFingerprint: string) {
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO influencedx_withdrawal_reconciliations
           (withdrawal_id, status, network, chain_id, contract_address, contract_owner, function_name, value_atto)
         VALUES ($1, 'QUEUED', $2, $3, $4, $5, $6, $7)
         ON CONFLICT (withdrawal_id) DO NOTHING`,
        [request.withdrawalId, RECONCILER_NETWORK, STUDIONET_CHAIN_ID, MARKETPLACE_ADDRESS, MARKETPLACE_OWNER, CONFIRM_METHOD, ZERO_VALUE_ATTO],
      );
      await client.query(
        `INSERT INTO influencedx_withdrawal_reconciliation_jobs
           (withdrawal_id, schema_version, request_fingerprint)
         VALUES ($1, 1, $2)
         ON CONFLICT (withdrawal_id) DO NOTHING`,
        [request.withdrawalId, requestFingerprint],
      );
      const record = await this.getWith(client, request.withdrawalId, true);
      if (!record) throw storageError();
      if (record.requestFingerprint !== requestFingerprint) {
        throw new ReconcilerProblem(409, "WITHDRAWAL_ID_COLLISION", "The withdrawal ID is bound to a different reconciliation request.");
      }
      return { record, replayed: inserted.rowCount === 0 };
    });
  }

  async recordQueueAccepted(withdrawalId: string, messageId: string | null): Promise<ReconciliationRecord> {
    await this.pool.query(
      `UPDATE influencedx_withdrawal_reconciliations
       SET queue_message_id = COALESCE(queue_message_id, $2),
           enqueue_attempts = enqueue_attempts + 1,
           updated_at = clock_timestamp()
       WHERE withdrawal_id = $1`,
      [withdrawalId, messageId],
    );
    return this.requireRecord(withdrawalId);
  }

  get(withdrawalId: string): Promise<ReconciliationRecord | null> {
    return this.getWith(this.pool, withdrawalId, false);
  }

  async getProjection(withdrawalId: string): Promise<ReconciliationProjection | null> {
    const result = await this.pool.query(`${PROJECTION_SELECT} WHERE withdrawal_id = $1`, [withdrawalId]);
    return result.rowCount ? mapProjection(result.rows[0]) : null;
  }

  async noteDelivery(withdrawalId: string, deliveryCount: number): Promise<void> {
    await this.pool.query(
      `UPDATE influencedx_withdrawal_reconciliations
       SET delivery_count = GREATEST(delivery_count, $2), updated_at = clock_timestamp()
       WHERE withdrawal_id = $1`,
      [withdrawalId, deliveryCount],
    );
  }

  async recordWaiting(
    withdrawalId: string,
    status: "WAITING_FOR_EMISSION" | "WAITING_FOR_TRANSFER",
    errorCode: string,
    checkedAt: Date,
  ): Promise<ReconciliationRecord> {
    await this.pool.query(
      `UPDATE influencedx_withdrawal_reconciliations
       SET status = $2, error_code = $3, discovery_attempts = discovery_attempts + 1,
           last_checked_at = $4, updated_at = clock_timestamp()
       WHERE withdrawal_id = $1
         AND status IN ('QUEUED', 'WAITING_FOR_EMISSION', 'WAITING_FOR_TRANSFER')`,
      [withdrawalId, status, errorCode, checkedAt],
    );
    return this.requireRecord(withdrawalId);
  }

  async requireManual(withdrawalId: string, errorCode: string): Promise<ReconciliationRecord> {
    await this.pool.query(
      `UPDATE influencedx_withdrawal_reconciliations
       SET status = 'RECONCILIATION_REQUIRED', error_code = $2,
           last_checked_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE withdrawal_id = $1 AND status NOT IN ('FINALIZED', 'POISONED')`,
      [withdrawalId, errorCode],
    );
    return this.requireRecord(withdrawalId);
  }

  async claimProof(withdrawalId: string, holderId: string, leaseMs: number): Promise<SignerClaim | null> {
    if (leaseMs !== PRECHECK_LEASE_MS) throw storageError();
    return this.transaction(async (client) => {
      const status = await client.query(
        `SELECT status FROM influencedx_withdrawal_reconciliations WHERE withdrawal_id = $1 FOR UPDATE`,
        [withdrawalId],
      );
      if (!status.rowCount || !["QUEUED", "WAITING_FOR_EMISSION", "WAITING_FOR_TRANSFER", "PROOF_VERIFIED"].includes(String(status.rows[0].status))) {
        return null;
      }
      const gate = await client.query(
        `SELECT *,
                (phase = 'PRECHECKING' AND lease_expires_at IS NOT NULL
                 AND lease_expires_at <= clock_timestamp()) AS precheck_expired
         FROM influencedx_withdrawal_reconciliation_signer_gate
         WHERE gate_name = $1 FOR UPDATE`,
        [SIGNER_GATE],
      );
      if (!gate.rowCount) throw storageError();
      const current = gate.rows[0];
      const expired = current.precheck_expired === true;
      if (current.active_withdrawal_id !== null && !expired) return null;
      const nextToken = BigInt(current.fencing_token) + 1n;
      const updated = await client.query(
        `UPDATE influencedx_withdrawal_reconciliation_signer_gate
         SET fencing_token = $2, holder_id = $3::uuid, active_withdrawal_id = $4,
             phase = 'PRECHECKING', lease_expires_at = clock_timestamp() + ($5::text || ' milliseconds')::interval,
             acquired_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE gate_name = $1
         RETURNING fencing_token`,
        [SIGNER_GATE, nextToken.toString(), holderId, withdrawalId, leaseMs],
      );
      if (!updated.rowCount) throw storageError();
      await client.query(
        `UPDATE influencedx_withdrawal_reconciliations
         SET status = 'PROOF_VERIFIED', error_code = NULL, updated_at = clock_timestamp()
         WHERE withdrawal_id = $1`,
        [withdrawalId],
      );
      return Object.freeze({ withdrawalId, holderId, fencingToken: nextToken });
    });
  }

  async recordProof(
    claim: SignerClaim,
    withdrawal: WithdrawalState,
    counts: MarketplaceCounts,
    proof: TransferProof,
    proofFingerprint: string,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertClaim(client, claim, "PRECHECKING");
      const job = await client.query(
        `UPDATE influencedx_withdrawal_reconciliation_jobs
         SET withdrawal_json = $2::jsonb, counts_before_json = $3::jsonb,
             proof_json = $4::jsonb, proof_fingerprint = $5, updated_at = clock_timestamp()
         WHERE withdrawal_id = $1`,
        [claim.withdrawalId, JSON.stringify(withdrawal), JSON.stringify(counts), JSON.stringify(proof), proofFingerprint],
      );
      const status = await client.query(
        `UPDATE influencedx_withdrawal_reconciliations
         SET evidence_hash = $2, transfer_parent_tx_hash = $3, transfer_child_tx_hash = $4,
             last_checked_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE withdrawal_id = $1 AND status = 'PROOF_VERIFIED'`,
        [claim.withdrawalId, proof.evidenceHash, proof.parentTxHash, proof.childTxHash],
      );
      if (!job.rowCount || !status.rowCount) throw storageError();
    });
  }

  async releasePrecheck(claim: SignerClaim, errorCode: string): Promise<void> {
    await this.transaction(async (client) => {
      await this.assertClaim(client, claim, "PRECHECKING");
      await client.query(
        `UPDATE influencedx_withdrawal_reconciliations
         SET status = 'WAITING_FOR_TRANSFER', error_code = $2, updated_at = clock_timestamp()
         WHERE withdrawal_id = $1`,
        [claim.withdrawalId, errorCode],
      );
      await this.releaseGate(client, claim);
    });
  }

  async beginBroadcast(claim: SignerClaim): Promise<boolean> {
    return this.transaction(async (client) => {
      if (!(await this.hasClaim(client, claim, "PRECHECKING"))) return false;
      const job = await client.query(
        `SELECT 1 FROM influencedx_withdrawal_reconciliation_jobs
         WHERE withdrawal_id = $1 AND proof_json IS NOT NULL AND proof_fingerprint IS NOT NULL`,
        [claim.withdrawalId],
      );
      if (!job.rowCount) throw storageError();
      const gate = await client.query(
        `UPDATE influencedx_withdrawal_reconciliation_signer_gate
         SET phase = 'BROADCASTING', lease_expires_at = NULL, updated_at = clock_timestamp()
         WHERE gate_name = $1 AND holder_id = $2::uuid AND fencing_token = $3
           AND active_withdrawal_id = $4 AND phase = 'PRECHECKING'`,
        [SIGNER_GATE, claim.holderId, claim.fencingToken.toString(), claim.withdrawalId],
      );
      const status = await client.query(
        `UPDATE influencedx_withdrawal_reconciliations
         SET status = 'BROADCASTING', broadcast_started_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE withdrawal_id = $1 AND status = 'PROOF_VERIFIED'`,
        [claim.withdrawalId],
      );
      if (!gate.rowCount || !status.rowCount) throw storageError();
      return true;
    });
  }

  async recordSubmitted(claim: SignerClaim, txHash: string): Promise<ReconciliationRecord> {
    return this.transaction(async (client) => {
      await this.assertClaim(client, claim, "BROADCASTING");
      const result = await client.query(
        `UPDATE influencedx_withdrawal_reconciliations
         SET status = 'SUBMITTED', confirmation_tx_hash = $2, submitted_at = clock_timestamp(),
             error_code = NULL, updated_at = clock_timestamp()
         WHERE withdrawal_id = $1 AND status = 'BROADCASTING'`,
        [claim.withdrawalId, txHash],
      );
      if (!result.rowCount) throw storageError();
      await this.releaseGate(client, claim);
      const record = await this.getWith(client, claim.withdrawalId, true);
      if (!record) throw storageError();
      return record;
    });
  }

  async quarantineBroadcast(claim: SignerClaim, errorCode: string): Promise<ReconciliationRecord> {
    return this.transaction(async (client) => {
      await this.assertClaim(client, claim, "BROADCASTING");
      await client.query(
        `UPDATE influencedx_withdrawal_reconciliations
         SET status = 'RECONCILIATION_REQUIRED', error_code = $2, updated_at = clock_timestamp()
         WHERE withdrawal_id = $1`,
        [claim.withdrawalId, errorCode],
      );
      const record = await this.getWith(client, claim.withdrawalId, true);
      if (!record) throw storageError();
      return record;
    });
  }

  async quarantineAmbiguousBroadcast(withdrawalId: string, errorCode: string): Promise<ReconciliationRecord> {
    await this.pool.query(
      `UPDATE influencedx_withdrawal_reconciliations
       SET status = 'RECONCILIATION_REQUIRED', error_code = $2, updated_at = clock_timestamp()
       WHERE withdrawal_id = $1 AND status = 'BROADCASTING'`,
      [withdrawalId, errorCode],
    );
    return this.requireRecord(withdrawalId);
  }

  async recordPoll(withdrawalId: string, patch: Parameters<ReconciliationRepository["recordPoll"]>[1]): Promise<ReconciliationRecord> {
    const current = await this.requireRecord(withdrawalId);
    if (!["SUBMITTED", "POLLING"].includes(current.status)) return current;
    const merged = {
      status: patch.status ?? current.status,
      lifecycleStatus: patch.lifecycleStatus === undefined ? current.lifecycleStatus : patch.lifecycleStatus,
      executionResult: patch.executionResult === undefined ? current.executionResult : patch.executionResult,
      pollAttempts: patch.pollAttempts ?? current.pollAttempts,
      errorCode: patch.errorCode === undefined ? current.errorCode : patch.errorCode,
      lastCheckedAt: patch.lastCheckedAt === undefined ? current.lastCheckedAt : patch.lastCheckedAt,
      finalizedAt: patch.finalizedAt === undefined ? current.finalizedAt : patch.finalizedAt,
    };
    await this.pool.query(
      `UPDATE influencedx_withdrawal_reconciliations
       SET status = $2, lifecycle_status = $3, execution_result = $4, poll_attempts = $5,
           error_code = $6, last_checked_at = $7, finalized_at = $8, updated_at = clock_timestamp()
       WHERE withdrawal_id = $1 AND status IN ('SUBMITTED', 'POLLING')`,
      [withdrawalId, merged.status, merged.lifecycleStatus, merged.executionResult, merged.pollAttempts, merged.errorCode, merged.lastCheckedAt, merged.finalizedAt],
    );
    return this.requireRecord(withdrawalId);
  }

  async markPoisoned(withdrawalId: string, errorCode: string): Promise<void> {
    await this.pool.query(
      `UPDATE influencedx_withdrawal_reconciliations
       SET status = 'POISONED', error_code = $2, updated_at = clock_timestamp()
       WHERE withdrawal_id = $1 AND status IN ('QUEUED', 'WAITING_FOR_EMISSION', 'WAITING_FOR_TRANSFER')`,
      [withdrawalId, errorCode],
    );
  }

  private async requireRecord(withdrawalId: string): Promise<ReconciliationRecord> {
    const record = await this.get(withdrawalId);
    if (!record) throw new ReconcilerProblem(404, "RECONCILIATION_NOT_FOUND", "Withdrawal reconciliation not found.");
    return record;
  }

  private async getWith(queryable: Pick<pg.Pool, "query"> | Pick<PoolClient, "query">, withdrawalId: string, forUpdate: boolean) {
    const result = await queryable.query(`${RECORD_SELECT} WHERE r.withdrawal_id = $1${forUpdate ? " FOR UPDATE" : ""}`, [withdrawalId]);
    return result.rowCount ? mapRecord(result.rows[0]) : null;
  }

  private async hasClaim(client: PoolClient, claim: SignerClaim, phase: string): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM influencedx_withdrawal_reconciliation_signer_gate
       WHERE gate_name = $1 AND holder_id = $2::uuid AND fencing_token = $3
         AND active_withdrawal_id = $4 AND phase = $5 FOR UPDATE`,
      [SIGNER_GATE, claim.holderId, claim.fencingToken.toString(), claim.withdrawalId, phase],
    );
    return Boolean(result.rowCount);
  }

  private async assertClaim(client: PoolClient, claim: SignerClaim, phase: string): Promise<void> {
    if (!(await this.hasClaim(client, claim, phase))) throw new ReconcilerProblem(503, "SIGNER_FENCE_LOST", "The signer fencing claim is no longer valid.");
  }

  private async releaseGate(client: PoolClient, claim: SignerClaim): Promise<void> {
    const result = await client.query(
      `UPDATE influencedx_withdrawal_reconciliation_signer_gate
       SET holder_id = NULL, active_withdrawal_id = NULL, phase = NULL,
           lease_expires_at = NULL, acquired_at = NULL, updated_at = clock_timestamp()
       WHERE gate_name = $1 AND holder_id = $2::uuid AND fencing_token = $3
         AND active_withdrawal_id = $4`,
      [SIGNER_GATE, claim.holderId, claim.fencingToken.toString(), claim.withdrawalId],
    );
    if (!result.rowCount) throw storageError();
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
  SELECT r.*, j.request_fingerprint, j.withdrawal_json, j.counts_before_json,
         j.proof_json, j.proof_fingerprint
  FROM influencedx_withdrawal_reconciliations r
  JOIN influencedx_withdrawal_reconciliation_jobs j USING (withdrawal_id)`;

const PROJECTION_SELECT = `
  SELECT withdrawal_id, network, chain_id, contract_address, contract_owner,
         function_name, value_atto, status, evidence_hash, transfer_parent_tx_hash,
         transfer_child_tx_hash, confirmation_tx_hash, lifecycle_status, execution_result,
         queue_message_id, enqueue_attempts, delivery_count, discovery_attempts, poll_attempts,
         error_code, broadcast_started_at, submitted_at, last_checked_at, finalized_at,
         created_at, updated_at
  FROM influencedx_withdrawal_reconciliations`;

function mapRecord(row: Record<string, unknown>): ReconciliationRecord {
  return Object.freeze({
    ...mapProjection(row),
    requestFingerprint: String(row.request_fingerprint),
    withdrawal: (row.withdrawal_json ?? null) as WithdrawalState | null,
    countsBefore: (row.counts_before_json ?? null) as MarketplaceCounts | null,
    proof: (row.proof_json ?? null) as TransferProof | null,
    proofFingerprint: nullableString(row.proof_fingerprint),
  });
}

function mapProjection(row: Record<string, unknown>): ReconciliationProjection {
  return Object.freeze({
    withdrawalId: String(row.withdrawal_id),
    network: String(row.network),
    chainId: Number(row.chain_id),
    contractAddress: String(row.contract_address),
    contractOwner: String(row.contract_owner),
    functionName: CONFIRM_METHOD,
    valueAtto: ZERO_VALUE_ATTO,
    status: row.status as ReconciliationRecord["status"],
    evidenceHash: nullableString(row.evidence_hash),
    transferParentTxHash: nullableString(row.transfer_parent_tx_hash),
    transferChildTxHash: nullableString(row.transfer_child_tx_hash),
    confirmationTxHash: nullableString(row.confirmation_tx_hash),
    lifecycleStatus: nullableString(row.lifecycle_status),
    executionResult: nullableString(row.execution_result),
    queueMessageId: nullableString(row.queue_message_id),
    enqueueAttempts: Number(row.enqueue_attempts),
    deliveryCount: Number(row.delivery_count),
    discoveryAttempts: Number(row.discovery_attempts),
    pollAttempts: Number(row.poll_attempts),
    errorCode: nullableString(row.error_code),
    broadcastStartedAt: nullableDate(row.broadcast_started_at),
    submittedAt: nullableDate(row.submitted_at),
    lastCheckedAt: nullableDate(row.last_checked_at),
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

function storageError(): ReconcilerProblem {
  return new ReconcilerProblem(503, "RECONCILER_STORAGE_ERROR", "The withdrawal reconciliation store is unavailable.");
}
