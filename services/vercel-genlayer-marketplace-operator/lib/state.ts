import { createHash } from "node:crypto";

import {
  EXPIRE_ASSIGNMENT,
  FINALIZE_CAMPAIGN,
  RESOLVE_ASSIGNMENT,
} from "./constants";
import type { OperationEnvelope, StateSnapshot } from "./types";

const HASH = /^0x[0-9a-f]{64}$/;
const UNDETERMINED_REFUND_DELAY_SECONDS = 24 * 60 * 60;

export function assertPreState(
  envelope: OperationEnvelope,
  state: StateSnapshot,
  nowEpoch = Math.floor(Date.now() / 1_000),
): void {
  if (state.action !== envelope.action) throw new Error("PRE_STATE_ACTION_MISMATCH");
  if (envelope.action === FINALIZE_CAMPAIGN) {
    const campaign = required(state.campaign, "PRE_STATE_CAMPAIGN_MISSING");
    exactHash(campaign.campaign_id, envelope.args[0], "PRE_STATE_CAMPAIGN_ID_MISMATCH");
    if (campaign.status !== "OPEN") throw new Error("PRE_STATE_CAMPAIGN_NOT_OPEN");
    if (amount(campaign.reserved_atto) !== 0n) throw new Error("PRE_STATE_CAMPAIGN_RESERVED");
    const finalizableAt = integer(campaign.submission_deadline_epoch)
      + integer(campaign.retention_seconds)
      + UNDETERMINED_REFUND_DELAY_SECONDS;
    if (nowEpoch < finalizableAt) throw new Error("PRE_STATE_FINALIZE_EARLY");
    return;
  }

  const assignment = required(state.assignment, "PRE_STATE_ASSIGNMENT_MISSING");
  exactHash(assignment.assignment_id, envelope.args[0], "PRE_STATE_ASSIGNMENT_ID_MISMATCH");
  const campaign = required(state.campaign, "PRE_STATE_CAMPAIGN_MISSING");
  exactHash(campaign.campaign_id, assignment.campaign_id, "PRE_STATE_CAMPAIGN_ID_MISMATCH");

  if (envelope.action === RESOLVE_ASSIGNMENT) {
    if (assignment.status !== "SUBMITTED" && assignment.status !== "UNDETERMINED") {
      throw new Error("PRE_STATE_ASSIGNMENT_NOT_RESOLVABLE");
    }
    exactHash(assignment.resolution_request_id, envelope.args[1], "PRE_STATE_REQUEST_ID_MISMATCH");
    if (nowEpoch < integer(assignment.resolution_eligible_at_epoch)) throw new Error("PRE_STATE_RETENTION_ACTIVE");
    if (
      assignment.status === "UNDETERMINED" &&
      integer(assignment.resolution_attempts) >= integer(campaign.max_undetermined_retries)
    ) throw new Error("PRE_STATE_RETRIES_EXHAUSTED");
    return;
  }

  if (assignment.status === "SELECTED") {
    if (nowEpoch <= integer(assignment.acceptance_deadline_epoch)) throw new Error("PRE_STATE_EXPIRY_EARLY");
    return;
  }
  if (assignment.status === "ACCEPTED") {
    if (nowEpoch <= integer(campaign.submission_deadline_epoch)) throw new Error("PRE_STATE_EXPIRY_EARLY");
    return;
  }
  throw new Error("PRE_STATE_ASSIGNMENT_NOT_EXPIRABLE");
}

export function assertPostState(
  envelope: OperationEnvelope,
  before: StateSnapshot,
  after: StateSnapshot,
): void {
  if (before.action !== envelope.action || after.action !== envelope.action) {
    throw new Error("POST_STATE_ACTION_MISMATCH");
  }
  if (envelope.action === FINALIZE_CAMPAIGN) {
    const oldCampaign = required(before.campaign, "PRE_STATE_CAMPAIGN_MISSING");
    const newCampaign = required(after.campaign, "POST_STATE_CAMPAIGN_MISSING");
    stableCampaign(oldCampaign, newCampaign);
    assertCampaignAccounting(newCampaign);
    if (newCampaign.status !== "CLOSED") throw new Error("POST_STATE_CAMPAIGN_NOT_CLOSED");
    if (amount(newCampaign.available_atto) !== 0n || amount(newCampaign.reserved_atto) !== 0n) {
      throw new Error("POST_STATE_CAMPAIGN_BALANCE_MISMATCH");
    }
    if (
      amount(newCampaign.brand_refunded_atto) !==
      amount(oldCampaign.brand_refunded_atto) + amount(oldCampaign.available_atto)
    ) throw new Error("POST_STATE_REFUND_MISMATCH");
    return;
  }

  const oldAssignment = required(before.assignment, "PRE_STATE_ASSIGNMENT_MISSING");
  const newAssignment = required(after.assignment, "POST_STATE_ASSIGNMENT_MISSING");
  const oldCampaign = required(before.campaign, "PRE_STATE_CAMPAIGN_MISSING");
  const newCampaign = required(after.campaign, "POST_STATE_CAMPAIGN_MISSING");
  stableAssignment(oldAssignment, newAssignment);
  stableCampaign(oldCampaign, newCampaign);
  assertCampaignAccounting(newCampaign);

  if (envelope.action === RESOLVE_ASSIGNMENT) {
    if (integer(newAssignment.resolution_attempts) !== integer(oldAssignment.resolution_attempts) + 1) {
      throw new Error("POST_STATE_RESOLUTION_ATTEMPT_MISMATCH");
    }
    if (newAssignment.status === "RESOLVING") {
      if (
        newAssignment.resolution_pending !== true ||
        newAssignment.resolution_pending_request_id !== oldAssignment.resolution_request_id ||
        integer(newAssignment.resolution_pending_round) !== integer(oldAssignment.resolution_round) ||
        integer(newAssignment.resolution_pending_started_at_epoch) !==
          integer(newAssignment.last_resolution_at_epoch) ||
        integer(newAssignment.last_resolution_at_epoch) <=
          integer(oldAssignment.last_resolution_at_epoch) ||
        newAssignment.resolution_request_id !== oldAssignment.resolution_request_id ||
        integer(newAssignment.resolution_round) !== integer(oldAssignment.resolution_round) ||
        newAssignment.outcome !== oldAssignment.outcome ||
        newAssignment.evidence_hash !== oldAssignment.evidence_hash ||
        amount(newAssignment.creator_credit_atto) !== amount(oldAssignment.creator_credit_atto) ||
        amount(newAssignment.brand_credit_atto) !== amount(oldAssignment.brand_credit_atto) ||
        amount(newAssignment.fee_atto) !== amount(oldAssignment.fee_atto) ||
        amount(newCampaign.available_atto) !== amount(oldCampaign.available_atto) ||
        amount(newCampaign.reserved_atto) !== amount(oldCampaign.reserved_atto) ||
        amount(newCampaign.settled_atto) !== amount(oldCampaign.settled_atto) ||
        amount(newCampaign.creator_paid_atto) !== amount(oldCampaign.creator_paid_atto) ||
        amount(newCampaign.brand_refunded_atto) !== amount(oldCampaign.brand_refunded_atto) ||
        amount(newCampaign.fee_atto) !== amount(oldCampaign.fee_atto)
      ) throw new Error("POST_STATE_RESOLUTION_PENDING_MISMATCH");
      return;
    }
    if (newAssignment.status === "UNDETERMINED") {
      if (newAssignment.outcome !== "UNDETERMINED") throw new Error("POST_STATE_OUTCOME_MISMATCH");
      const nextRound = integer(oldAssignment.resolution_round) + 1;
      if (integer(newAssignment.resolution_round) !== nextRound) throw new Error("POST_STATE_ROUND_MISMATCH");
      const expected = resolutionRequestId(newAssignment, nextRound);
      exactHash(newAssignment.resolution_request_id, expected, "POST_STATE_REQUEST_ID_MISMATCH");
      atMost(
        newCampaign.reserved_atto,
        oldCampaign.reserved_atto,
        "POST_STATE_RESERVATION_INCREASED",
      );
      return;
    }
    const passed = newAssignment.status === "SETTLED_PASS" && newAssignment.outcome === "PASS";
    const failed = newAssignment.status === "SETTLED_FAIL" && newAssignment.outcome === "FAIL";
    if (!passed && !failed) throw new Error("POST_STATE_RESOLUTION_NOT_SETTLED");
    assertSettlementAccounting(oldAssignment, newAssignment, oldCampaign, newCampaign, passed);
    return;
  }

  if (oldAssignment.status === "SELECTED") {
    if (newAssignment.status !== "EXPIRED") throw new Error("POST_STATE_ASSIGNMENT_NOT_EXPIRED");
    // A still-open selection window can reserve another creator between this
    // operation's pre-state read and its finalized post-state read. The exact
    // finalized receipt binds this expiration; campaign conservation and the
    // target assignment transition are the concurrency-safe invariants here.
    return;
  }
  if (oldAssignment.status === "ACCEPTED") {
    if (newAssignment.status !== "SETTLED_FAIL" || newAssignment.outcome !== "FAIL") {
      throw new Error("POST_STATE_EXPIRY_NOT_REFUNDED");
    }
    assertSettlementAccounting(oldAssignment, newAssignment, oldCampaign, newCampaign, false);
    return;
  }
  throw new Error("POST_STATE_UNEXPECTED_PRE_STATE");
}

function assertSettlementAccounting(
  oldAssignment: Record<string, unknown>,
  newAssignment: Record<string, unknown>,
  oldCampaign: Record<string, unknown>,
  newCampaign: Record<string, unknown>,
  passed: boolean,
): void {
  const rate = amount(oldAssignment.agreed_rate_atto);
  atMost(
    newCampaign.reserved_atto,
    amount(oldCampaign.reserved_atto) - rate,
    "POST_STATE_RESERVATION_MISMATCH",
  );
  atLeast(
    newCampaign.settled_atto,
    amount(oldCampaign.settled_atto) + rate,
    "POST_STATE_SETTLED_AMOUNT_MISMATCH",
  );
  if (passed) {
    const creator = amount(newAssignment.creator_credit_atto);
    const fee = amount(newAssignment.fee_atto);
    if (creator + fee !== rate) throw new Error("POST_STATE_CREATOR_CREDIT_MISMATCH");
    atLeast(
      newCampaign.creator_paid_atto,
      amount(oldCampaign.creator_paid_atto) + creator,
      "POST_STATE_CREATOR_PAID_MISMATCH",
    );
    atLeast(
      newCampaign.fee_atto,
      amount(oldCampaign.fee_atto) + fee,
      "POST_STATE_FEE_MISMATCH",
    );
  } else {
    if (amount(newAssignment.brand_credit_atto) !== rate) throw new Error("POST_STATE_BRAND_CREDIT_MISMATCH");
    atLeast(
      newCampaign.brand_refunded_atto,
      amount(oldCampaign.brand_refunded_atto) + rate,
      "POST_STATE_BRAND_REFUND_MISMATCH",
    );
  }
}

function assertCampaignAccounting(campaign: Record<string, unknown>): void {
  const distributed = amount(campaign.creator_paid_atto)
    + amount(campaign.brand_refunded_atto)
    + amount(campaign.fee_atto);
  if (
    amount(campaign.available_atto) + amount(campaign.reserved_atto) + distributed !==
    amount(campaign.budget_atto)
  ) {
    throw new Error("POST_STATE_CAMPAIGN_ACCOUNTING_MISMATCH");
  }
}

function stableAssignment(before: Record<string, unknown>, after: Record<string, unknown>): void {
  for (const field of [
    "assignment_id", "campaign_id", "brand", "creator", "content_source",
    "creator_handle", "creator_external_user_id", "creator_identity_hash",
    "application_id", "agreement_hash", "agreed_rate_atto", "post_id", "submission_hash",
  ]) {
    if (String(before[field]) !== String(after[field])) throw new Error(`POST_STATE_ASSIGNMENT_${field.toUpperCase()}_CHANGED`);
  }
}

function stableCampaign(before: Record<string, unknown>, after: Record<string, unknown>): void {
  for (const field of [
    "campaign_id", "brand", "content_source", "terms_hash", "budget_atto", "fee_bps", "treasury",
    "application_deadline_epoch", "selection_deadline_epoch", "submission_deadline_epoch",
    "retention_seconds", "max_undetermined_retries",
  ]) {
    if (String(before[field]) !== String(after[field])) throw new Error(`POST_STATE_CAMPAIGN_${field.toUpperCase()}_CHANGED`);
  }
}

function resolutionRequestId(assignment: Record<string, unknown>, round: number): string {
  const fields = [
    "influencedx-resolution-v2",
    assignment.assignment_id,
    assignment.agreement_hash,
    assignment.submission_hash,
    assignment.content_source,
    assignment.post_id,
    round,
  ];
  return `0x${createHash("sha256").update(fields.join("|")).digest("hex")}`;
}

function required(value: Record<string, unknown> | null, code: string): Record<string, unknown> {
  if (!value) throw new Error(code);
  return value;
}

function exactHash(value: unknown, expected: unknown, code: string): void {
  if (typeof value !== "string" || !HASH.test(value) || value !== expected) throw new Error(code);
}

function integer(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("STATE_INTEGER_INVALID");
  return parsed;
}

function amount(value: unknown): bigint {
  if (
    !(
      typeof value === "bigint" ||
      (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
      (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value))
    )
  ) throw new Error("STATE_AMOUNT_INVALID");
  const parsed = BigInt(value as bigint | number | string);
  if (parsed < 0n) throw new Error("STATE_AMOUNT_INVALID");
  return parsed;
}

function atMost(actual: unknown, ceiling: unknown, code: string): void {
  if (amount(actual) > amount(ceiling)) throw new Error(code);
}

function atLeast(actual: unknown, floor: unknown, code: string): void {
  if (amount(actual) < amount(floor)) throw new Error(code);
}
