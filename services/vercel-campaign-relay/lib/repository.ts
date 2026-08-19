import { randomUUID } from "node:crypto";
import pg from "pg";
import { getAddress, type Address, type Hex } from "viem";
import type { RelayConfig } from "./config.js";
import { LEASE_DURATION_MS } from "./constants.js";
import { RelayProblem } from "./problem.js";
import type {
  ClaimedResolution,
  RelayJob,
  ResolutionContext,
  ResolutionOutcome,
} from "./types.js";

const { Pool } = pg;
let sharedPool: pg.Pool | undefined;

export type ClaimResult =
  | Readonly<{ kind: "CLAIMED"; value: ClaimedResolution }>
  | Readonly<{ kind: "CONFIRMED"; job: RelayJob }>;

export interface ResolutionRepository {
  claim(requestId: Hex, nowMs: number): Promise<ClaimResult>;
  recordQuorum(input: { requestId: Hex; fenceToken: string; digest: Hex; signers: readonly Address[]; evidenceHash: Hex; resolvedAt: number; relayDeadline: number; nowMs: number }): Promise<void>;
  recordSimulated(input: { requestId: Hex; fenceToken: string; nowMs: number }): Promise<void>;
  markBroadcasting(input: { requestId: Hex; fenceToken: string; nowMs: number }): Promise<void>;
  recordBroadcastHash(input: { requestId: Hex; fenceToken: string; txHash: Hex; nowMs: number }): Promise<void>;
  recordConfirmed(input: { requestId: Hex; fenceToken: string; txHash: Hex; blockNumber: string; outcome: ResolutionOutcome; evidenceHash: Hex; nowMs: number }): Promise<void>;
  markRetryable(input: { requestId: Hex; fenceToken: string; errorCode: string; nowMs: number }): Promise<void>;
  markFailed(input: { requestId: Hex; fenceToken: string; errorCode: string; nowMs: number }): Promise<void>;
  markReconciliation(input: { requestId: Hex; fenceToken: string; errorCode: string; txHash?: Hex | null; nowMs: number }): Promise<void>;
}

export function createResolutionRepository(config: RelayConfig): ResolutionRepository {
  const pool = sharedPool ??= new Pool({
    connectionString: config.databaseUrl,
    max: 2,
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    query_timeout: 15_000,
    application_name: "influencedx-campaign-relay",
  });
  return new PostgresResolutionRepository(pool, config.escrow);
}

export class PostgresResolutionRepository implements ResolutionRepository {
  constructor(private readonly pool: pg.Pool, private readonly escrow: Address) {}

  async claim(requestId: Hex, nowMs: number): Promise<ClaimResult> {
    const client = await this.pool.connect();
    const fenceToken = randomUUID();
    try {
      await client.query("BEGIN");
      const contextResult = await client.query(CONTEXT_SQL, [requestId]);
      if (contextResult.rowCount !== 1) throw new RelayProblem(409, "RESOLUTION_NOT_READY", "The finalized marketplace resolution is not ready for Base settlement.");
      const context = contextRow(contextResult.rows[0], this.escrow);
      await client.query(INSERT_JOB_SQL, [
        context.requestId,
        context.applicationId,
        context.resolutionRound,
        context.assignmentId,
        context.genlayerTxHash,
        context.expectedOutcome,
        nowMs,
      ]);
      const jobResult = await client.query("SELECT * FROM marketplace_campaign_resolution_relays WHERE request_id = $1 FOR UPDATE", [requestId]);
      const current = jobRow(jobResult.rows[0]);
      assertJobContext(current, context);
      if (current.status === "CONFIRMED") {
        await client.query("COMMIT");
        return Object.freeze({ kind: "CONFIRMED", job: current });
      }
      if (current.status === "BROADCASTING" || current.status === "RECONCILIATION_REQUIRED") {
        throw new RelayProblem(409, "RECONCILIATION_REQUIRED", "A prior Base broadcast must be reconciled before any retry.");
      }
      if (current.status === "FAILED") throw new RelayProblem(409, "RELAY_TERMINAL", "This resolution relay is in a terminal failed state.");
      const claimable = ["PENDING", "RETRYABLE"].includes(current.status) || (
        ["CLAIMED", "QUORUM_READY", "SIMULATED"].includes(current.status) &&
        current.leaseExpiresAt !== null && current.leaseExpiresAt < nowMs
      );
      if (!claimable) throw new RelayProblem(409, "RELAY_BUSY", "Another relay invocation owns this request.", true);
      const updated = await client.query(
        `UPDATE marketplace_campaign_resolution_relays
           SET status = 'CLAIMED', fence_token = $2, lease_expires_at = $3,
               attempt_count = attempt_count + 1, last_attempt_at = $4,
               error_code = NULL, updated_at = $4
         WHERE request_id = $1
         RETURNING *`,
        [requestId, fenceToken, nowMs + LEASE_DURATION_MS, nowMs],
      );
      await client.query("COMMIT");
      return Object.freeze({
        kind: "CLAIMED",
        value: Object.freeze({ job: jobRow(updated.rows[0]), context, fenceToken }),
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  recordQuorum(input: { requestId: Hex; fenceToken: string; digest: Hex; signers: readonly Address[]; evidenceHash: Hex; resolvedAt: number; relayDeadline: number; nowMs: number }): Promise<void> {
    return this.cas(
      `UPDATE marketplace_campaign_resolution_relays
          SET status = 'QUORUM_READY', quorum_digest = $3, signer_addresses = $4::jsonb,
              evidence_hash = $5, resolved_at = $6, relay_deadline = $7,
              lease_expires_at = $8, updated_at = $9
        WHERE request_id = $1 AND fence_token = $2 AND status = 'CLAIMED'`,
      [input.requestId, input.fenceToken, input.digest, JSON.stringify(input.signers.map((address) => address.toLowerCase())), input.evidenceHash, input.resolvedAt, input.relayDeadline, input.nowMs + LEASE_DURATION_MS, input.nowMs],
    );
  }
  recordSimulated(input: { requestId: Hex; fenceToken: string; nowMs: number }): Promise<void> {
    return this.cas(`UPDATE marketplace_campaign_resolution_relays SET status = 'SIMULATED', lease_expires_at = $3, updated_at = $4 WHERE request_id = $1 AND fence_token = $2 AND status = 'QUORUM_READY'`, [input.requestId, input.fenceToken, input.nowMs + LEASE_DURATION_MS, input.nowMs]);
  }
  markBroadcasting(input: { requestId: Hex; fenceToken: string; nowMs: number }): Promise<void> {
    return this.cas(`UPDATE marketplace_campaign_resolution_relays SET status = 'BROADCASTING', lease_expires_at = $3, updated_at = $4 WHERE request_id = $1 AND fence_token = $2 AND status = 'SIMULATED'`, [input.requestId, input.fenceToken, input.nowMs + LEASE_DURATION_MS, input.nowMs]);
  }
  recordBroadcastHash(input: { requestId: Hex; fenceToken: string; txHash: Hex; nowMs: number }): Promise<void> {
    return this.cas(`UPDATE marketplace_campaign_resolution_relays SET base_tx_hash = $3, lease_expires_at = $4, updated_at = $5 WHERE request_id = $1 AND fence_token = $2 AND status = 'BROADCASTING' AND (base_tx_hash IS NULL OR base_tx_hash = $3)`, [input.requestId, input.fenceToken, input.txHash, input.nowMs + LEASE_DURATION_MS, input.nowMs]);
  }

  async recordConfirmed(input: { requestId: Hex; fenceToken: string; txHash: Hex; blockNumber: string; outcome: ResolutionOutcome; evidenceHash: Hex; nowMs: number }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const app = input.outcome === "UNDETERMINED"
        ? await client.query(UNDETERMINED_MIRROR_SQL, [input.requestId, input.outcome, input.evidenceHash, input.txHash, input.nowMs])
        : await client.query(TERMINAL_MIRROR_SQL, [input.requestId, input.outcome, input.evidenceHash, input.txHash, input.nowMs]);
      if (app.rowCount !== 1) throw new RelayProblem(409, "MIRROR_RECONCILIATION_REQUIRED", "Base settled but the marketplace mirror changed.");
      const campaignStatus = input.outcome === "PASS" ? "PAID" : input.outcome === "FAIL" ? "REFUNDED" : "SUBMITTED";
      const campaign = await client.query(
        `UPDATE marketplace_campaigns c SET status = $2, revision = revision + 1, updated_at = $3
          FROM marketplace_applications a
         WHERE a.id = $1 AND c.id = a.campaign_id AND c.status = 'RESOLVING'
         RETURNING c.id`,
        [app.rows[0].id, campaignStatus, input.nowMs],
      );
      if (campaign.rowCount !== 1) throw new RelayProblem(409, "MIRROR_RECONCILIATION_REQUIRED", "Base settled but the campaign mirror changed.");
      const relay = await client.query(
        `UPDATE marketplace_campaign_resolution_relays
            SET status = 'CONFIRMED', base_tx_hash = $3, base_block_number = $4,
                fence_token = NULL, lease_expires_at = NULL, error_code = NULL, updated_at = $5
          WHERE request_id = $1 AND fence_token = $2 AND status = 'BROADCASTING'
          RETURNING request_id`,
        [input.requestId, input.fenceToken, input.txHash, input.blockNumber, input.nowMs],
      );
      if (relay.rowCount !== 1) throw staleFence();
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  markRetryable(input: { requestId: Hex; fenceToken: string; errorCode: string; nowMs: number }): Promise<void> {
    return this.finish(input, "RETRYABLE", ["CLAIMED", "QUORUM_READY", "SIMULATED"]);
  }
  markFailed(input: { requestId: Hex; fenceToken: string; errorCode: string; nowMs: number }): Promise<void> {
    return this.finish(input, "FAILED", ["CLAIMED", "QUORUM_READY", "SIMULATED", "BROADCASTING"]);
  }
  markReconciliation(input: { requestId: Hex; fenceToken: string; errorCode: string; txHash?: Hex | null; nowMs: number }): Promise<void> {
    return this.cas(
      `UPDATE marketplace_campaign_resolution_relays
          SET status = 'RECONCILIATION_REQUIRED', base_tx_hash = COALESCE(base_tx_hash, $3),
              error_code = $4, fence_token = NULL, lease_expires_at = NULL, updated_at = $5
        WHERE request_id = $1 AND fence_token = $2
          AND status IN ('CLAIMED', 'QUORUM_READY', 'SIMULATED', 'BROADCASTING')`,
      [input.requestId, input.fenceToken, input.txHash ?? null, safeCode(input.errorCode), input.nowMs],
    );
  }

  private finish(input: { requestId: Hex; fenceToken: string; errorCode: string; nowMs: number }, status: "RETRYABLE" | "FAILED", allowed: string[]): Promise<void> {
    return this.cas(
      `UPDATE marketplace_campaign_resolution_relays
          SET status = $3, error_code = $4, fence_token = NULL, lease_expires_at = NULL, updated_at = $5
        WHERE request_id = $1 AND fence_token = $2 AND status = ANY($6::marketplace_campaign_relay_status[])`,
      [input.requestId, input.fenceToken, status, safeCode(input.errorCode), input.nowMs, allowed],
    );
  }
  private async cas(sql: string, values: unknown[]): Promise<void> {
    const result = await this.pool.query(sql, values);
    if (result.rowCount !== 1) throw staleFence();
  }
}

const CONTEXT_SQL = `
SELECT
  a.id AS application_id, a.campaign_id AS campaign_record_id,
  a.request_id, a.resolution_round, a.escrow_assignment_id,
  a.creator_wallet, a.identity_hash, a.agreement_hash,
  a.submission_hash, a.post_id_hash, a.x_post_id, a.creator_handle,
  a.genlayer_tx_hash, a.genlayer_result_outcome,
  c.escrow_campaign_id, c.brand_wallet, c.terms_document
FROM marketplace_applications a
JOIN marketplace_campaigns c ON c.id = a.campaign_id
WHERE a.request_id = $1
  AND a.status = 'ACCEPTED'
  AND a.genlayer_submitter_status = 'FINALIZED'
  AND a.genlayer_tx_hash IS NOT NULL
  AND a.genlayer_result_outcome IS NOT NULL
  AND a.resolution_request_tx_hash IS NOT NULL
  AND c.status = 'RESOLVING'
  AND c.funding_status = 'FUNDED'`;

const INSERT_JOB_SQL = `
INSERT INTO marketplace_campaign_resolution_relays (
  request_id, application_id, resolution_round, assignment_id,
  genlayer_tx_hash, expected_outcome, status, created_at, updated_at
) VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,$7)
ON CONFLICT (request_id) DO NOTHING`;

const TERMINAL_MIRROR_SQL = `
UPDATE marketplace_applications
   SET resolution_outcome = $2, resolution_evidence_hash = $3,
       resolution_tx_hash = $4, revision = revision + 1, updated_at = $5
 WHERE request_id = $1 AND genlayer_submitter_status = 'FINALIZED'
   AND resolution_tx_hash IS NULL
 RETURNING id`;

const UNDETERMINED_MIRROR_SQL = `
UPDATE marketplace_applications
   SET resolution_outcome = $2, resolution_evidence_hash = $3,
       resolution_tx_hash = $4,
       request_id = NULL, resolution_request_tx_hash = NULL, resolution_requested_at = NULL,
       genlayer_submitter_status = NULL, genlayer_tx_hash = NULL,
       genlayer_result_outcome = NULL, genlayer_lifecycle_status = NULL,
       genlayer_execution_result = NULL, genlayer_error_code = NULL,
       genlayer_submitted_at = NULL, genlayer_finalized_at = NULL,
       revision = revision + 1, updated_at = $5
 WHERE request_id = $1 AND genlayer_submitter_status = 'FINALIZED'
   AND resolution_tx_hash IS NULL
 RETURNING id`;

function contextRow(row: Record<string, unknown>, escrow: Address): ResolutionContext {
  const expectedHandle = short(row.creator_handle, "creator handle");
  if (!/^[a-z0-9_]{1,15}$/.test(expectedHandle)) invalidContext();
  const terms = row.terms_document;
  if (!terms || typeof terms !== "object" || Array.isArray(terms)) invalidContext();
  return Object.freeze({
    applicationId: short(row.application_id, "application ID"),
    campaignRecordId: short(row.campaign_record_id, "campaign record ID"),
    requestId: hash(row.request_id),
    resolutionRound: positiveNumber(row.resolution_round),
    assignmentId: positiveDecimal(row.escrow_assignment_id),
    campaignId: positiveDecimal(row.escrow_campaign_id),
    brand: address(row.brand_wallet),
    creator: address(row.creator_wallet),
    identityHash: hash(row.identity_hash),
    agreementHash: hash(row.agreement_hash),
    submissionHash: hash(row.submission_hash),
    postIdHash: hash(row.post_id_hash),
    xPostId: postId(row.x_post_id),
    expectedHandle,
    termsDocument: Object.freeze({ ...(terms as Record<string, unknown>) }),
    genlayerTxHash: hash(row.genlayer_tx_hash),
    expectedOutcome: outcome(row.genlayer_result_outcome),
  });
}

function jobRow(row: Record<string, unknown> | undefined): RelayJob {
  if (!row) throw new Error("Relay job is missing.");
  const signers = Array.isArray(row.signer_addresses) ? row.signer_addresses.map(address) : [];
  return Object.freeze({
    requestId: hash(row.request_id), applicationId: short(row.application_id, "application ID"),
    resolutionRound: positiveNumber(row.resolution_round), assignmentId: positiveDecimal(row.assignment_id),
    genlayerTxHash: hash(row.genlayer_tx_hash), expectedOutcome: outcome(row.expected_outcome),
    status: String(row.status) as RelayJob["status"], fenceToken: nullable(row.fence_token),
    leaseExpiresAt: nullableNumber(row.lease_expires_at), attemptCount: Number(row.attempt_count),
    quorumDigest: row.quorum_digest === null ? null : hash(row.quorum_digest), signerAddresses: Object.freeze(signers),
    baseTxHash: row.base_tx_hash === null ? null : hash(row.base_tx_hash), baseBlockNumber: nullable(row.base_block_number),
    errorCode: nullable(row.error_code),
  });
}

function assertJobContext(job: RelayJob, context: ResolutionContext): void {
  if (job.applicationId !== context.applicationId || job.resolutionRound !== context.resolutionRound || job.assignmentId !== context.assignmentId || job.genlayerTxHash !== context.genlayerTxHash || job.expectedOutcome !== context.expectedOutcome) throw new RelayProblem(409, "RELAY_BINDING_CHANGED", "The persisted relay job no longer matches the finalized campaign.");
}
function safeCode(value: string): string { return /^[A-Z0-9_]{1,64}$/.test(value) ? value : "RELAY_FAILED"; }
function staleFence(): RelayProblem { return new RelayProblem(409, "RELAY_FENCE_LOST", "The relay lease was lost; this invocation stopped."); }
function invalidContext(): never { throw new RelayProblem(409, "RESOLUTION_BINDING_INVALID", "The finalized marketplace record is incomplete."); }
function hash(value: unknown): Hex { if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) invalidContext(); return value.toLowerCase() as Hex; }
function address(value: unknown): Address { if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) invalidContext(); return getAddress(value); }
function short(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0 || value.length > 200) throw new RelayProblem(409, "RESOLUTION_BINDING_INVALID", `${label} is invalid.`); return value; }
function positiveDecimal(value: unknown): string { if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) invalidContext(); return value; }
function positiveNumber(value: unknown): number { const parsed = typeof value === "number" ? value : Number(value); if (!Number.isSafeInteger(parsed) || parsed <= 0) invalidContext(); return parsed; }
function nullableNumber(value: unknown): number | null { if (value === null) return null; const parsed = Number(value); if (!Number.isSafeInteger(parsed)) invalidContext(); return parsed; }
function nullable(value: unknown): string | null { if (value === null) return null; if (typeof value !== "string") invalidContext(); return value; }
function postId(value: unknown): string { const result = short(value, "post ID"); if (!/^[1-9][0-9]{5,24}$/.test(result)) invalidContext(); return result; }
function outcome(value: unknown): ResolutionOutcome { if (value !== "PASS" && value !== "FAIL" && value !== "UNDETERMINED") invalidContext(); return value; }
