import { ZERO_HASH } from "./constants";
import { fingerprint } from "./envelope";
import type { MarketplaceCounts, TransferProof, WithdrawalState } from "./types";

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

export function parseWithdrawal(raw: unknown, expectedId: string): WithdrawalState | null {
  const row = asRecord(raw);
  if (!row || Object.keys(row).length === 0) return null;
  const withdrawalId = hash(row.withdrawal_id, "WITHDRAWAL_ID_INVALID");
  if (withdrawalId !== expectedId) throw new Error("WITHDRAWAL_ID_MISMATCH");
  const status = text(row.status, "WITHDRAWAL_STATUS_INVALID");
  if (!["PENDING", "EMITTED_UNCONFIRMED", "CONFIRMED", "RESTORED_FAILED"].includes(status)) {
    throw new Error("WITHDRAWAL_STATUS_INVALID");
  }
  return Object.freeze({
    withdrawalId,
    account: address(row.account, "WITHDRAWAL_ACCOUNT_INVALID"),
    nonce: safeInteger(row.nonce, "WITHDRAWAL_NONCE_INVALID"),
    amountAtto: amount(row.amount_atto, "WITHDRAWAL_AMOUNT_INVALID"),
    status: status as WithdrawalState["status"],
    requestedAtEpoch: safeInteger(row.requested_at_epoch, "WITHDRAWAL_REQUEST_TIME_INVALID"),
    emittedAtEpoch: safeInteger(row.emitted_at_epoch, "WITHDRAWAL_EMIT_TIME_INVALID"),
    reconciledAtEpoch: safeInteger(row.reconciled_at_epoch, "WITHDRAWAL_RECONCILE_TIME_INVALID"),
    evidenceHash: hash(row.evidence_hash, "WITHDRAWAL_EVIDENCE_INVALID"),
    recapitalizedAtto: amount(row.recapitalized_atto, "WITHDRAWAL_RECAPITALIZATION_INVALID"),
  });
}

export function parseCounts(raw: unknown): MarketplaceCounts {
  const row = requiredRecord(raw, "MARKETPLACE_COUNTS_INVALID");
  return Object.freeze({
    withdrawalCount: amount(row.withdrawal_count, "COUNTS_WITHDRAWALS_INVALID"),
    totalEscrowAtto: amount(row.total_escrow_atto, "COUNTS_ESCROW_INVALID"),
    totalClaimableAtto: amount(row.total_claimable_atto, "COUNTS_CLAIMABLE_INVALID"),
    totalPendingWithdrawalAtto: amount(row.total_pending_withdrawal_atto, "COUNTS_PENDING_INVALID"),
    totalEmittedUnconfirmedAtto: amount(row.total_emitted_unconfirmed_atto, "COUNTS_EMITTED_INVALID"),
    totalLiabilityAtto: amount(row.total_liability_atto, "COUNTS_LIABILITY_INVALID"),
    totalProtocolFeesAtto: amount(row.total_protocol_fees_atto, "COUNTS_FEES_INVALID"),
    totalWithdrawnAtto: amount(row.total_withdrawn_atto, "COUNTS_WITHDRAWN_INVALID"),
    totalRecapitalizedAtto: amount(row.total_recapitalized_atto, "COUNTS_RECAPITALIZED_INVALID"),
    contractBalanceAtto: amount(row.contract_balance_atto, "COUNTS_BALANCE_INVALID"),
  });
}

export function assertEmittedWithdrawal(withdrawal: WithdrawalState): void {
  if (withdrawal.status !== "EMITTED_UNCONFIRMED") throw new Error("WITHDRAWAL_NOT_EMITTED");
  if (BigInt(withdrawal.amountAtto) <= 0n) throw new Error("WITHDRAWAL_AMOUNT_INVALID");
  if (withdrawal.emittedAtEpoch <= 0 || withdrawal.emittedAtEpoch < withdrawal.requestedAtEpoch) {
    throw new Error("WITHDRAWAL_EMIT_TIME_INVALID");
  }
  if (withdrawal.reconciledAtEpoch !== 0 || withdrawal.evidenceHash !== ZERO_HASH) {
    throw new Error("WITHDRAWAL_ALREADY_RECONCILED");
  }
}

export function assertProofBinding(withdrawal: WithdrawalState, proof: TransferProof): void {
  assertEmittedWithdrawal(withdrawal);
  if (
    proof.withdrawalId !== withdrawal.withdrawalId ||
    proof.account !== withdrawal.account ||
    proof.amountAtto !== withdrawal.amountAtto ||
    proof.emittedAtEpoch !== withdrawal.emittedAtEpoch ||
    proof.valueCredited !== true ||
    !HASH.test(proof.evidenceHash) ||
    !HASH.test(proof.parentTxHash) ||
    !HASH.test(proof.childTxHash)
  ) throw new Error("TRANSFER_PROOF_BINDING_MISMATCH");
  const { evidenceHash, ...evidence } = proof;
  if (fingerprint(evidence) !== evidenceHash) throw new Error("TRANSFER_EVIDENCE_HASH_MISMATCH");
}

export function assertConfirmedPostState(
  before: WithdrawalState,
  countsBefore: MarketplaceCounts,
  proof: TransferProof,
  after: WithdrawalState,
  countsAfter: MarketplaceCounts,
): void {
  assertProofBinding(before, proof);
  for (const field of ["withdrawalId", "account", "nonce", "amountAtto", "requestedAtEpoch", "emittedAtEpoch", "recapitalizedAtto"] as const) {
    if (after[field] !== before[field]) throw new Error(`POST_WITHDRAWAL_${field.toUpperCase()}_CHANGED`);
  }
  if (after.status !== "CONFIRMED") throw new Error("POST_WITHDRAWAL_NOT_CONFIRMED");
  if (after.evidenceHash !== proof.evidenceHash) throw new Error("POST_EVIDENCE_HASH_MISMATCH");
  if (after.reconciledAtEpoch < before.emittedAtEpoch) throw new Error("POST_RECONCILED_TIME_INVALID");

  const withdrawalAmount = BigInt(before.amountAtto);
  exactDelta(countsBefore.totalEmittedUnconfirmedAtto, countsAfter.totalEmittedUnconfirmedAtto, -withdrawalAmount, "POST_EMITTED_TOTAL_MISMATCH");
  exactDelta(countsBefore.totalLiabilityAtto, countsAfter.totalLiabilityAtto, -withdrawalAmount, "POST_LIABILITY_TOTAL_MISMATCH");
  exactDelta(countsBefore.totalWithdrawnAtto, countsAfter.totalWithdrawnAtto, withdrawalAmount, "POST_WITHDRAWN_TOTAL_MISMATCH");
  for (const field of [
    "withdrawalCount", "totalEscrowAtto", "totalClaimableAtto", "totalPendingWithdrawalAtto",
    "totalProtocolFeesAtto", "totalRecapitalizedAtto", "contractBalanceAtto",
  ] as const) {
    if (countsAfter[field] !== countsBefore[field]) throw new Error(`POST_COUNTS_${field.toUpperCase()}_CHANGED`);
  }
}

function exactDelta(before: string, after: string, delta: bigint, code: string): void {
  if (BigInt(after) !== BigInt(before) + delta) throw new Error(code);
}

function hash(value: unknown, code: string): string {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (!HASH.test(normalized)) throw new Error(code);
  return normalized;
}

function address(value: unknown, code: string): string {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (!ADDRESS.test(normalized) || /^0x0{40}$/.test(normalized)) throw new Error(code);
  return normalized;
}

function amount(value: unknown, code: string): string {
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) return value;
  throw new Error(code);
}

function safeInteger(value: unknown, code: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}

function requiredRecord(value: unknown, code: string): Record<string, unknown> {
  const row = asRecord(value);
  if (!row) throw new Error(code);
  return row;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
