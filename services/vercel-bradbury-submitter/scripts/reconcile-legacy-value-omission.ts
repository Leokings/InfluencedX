import pg from "pg";
import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionHashVariant, type TransactionHash } from "genlayer-js/types";

import {
  BRADBURY_RPC_URL,
  PINNED_BRADBURY_RESOLVER,
  SIGNER_GATE,
} from "../lib/constants";
import {
  inspectLegacyValueOmission,
  LEGACY_VALUE_OMISSION_ERROR,
} from "../lib/operator-reconciliation";
import { closeRepositoryPools, repositoryFor } from "../lib/postgres-repository";
import type { BradburyReader } from "../lib/types";

const REQUEST_ID = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const databaseUrl = required("DATABASE_URL");
const requestId = required("XPROOF_RECONCILE_REQUEST_ID").toLowerCase();
const signerAddress = required("XPROOF_RECONCILE_SIGNER_ADDRESS").toLowerCase();
if (!REQUEST_ID.test(requestId)) throw new Error("XPROOF_RECONCILE_REQUEST_ID is invalid.");
if (!ADDRESS.test(signerAddress)) throw new Error("XPROOF_RECONCILE_SIGNER_ADDRESS is invalid.");

const sdk = createClient({ chain: testnetBradbury, endpoint: BRADBURY_RPC_URL });
const reader: BradburyReader = Object.freeze({
  signerAddress,
  async getTransaction(txHash: string) {
    return await sdk.getTransaction({ hash: txHash as TransactionHash }) as Record<string, unknown>;
  },
  async readFinalResult(boundRequestId: string) {
    const raw = await sdk.readContract({
      address: PINNED_BRADBURY_RESOLVER,
      functionName: "get_result",
      args: [boundRequestId],
      transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
    });
    if (raw === "") return null;
    if (typeof raw !== "string") throw new Error("Resolver result is not a string.");
    return JSON.parse(raw) as unknown;
  },
});

const repository = repositoryFor(databaseUrl);
const record = await repository.get(requestId);
if (!record) throw new Error("The reconciliation request does not exist.");
const observation = await inspectLegacyValueOmission(record, reader);

const publicObservation = {
  requestId,
  txHash: record.txHash,
  observedState: observation.state,
  lifecycleStatus: observation.lifecycleStatus,
  executionResult: observation.executionResult,
  resultOutcome: observation.resultOutcome,
} as const;
const applyConfirmation = `APPLY ${requestId} ${record.txHash} ${observation.state}`;

try {
  reconciliation: {
    if (observation.state === "PENDING") {
      process.stdout.write(`${JSON.stringify({ ...publicObservation, applied: false })}\n`);
      break reconciliation;
    }

    if (process.env.XPROOF_RECONCILE_CONFIRM !== applyConfirmation) {
      process.stdout.write(`${JSON.stringify({
        ...publicObservation,
        applied: false,
        readyToApply: true,
        requiredConfirmation: applyConfirmation,
      })}\n`);
      break reconciliation;
    }

    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const gate = await client.query(
    `SELECT active_request_id, phase
     FROM xproof_bradbury_signer_gate
     WHERE gate_name = $1
     FOR UPDATE`,
    [SIGNER_GATE],
  );
      if (gate.rowCount !== 1 || gate.rows[0].active_request_id !== null) {
        throw new Error("The signer gate is not empty; reconciliation refused without unlocking it.");
      }

      const current = await client.query(
    `SELECT s.status, s.error_code, s.tx_hash, j.call_fingerprint
     FROM xproof_bradbury_submission_status s
     JOIN xproof_bradbury_submission_jobs j USING (request_id)
     WHERE s.request_id = $1
     FOR UPDATE OF s, j`,
    [requestId],
  );
      if (
        current.rowCount !== 1 ||
        current.rows[0].status !== "RECONCILIATION_REQUIRED" ||
        current.rows[0].error_code !== LEGACY_VALUE_OMISSION_ERROR ||
        current.rows[0].tx_hash?.toLowerCase() !== record.txHash?.toLowerCase() ||
        current.rows[0].call_fingerprint !== record.callFingerprint
      ) {
        throw new Error("The durable submission changed after inspection; reconciliation refused.");
      }

      const now = new Date();
      const nowMs = now.getTime();
      const terminalStatus = observation.state;
      const finalizedAt = terminalStatus === "NETWORK_TERMINATED" ? null : now;
      const updatedStatus = await client.query(
    `UPDATE xproof_bradbury_submission_status
     SET status = $2, lifecycle_status = $3, execution_result = $4,
         result_outcome = $5, poll_attempts = poll_attempts + 1,
         error_code = $6, last_polled_at = $7, finalized_at = $8,
         updated_at = clock_timestamp()
     WHERE request_id = $1
       AND status = 'RECONCILIATION_REQUIRED'
       AND error_code = $9
       AND tx_hash = $10`,
    [
      requestId,
      terminalStatus,
      observation.lifecycleStatus,
      observation.executionResult,
      observation.resultOutcome,
      observation.errorCode,
      now,
      finalizedAt,
      LEGACY_VALUE_OMISSION_ERROR,
      record.txHash,
    ],
  );
      if (updatedStatus.rowCount !== 1) throw new Error("The durable status update did not match exactly one row.");

      const updatedRequest = await client.query(
    `UPDATE verification_requests
     SET submission_status = $2,
         submission_status_updated_at = $3,
         submission_response_updated_at = $3,
         genlayer_tx_hash = $4,
         genlayer_outcome = $5,
         genlayer_error_code = $6,
         genlayer_last_polled_at = $3,
         genlayer_finalized_at = $7,
         revision = revision + 1,
         updated_at = $3
     WHERE finalized_request_id = $1
       AND submission_status = 'RECONCILIATION_REQUIRED'
       AND genlayer_error_code = $8
       AND lower(genlayer_tx_hash) = lower($4)`,
    [
      requestId,
      terminalStatus,
      nowMs,
      record.txHash,
      observation.resultOutcome,
      observation.errorCode,
      finalizedAt?.getTime() ?? null,
      LEGACY_VALUE_OMISSION_ERROR,
    ],
  );
      if (updatedRequest.rowCount !== 1) throw new Error("The owning verification request did not match exactly one row.");

      await client.query("COMMIT");
      process.stdout.write(`${JSON.stringify({ ...publicObservation, applied: true })}\n`);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }
} finally {
  await closeRepositoryPools();
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
