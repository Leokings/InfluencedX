import type { OperatorConfig } from "../lib/config";
import {
  MARKETPLACE_ADDRESS,
  MARKETPLACE_RPC_ADDRESS,
  OPERATOR_NETWORK,
  PRECHECK_LEASE_MS,
  STUDIONET_CHAIN_ID,
  STUDIONET_RPC_URL,
} from "../lib/constants";
import { validateOperationRequest } from "../lib/envelope";
import { OperatorProblem } from "../lib/problem";
import type { QueuePublisher } from "../lib/queue-publisher";
import type {
  MarketplaceClient,
  OperationEnvelope,
  OperationProjection,
  OperationRecord,
  OperatorRepository,
  PollPatch,
  Receipt,
  SignerClaim,
  StateSnapshot,
} from "../lib/types";

export const NOW_EPOCH = 1_786_233_600;
export const CONTRACT = MARKETPLACE_ADDRESS as `0x${string}`;
export const SIGNER = `0x${"34".repeat(20)}`;
export const ASSIGNMENT_ID = `0x${"56".repeat(32)}`;
export const REQUEST_ID = `0x${"78".repeat(32)}`;
export const CAMPAIGN_ID = `0x${"9a".repeat(32)}`;
export const TX_HASH = `0x${"bc".repeat(32)}`;

export function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    INFLUENCEDX_MARKETPLACE_OPERATOR_ENABLED: "true",
    INFLUENCEDX_MARKETPLACE_OPERATOR_STAGE: "studionet",
    INFLUENCEDX_GENLAYER_NETWORK: "studionet",
    INFLUENCEDX_GENLAYER_CHAIN_ID: String(STUDIONET_CHAIN_ID),
    INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS: CONTRACT,
    INFLUENCEDX_GENLAYER_MARKETPLACE_PROTOCOL: "INFLUENCEDX_MARKETPLACE_V2",
    INFLUENCEDX_GENLAYER_MARKETPLACE_SCHEMA_VERSION: "2",
    GENLAYER_MARKETPLACE_OPERATOR_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    DATABASE_URL: "postgresql://example.invalid/influencedx",
    INFLUENCEDX_OPERATOR_SERVICE_TOKEN: "aa".repeat(32),
    INFLUENCEDX_OPERATOR_CALLER_TEAM_SLUG: "leokings588-5902s-projects",
    INFLUENCEDX_OPERATOR_CALLER_TEAM_ID: "team_exact",
    INFLUENCEDX_OPERATOR_CALLER_PROJECT_NAME: "influencedx",
    INFLUENCEDX_OPERATOR_CALLER_PROJECT_ID: "prj_exact",
    INFLUENCEDX_OPERATOR_CALLER_ENVIRONMENT: "preview",
    ...overrides,
  };
}

export function configFixture(): OperatorConfig {
  return {
    enabled: true,
    stage: "studionet",
    network: "studionet",
    chainId: STUDIONET_CHAIN_ID,
    rpcUrl: STUDIONET_RPC_URL,
    contractAddress: CONTRACT,
    rpcContractAddress: MARKETPLACE_RPC_ADDRESS,
    contractProtocol: "INFLUENCEDX_MARKETPLACE_V2",
    contractSchemaVersion: 2,
    privateKey: `0x${"11".repeat(32)}`,
    databaseUrl: "postgresql://example.invalid/influencedx",
    serviceToken: "aa".repeat(32),
    caller: {
      teamSlug: "leokings588-5902s-projects",
      teamId: "team_exact",
      projectName: "influencedx",
      projectId: "prj_exact",
      environment: "preview",
    },
  };
}

export function resolveEnvelope(): OperationEnvelope {
  return validateOperationRequest({
    schemaVersion: 1,
    action: "resolve_assignment",
    assignmentId: ASSIGNMENT_ID,
    requestId: REQUEST_ID,
  }, configFixture());
}

export function expireEnvelope(): OperationEnvelope {
  return validateOperationRequest({
    schemaVersion: 1,
    action: "expire_assignment",
    assignmentId: ASSIGNMENT_ID,
  }, configFixture());
}

export function finalizeEnvelope(): OperationEnvelope {
  return validateOperationRequest({
    schemaVersion: 1,
    action: "finalize_campaign",
    campaignId: CAMPAIGN_ID,
  }, configFixture());
}

export function resolvePreState(): StateSnapshot {
  return {
    action: "resolve_assignment",
    assignment: assignment({
      status: "SUBMITTED",
      resolution_request_id: REQUEST_ID,
      resolution_eligible_at_epoch: NOW_EPOCH - 1,
    }),
    campaign: campaign(),
  };
}

export function resolvePassState(): StateSnapshot {
  return {
    action: "resolve_assignment",
    assignment: assignment({
      status: "SETTLED_PASS",
      resolution_request_id: REQUEST_ID,
      resolution_eligible_at_epoch: NOW_EPOCH - 1,
      resolution_attempts: 1,
      outcome: "PASS",
      creator_credit_atto: "90",
      fee_atto: "10",
    }),
    campaign: campaign({
      reserved_atto: "0",
      settled_atto: "100",
      creator_paid_atto: "90",
      fee_atto: "10",
    }),
  };
}

export function expirePreState(): StateSnapshot {
  return {
    action: "expire_assignment",
    assignment: assignment({
      status: "SELECTED",
      acceptance_deadline_epoch: NOW_EPOCH - 1,
      post_id: "",
      submission_hash: `0x${"0".repeat(64)}`,
    }),
    campaign: campaign(),
  };
}

export function expirePostState(): StateSnapshot {
  return {
    action: "expire_assignment",
    assignment: assignment({
      status: "EXPIRED",
      acceptance_deadline_epoch: NOW_EPOCH - 1,
      post_id: "",
      submission_hash: `0x${"0".repeat(64)}`,
    }),
    campaign: campaign({ reserved_atto: "0", available_atto: "1000" }),
  };
}

export function finalizePreState(): StateSnapshot {
  return {
    action: "finalize_campaign",
    assignment: null,
    campaign: campaign({
      available_atto: "500",
      reserved_atto: "0",
      creator_paid_atto: "450",
      fee_atto: "50",
      submission_deadline_epoch: NOW_EPOCH - 90_000,
      retention_seconds: 60,
    }),
  };
}

export function finalizePostState(): StateSnapshot {
  return {
    action: "finalize_campaign",
    assignment: null,
    campaign: campaign({
      status: "CLOSED",
      available_atto: "0",
      reserved_atto: "0",
      brand_refunded_atto: "500",
      creator_paid_atto: "450",
      fee_atto: "50",
      submission_deadline_epoch: NOW_EPOCH - 90_000,
      retention_seconds: 60,
    }),
  };
}

function assignment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assignment_id: ASSIGNMENT_ID,
    campaign_id: CAMPAIGN_ID,
    brand: `0x${"cd".repeat(20)}`,
    creator: `0x${"ef".repeat(20)}`,
    content_source: "X",
    creator_handle: "creator",
    creator_external_user_id: "2244994945",
    creator_identity_hash: `0x${"10".repeat(32)}`,
    application_id: `0x${"11".repeat(32)}`,
    agreement_hash: `0x${"22".repeat(32)}`,
    agreed_rate_atto: "100",
    status: "SUBMITTED",
    selected_at_epoch: NOW_EPOCH - 10_000,
    acceptance_deadline_epoch: NOW_EPOCH - 5_000,
    accepted_at_epoch: NOW_EPOCH - 4_000,
    post_id: "1999999999999999999",
    submission_hash: `0x${"33".repeat(32)}`,
    resolution_request_id: REQUEST_ID,
    resolution_round: 0,
    resolution_attempts: 0,
    resolution_eligible_at_epoch: NOW_EPOCH - 1,
    last_resolution_at_epoch: 0,
    outcome: "",
    creator_credit_atto: "0",
    brand_credit_atto: "0",
    fee_atto: "0",
    ...overrides,
  };
}

function campaign(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaign_id: CAMPAIGN_ID,
    brand: `0x${"cd".repeat(20)}`,
    content_source: "X",
    terms_hash: `0x${"44".repeat(32)}`,
    budget_atto: "1000",
    fee_bps: 1000,
    treasury: `0x${"ab".repeat(20)}`,
    status: "OPEN",
    application_deadline_epoch: NOW_EPOCH - 10_000,
    selection_deadline_epoch: NOW_EPOCH - 8_000,
    submission_deadline_epoch: NOW_EPOCH + 10_000,
    retention_seconds: 60,
    max_undetermined_retries: 3,
    available_atto: "900",
    reserved_atto: "100",
    settled_atto: "0",
    creator_paid_atto: "0",
    brand_refunded_atto: "0",
    fee_atto: "0",
    ...overrides,
  };
}

export class FakeQueue implements QueuePublisher {
  submits: Array<{ operationId: string; generation: number }> = [];
  polls: Array<{ operationId: string; attempt: number }> = [];
  async submit(operationId: string, generation: number) {
    this.submits.push({ operationId, generation });
    return `message-${this.submits.length}`;
  }
  async poll(operationId: string, attempt: number) {
    this.polls.push({ operationId, attempt });
    return `poll-${this.polls.length}`;
  }
}

export class FakeClient implements MarketplaceClient {
  readonly signerAddress = SIGNER;
  contractAddress = CONTRACT;
  preState: StateSnapshot = resolvePreState();
  finalState: StateSnapshot = resolvePassState();
  receipt: Receipt = {};
  readError: Error | null = null;
  submitError: Error | null = null;
  submitBarrier: Promise<void> | null = null;
  submitCalls = 0;
  activeSubmits = 0;
  maxActiveSubmits = 0;
  async readState(_envelope: OperationEnvelope, finalized: boolean) {
    if (this.readError) throw this.readError;
    return finalized ? this.finalState : this.preState;
  }
  async submit() {
    this.submitCalls += 1;
    this.activeSubmits += 1;
    this.maxActiveSubmits = Math.max(this.maxActiveSubmits, this.activeSubmits);
    try {
      if (this.submitBarrier) await this.submitBarrier;
      if (this.submitError) throw this.submitError;
      return TX_HASH;
    } finally {
      this.activeSubmits -= 1;
    }
  }
  async getTransaction() { return this.receipt; }
}

export function finalizedReceipt(envelope: OperationEnvelope, overrides: Receipt = {}): Receipt {
  return {
    hash: TX_HASH,
    sender: SIGNER,
    recipient: CONTRACT,
    rawValueAtto: "0",
    status_name: "FINALIZED",
    result_name: "MAJORITY_AGREE",
    consensus_data: {
      leader_receipt: [
        { mode: "leader", execution_result: "SUCCESS", result: { status: "return" } },
        { mode: "validator", execution_result: "SUCCESS", result: { status: "return" } },
      ],
    },
    tx_data_decoded: { call_data: { method: envelope.action, args: [...envelope.args] } },
    ...overrides,
  };
}

export class MemoryRepository implements OperatorRepository {
  readonly records = new Map<string, OperationRecord>();
  failRecordSubmitted = false;
  private gate: {
    token: bigint;
    holderId: string | null;
    operationId: string | null;
    phase: "PRECHECKING" | "BROADCASTING" | null;
    expiresAt: number | null;
  } = { token: 0n, holderId: null, operationId: null, phase: null, expiresAt: null };

  async createOrReplay(envelope: OperationEnvelope, envelopeFingerprint: string, callFingerprint: string) {
    const existing = this.records.get(envelope.operationId);
    if (existing) {
      if (existing.envelopeFingerprint !== envelopeFingerprint || existing.callFingerprint !== callFingerprint) {
        throw new OperatorProblem(409, "OPERATION_ID_COLLISION", "collision");
      }
      return { record: existing, replayed: true };
    }
    const now = new Date();
    const record: OperationRecord = Object.freeze({
      operationId: envelope.operationId,
      network: OPERATOR_NETWORK,
      chainId: STUDIONET_CHAIN_ID,
      contractAddress: envelope.contractAddress,
      action: envelope.action,
      functionName: envelope.action,
      valueAtto: "0",
      envelope,
      envelopeFingerprint,
      callFingerprint,
      preState: null,
      preStateFingerprint: null,
      postStateFingerprint: null,
      status: "QUEUED",
      lifecycleStatus: null,
      executionResult: null,
      txHash: null,
      queueMessageId: null,
      enqueueAttempts: 0,
      deliveryCount: 0,
      pollAttempts: 0,
      errorCode: null,
      broadcastStartedAt: null,
      submittedAt: null,
      lastPolledAt: null,
      finalizedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    this.records.set(envelope.operationId, record);
    return { record, replayed: false };
  }
  async recordQueueAccepted(operationId: string, messageId: string | null) {
    const current = this.required(operationId);
    return this.patch(operationId, {
      queueMessageId: current.queueMessageId ?? messageId,
      enqueueAttempts: current.enqueueAttempts + 1,
    });
  }
  async get(operationId: string) { return this.records.get(operationId) ?? null; }
  async getProjection(operationId: string) {
    const record = this.records.get(operationId);
    return record ? projection(record) : null;
  }
  async claimPrecheck(operationId: string, holderId: string, leaseMs: number) {
    if (leaseMs !== PRECHECK_LEASE_MS) throw new Error("lease");
    const record = this.required(operationId);
    if (!["QUEUED", "PRECHECKING", "PRECHECK_FAILED"].includes(record.status)) return null;
    const expired = this.gate.phase === "PRECHECKING" && this.gate.expiresAt !== null && this.gate.expiresAt <= Date.now();
    if (this.gate.operationId !== null && !expired) return null;
    this.gate = {
      token: this.gate.token + 1n,
      holderId,
      operationId,
      phase: "PRECHECKING",
      expiresAt: Date.now() + leaseMs,
    };
    this.patch(operationId, { status: "PRECHECKING", errorCode: null });
    return { operationId, holderId, fencingToken: this.gate.token };
  }
  async recordPreState(claim: SignerClaim, state: StateSnapshot, fingerprint: string) {
    this.assertClaim(claim, "PRECHECKING");
    this.patch(claim.operationId, { preState: state, preStateFingerprint: fingerprint });
  }
  async failPrecheck(claim: SignerClaim, errorCode: string) {
    this.assertClaim(claim, "PRECHECKING");
    this.patch(claim.operationId, { status: "PRECHECK_FAILED", errorCode });
    this.release();
  }
  async beginBroadcast(claim: SignerClaim) {
    if (!this.hasClaim(claim, "PRECHECKING")) return false;
    this.gate.phase = "BROADCASTING";
    this.gate.expiresAt = null;
    this.patch(claim.operationId, { status: "BROADCASTING", broadcastStartedAt: new Date() });
    return true;
  }
  async recordSubmitted(claim: SignerClaim, txHash: string) {
    this.assertClaim(claim, "BROADCASTING");
    if (this.failRecordSubmitted) throw new Error("simulated database crash");
    const record = this.patch(claim.operationId, { status: "SUBMITTED", txHash, submittedAt: new Date() });
    this.release();
    return record;
  }
  async quarantineBroadcast(claim: SignerClaim, errorCode: string) {
    this.assertClaim(claim, "BROADCASTING");
    return this.patch(claim.operationId, { status: "RECONCILIATION_REQUIRED", errorCode });
  }
  async quarantineAmbiguousBroadcast(operationId: string, errorCode: string) {
    return this.patch(operationId, { status: "RECONCILIATION_REQUIRED", errorCode });
  }
  async quarantineWithoutBroadcast(claim: SignerClaim, errorCode: string) {
    this.assertClaim(claim, "PRECHECKING");
    const record = this.patch(claim.operationId, { status: "RECONCILIATION_REQUIRED", errorCode });
    this.release();
    return record;
  }
  async recordPoll(operationId: string, patch: PollPatch) {
    const current = this.required(operationId);
    if (!["SUBMITTED", "POLLING"].includes(current.status)) return current;
    return this.patch(operationId, patch as Partial<OperationRecord>);
  }
  async markPoisoned(operationId: string, errorCode: string) {
    const current = this.records.get(operationId);
    if (current && ["QUEUED", "PRECHECK_FAILED"].includes(current.status)) {
      this.patch(operationId, { status: "POISONED", errorCode });
    }
  }
  async noteDelivery(operationId: string, count: number) {
    const current = this.records.get(operationId);
    if (current) this.patch(operationId, { deliveryCount: Math.max(count, current.deliveryCount) });
  }
  patchForTest(operationId: string, patch: Partial<OperationRecord>) { return this.patch(operationId, patch); }
  private patch(operationId: string, patch: Partial<OperationRecord>) {
    const record = this.required(operationId);
    const updated = Object.freeze({ ...record, ...patch, updatedAt: new Date() });
    this.records.set(operationId, updated);
    return updated;
  }
  private required(operationId: string) {
    const record = this.records.get(operationId);
    if (!record) throw new Error("missing record");
    return record;
  }
  private hasClaim(claim: SignerClaim, phase: "PRECHECKING" | "BROADCASTING") {
    return this.gate.holderId === claim.holderId &&
      this.gate.operationId === claim.operationId &&
      this.gate.token === claim.fencingToken && this.gate.phase === phase;
  }
  private assertClaim(claim: SignerClaim, phase: "PRECHECKING" | "BROADCASTING") {
    if (!this.hasClaim(claim, phase)) throw new Error("fence lost");
  }
  private release() {
    this.gate = { ...this.gate, holderId: null, operationId: null, phase: null, expiresAt: null };
  }
}

function projection(record: OperationRecord): OperationProjection {
  const { envelope: _a, envelopeFingerprint: _b, callFingerprint: _c, preState: _d, ...rest } = record;
  return rest;
}
