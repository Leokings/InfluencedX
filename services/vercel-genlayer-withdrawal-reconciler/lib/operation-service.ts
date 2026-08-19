import { randomUUID } from "node:crypto";

import {
  CONFIRM_METHOD,
  MARKETPLACE_ADDRESS,
  MARKETPLACE_OWNER,
  MAX_CONFIRMATION_POLL_ATTEMPTS,
  PRECHECK_LEASE_MS,
  RECONCILER_NETWORK,
  STUDIONET_CHAIN_ID,
  TERMINAL_STATUSES,
  ZERO_VALUE_ATTO,
} from "./constants";
import { proofFingerprint } from "./envelope";
import { GateBusyError, PoisonMessageError, ReconcilerProblem } from "./problem";
import type { QueuePublisher } from "./queue-publisher";
import { assertConfirmedPostState, assertEmittedWithdrawal, assertProofBinding } from "./state";
import {
  confirmationBindingError,
  finalizedSuccessful,
  lifecycleStatus,
} from "./studionet-client";
import type {
  QueueMessage,
  Receipt,
  ReconciliationProjection,
  ReconciliationRecord,
  ReconciliationRepository,
  WithdrawalClient,
} from "./types";

const HASH = /^0x[0-9a-f]{64}$/;

export class ReconciliationService {
  constructor(
    private readonly repository: ReconciliationRepository,
    private readonly client: WithdrawalClient,
    private readonly queue: QueuePublisher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async process(message: QueueMessage, deliveryCount: number): Promise<void> {
    await this.repository.noteDelivery(message.withdrawalId, deliveryCount);
    const record = await this.repository.get(message.withdrawalId);
    if (!record) throw new PoisonMessageError(
      "RECONCILIATION_NOT_FOUND",
      "The queue message has no durable withdrawal reconciliation.",
      message.withdrawalId,
    );
    const boundaryError = recordBoundaryError(record, this.client.contractAddress, this.client.signerAddress);
    if (boundaryError) {
      await this.repository.markPoisoned(record.withdrawalId, boundaryError);
      return;
    }
    if (TERMINAL_STATUSES.has(record.status)) return;
    if (record.status === "BROADCASTING") {
      await this.repository.quarantineAmbiguousBroadcast(record.withdrawalId, "CRASH_DURING_BROADCAST_REQUIRES_RECONCILIATION");
      return;
    }
    if (record.status === "SUBMITTED" || record.status === "POLLING") {
      await this.poll(record);
      return;
    }
    await this.discoverAndSubmit(record);
  }

  private async discoverAndSubmit(record: ReconciliationRecord): Promise<void> {
    const nowEpoch = Math.floor(this.now().getTime() / 1_000);
    let withdrawal;
    try {
      withdrawal = await this.client.readWithdrawal(record.withdrawalId);
    } catch (error) {
      const code = sanitizedCode(error, "STUDIONET_STATE_UNAVAILABLE");
      if (!isTransient(code)) {
        await this.repository.requireManual(record.withdrawalId, code);
        return;
      }
      await this.wait(record, "WAITING_FOR_EMISSION", code);
      return;
    }
    if (!withdrawal || withdrawal.status === "PENDING") {
      await this.wait(record, "WAITING_FOR_EMISSION", withdrawal ? "WITHDRAWAL_NOT_EMITTED" : "WITHDRAWAL_NOT_FINALIZED");
      return;
    }
    if (withdrawal.status === "CONFIRMED") {
      await this.repository.requireManual(record.withdrawalId, "WITHDRAWAL_CONFIRMED_OUTSIDE_RECONCILER");
      return;
    }
    if (withdrawal.status === "RESTORED_FAILED") {
      await this.repository.requireManual(record.withdrawalId, "WITHDRAWAL_RESTORED_BY_GOVERNANCE");
      return;
    }
    try { assertEmittedWithdrawal(withdrawal); } catch (error) {
      await this.repository.requireManual(record.withdrawalId, sanitizedCode(error, "WITHDRAWAL_STATE_INVALID"));
      return;
    }

    let discovery;
    try {
      discovery = await this.client.discoverTransfer(withdrawal, nowEpoch);
    } catch (error) {
      const code = sanitizedCode(error, "STUDIONET_TRANSFER_DISCOVERY_UNAVAILABLE");
      if (!isTransient(code)) {
        await this.repository.requireManual(record.withdrawalId, code);
        return;
      }
      await this.wait(record, "WAITING_FOR_TRANSFER", code);
      return;
    }
    if (discovery.kind === "PENDING") {
      await this.wait(record, "WAITING_FOR_TRANSFER", discovery.code);
      return;
    }
    if (discovery.kind === "MANUAL") {
      await this.repository.requireManual(record.withdrawalId, discovery.code);
      return;
    }

    const claim = await this.repository.claimProof(record.withdrawalId, randomUUID(), PRECHECK_LEASE_MS);
    if (!claim) throw new GateBusyError();
    try {
      const [freshWithdrawal, counts] = await Promise.all([
        this.client.readWithdrawal(record.withdrawalId),
        this.client.readCounts(),
      ]);
      if (!freshWithdrawal) throw new Error("WITHDRAWAL_DISAPPEARED");
      assertProofBinding(freshWithdrawal, discovery.proof);
      const freshDiscovery = await this.client.discoverTransfer(freshWithdrawal, nowEpoch);
      if (freshDiscovery.kind !== "PROVEN" || proofFingerprint(freshDiscovery.proof) !== proofFingerprint(discovery.proof)) {
        throw new Error("TRANSFER_PROOF_CHANGED_DURING_PRECHECK");
      }
      await this.repository.recordProof(claim, freshWithdrawal, counts, freshDiscovery.proof, proofFingerprint(freshDiscovery.proof));
    } catch (error) {
      const code = sanitizedCode(error, "TRANSFER_PROOF_RECHECK_FAILED");
      await this.repository.releasePrecheck(claim, code);
      if (!isTransient(code)) {
        await this.repository.requireManual(record.withdrawalId, code);
      } else {
        const current = await this.repository.get(record.withdrawalId);
        await this.queue.discover(record.withdrawalId, (current?.discoveryAttempts ?? record.discoveryAttempts) + 1);
      }
      return;
    }

    if (!(await this.repository.beginBroadcast(claim))) throw new GateBusyError();
    let txHash: string;
    try {
      txHash = await this.client.submitConfirmation(record.withdrawalId, discovery.proof.evidenceHash);
    } catch {
      await this.repository.quarantineBroadcast(claim, "CONFIRMATION_BROADCAST_OUTCOME_UNKNOWN");
      return;
    }
    if (!HASH.test(txHash)) {
      await this.repository.quarantineBroadcast(claim, "CONFIRMATION_TRANSACTION_HASH_INVALID");
      return;
    }
    // If persistence fails after a hash is returned, let the queue retry. The
    // durable non-expiring BROADCASTING fence then forces manual quarantine.
    await this.repository.recordSubmitted(claim, txHash);
    await this.queue.poll(record.withdrawalId, 0);
  }

  private async poll(record: ReconciliationRecord): Promise<void> {
    if (!record.confirmationTxHash || !record.withdrawal || !record.countsBefore || !record.proof || !record.proofFingerprint) {
      await this.repository.requireManual(record.withdrawalId, "CONFIRMATION_BINDING_MISSING");
      return;
    }
    if (proofFingerprint(record.proof) !== record.proofFingerprint || record.evidenceHash !== record.proof.evidenceHash) {
      await this.repository.requireManual(record.withdrawalId, "TRANSFER_PROOF_INTEGRITY_MISMATCH");
      return;
    }
    const attempt = record.pollAttempts + 1;
    if (attempt > MAX_CONFIRMATION_POLL_ATTEMPTS) {
      await this.repository.recordPoll(record.withdrawalId, {
        status: "POLLING_EXHAUSTED",
        pollAttempts: attempt,
        errorCode: "CONFIRMATION_POLLING_EXHAUSTED",
        lastCheckedAt: this.now(),
      });
      return;
    }
    let receipt: Receipt;
    try {
      receipt = await this.client.getTransaction(record.confirmationTxHash);
    } catch {
      await this.repository.recordPoll(record.withdrawalId, {
        status: "POLLING",
        pollAttempts: attempt,
        errorCode: "STUDIONET_CONFIRMATION_POLL_UNAVAILABLE",
        lastCheckedAt: this.now(),
      });
      throw new ReconcilerProblem(503, "STUDIONET_CONFIRMATION_POLL_UNAVAILABLE", "StudioNet confirmation polling is unavailable.");
    }
    const bindingError = confirmationBindingError(receipt, {
      txHash: record.confirmationTxHash,
      signerAddress: this.client.signerAddress,
      contractAddress: this.client.contractAddress,
      withdrawalId: record.withdrawalId,
      evidenceHash: record.proof.evidenceHash,
    });
    if (bindingError) {
      await this.repository.requireManual(record.withdrawalId, bindingError);
      return;
    }
    const status = lifecycleStatus(receipt);
    const execution = executionResult(receipt);
    if (["CANCELED", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT"].includes(status)) {
      await this.repository.requireManual(record.withdrawalId, "CONFIRMATION_TRANSACTION_TERMINATED");
      return;
    }
    if (status !== "FINALIZED") {
      await this.repository.recordPoll(record.withdrawalId, {
        status: "POLLING",
        lifecycleStatus: status,
        executionResult: execution,
        pollAttempts: attempt,
        errorCode: null,
        lastCheckedAt: this.now(),
      });
      await this.queue.poll(record.withdrawalId, attempt);
      return;
    }
    if (!finalizedSuccessful(receipt)) {
      await this.repository.requireManual(record.withdrawalId, "CONFIRMATION_EXECUTION_FAILED");
      return;
    }
    try {
      const [withdrawalAfter, countsAfter] = await Promise.all([
        this.client.readWithdrawal(record.withdrawalId),
        this.client.readCounts(),
      ]);
      if (!withdrawalAfter) throw new Error("POST_WITHDRAWAL_MISSING");
      assertConfirmedPostState(record.withdrawal, record.countsBefore, record.proof, withdrawalAfter, countsAfter);
      await this.repository.recordPoll(record.withdrawalId, {
        status: "FINALIZED",
        lifecycleStatus: status,
        executionResult: execution,
        pollAttempts: attempt,
        errorCode: null,
        lastCheckedAt: this.now(),
        finalizedAt: this.now(),
      });
    } catch (error) {
      await this.repository.requireManual(record.withdrawalId, sanitizedCode(error, "CONFIRMATION_POST_STATE_MISMATCH"));
    }
  }

  private async wait(
    record: ReconciliationRecord,
    status: "WAITING_FOR_EMISSION" | "WAITING_FOR_TRANSFER",
    errorCode: string,
  ): Promise<void> {
    const updated = await this.repository.recordWaiting(record.withdrawalId, status, errorCode, this.now());
    await this.queue.discover(record.withdrawalId, updated.discoveryAttempts);
  }
}

export function project(record: ReconciliationRecord): ReconciliationProjection {
  const { requestFingerprint: _request, withdrawal: _withdrawal, countsBefore: _counts, proof: _proof, proofFingerprint: _fingerprint, ...projection } = record;
  return Object.freeze(projection);
}

function recordBoundaryError(record: ReconciliationRecord, contractAddress: string, signerAddress: string): string | null {
  if (record.network !== RECONCILER_NETWORK || record.chainId !== STUDIONET_CHAIN_ID) return "RECONCILIATION_NETWORK_MISMATCH";
  if (record.contractAddress !== MARKETPLACE_ADDRESS || record.contractAddress !== contractAddress) return "RECONCILIATION_CONTRACT_MISMATCH";
  if (record.contractOwner !== MARKETPLACE_OWNER || signerAddress !== MARKETPLACE_OWNER) return "RECONCILIATION_OWNER_MISMATCH";
  if (record.functionName !== CONFIRM_METHOD || record.valueAtto !== ZERO_VALUE_ATTO) return "RECONCILIATION_CALL_BOUNDARY_MISMATCH";
  return null;
}

function executionResult(receipt: Receipt): string | null {
  const consensus = receipt.consensus_data;
  if (!consensus || typeof consensus !== "object" || Array.isArray(consensus)) return null;
  const leaders = (consensus as Record<string, unknown>).leader_receipt;
  if (!Array.isArray(leaders)) return null;
  const leader = leaders.find((candidate) => candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).mode === "leader") as Record<string, unknown> | undefined;
  return typeof leader?.execution_result === "string" ? leader.execution_result : null;
}

function sanitizedCode(error: unknown, fallback: string): string {
  const candidate = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{2,100}$/.test(candidate) ? candidate : fallback;
}

function isTransient(code: string): boolean {
  return code === "STUDIONET_RPC_UNAVAILABLE" ||
    code === "STUDIONET_RPC_INVALID" ||
    code === "STUDIONET_STATE_UNAVAILABLE" ||
    code === "STUDIONET_TRANSFER_DISCOVERY_UNAVAILABLE";
}
