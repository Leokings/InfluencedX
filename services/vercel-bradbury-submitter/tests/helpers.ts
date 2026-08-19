import {
  PINNED_STUDIONET_RESOLVER,
  STUDIONET_CHAIN_ID,
  STUDIONET_RPC_URL,
  SUBMITTER_NETWORK,
  SUBMITTER_SCHEMA_VERSION,
  X_EPOCH_MS,
} from "../lib/constants";
import type { SubmitterConfig } from "../lib/config";
import {
  campaignSubmissionArgs,
  metricsRequestId,
  metricsSubmissionArgs,
  ownershipRequestId,
  submissionFunctionName,
} from "../lib/envelope";
import { SubmitterProblem } from "../lib/problem";
import type { QueuePublisher } from "../lib/queue-publisher";
import type {
  StudioNetClient,
  CampaignEnvelope,
  MetricsEnvelope,
  OwnershipEnvelope,
  PollPatch,
  Receipt,
  ResolverOutcome,
  SignerClaim,
  SubmissionProjection,
  SubmissionRecord,
  SubmissionRepository,
  SubmissionEnvelope,
} from "../lib/types";

export const NOW_EPOCH = 1_786_233_600;
export const TX_HASH = `0x${"ab".repeat(32)}`;
export const SIGNER = `0x${"77".repeat(20)}`;

export function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    XPROOF_SUBMITTER_ENABLED: "true",
    XPROOF_SUBMITTER_STAGE: "studionet",
    XPROOF_GENLAYER_NETWORK: "studionet",
    XPROOF_GENLAYER_CHAIN_ID: String(STUDIONET_CHAIN_ID),
    XPROOF_GENLAYER_RESOLVER: PINNED_STUDIONET_RESOLVER,
    GENLAYER_SUBMITTER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    DATABASE_URL: "postgresql://example.invalid/xproof",
    XPROOF_CALLER_TEAM_SLUG: "leokings588-5902s-projects",
    XPROOF_CALLER_TEAM_ID: "team_2L0T4LCdFsCTFcckeTFWZRvN",
    XPROOF_CALLER_PROJECT_NAME: "influencedx",
    XPROOF_CALLER_PROJECT_ID: "prj_4W0EuXNi5nFD46ArUAbvk2YnTacu",
    XPROOF_CALLER_ENVIRONMENT: "preview",
    ...overrides,
  };
}

export function configFixture(): SubmitterConfig {
  return {
    enabled: true,
    stage: "studionet",
    network: "studionet",
    chainId: STUDIONET_CHAIN_ID,
    resolver: PINNED_STUDIONET_RESOLVER,
    rpcUrl: STUDIONET_RPC_URL,
    privateKey: `0x${"11".repeat(32)}`,
    databaseUrl: "postgresql://example.invalid/xproof",
    caller: {
      teamSlug: "leokings588-5902s-projects",
      teamId: "team_2L0T4LCdFsCTFcckeTFWZRvN",
      projectName: "influencedx",
      projectId: "prj_4W0EuXNi5nFD46ArUAbvk2YnTacu",
      environment: "preview",
    },
  };
}

export function makeEnvelope(overrides: Partial<OwnershipEnvelope> = {}): OwnershipEnvelope {
  const issuedAtEpoch = overrides.issuedAtEpoch ?? NOW_EPOCH - 60;
  const base = {
    schemaVersion: SUBMITTER_SCHEMA_VERSION,
    baseWallet: overrides.baseWallet ?? `0x${"12".repeat(20)}`,
    expectedHandle: overrides.expectedHandle ?? "xproof_creator",
    postId: overrides.postId ?? snowflakeAt(issuedAtEpoch + 30),
    challenge: overrides.challenge ?? `APV2-${"a".repeat(24)}`,
    issuedAtEpoch,
    expiresAtEpoch: overrides.expiresAtEpoch ?? issuedAtEpoch + 15 * 60,
    credentialExpiresAtEpoch: overrides.credentialExpiresAtEpoch ?? issuedAtEpoch + 30 * 24 * 60 * 60,
  } as const;
  return Object.freeze({ ...base, requestId: overrides.requestId ?? ownershipRequestId(base) });
}

export function makeCampaignEnvelope(overrides: Partial<CampaignEnvelope> = {}): CampaignEnvelope {
  return Object.freeze({
    schemaVersion: SUBMITTER_SCHEMA_VERSION,
    kind: "CAMPAIGN",
    requestId: overrides.requestId ?? `0x${"31".repeat(32)}`,
    expectedHandle: overrides.expectedHandle ?? "influencedx",
    postId: overrides.postId ?? snowflakeAt(NOW_EPOCH - 120),
    requiredPhrasesJson: overrides.requiredPhrasesJson ?? JSON.stringify(["InfluencedX"]),
    forbiddenPhrasesJson: overrides.forbiddenPhrasesJson ?? JSON.stringify(["competitor"]),
    requireAdDisclosure: overrides.requireAdDisclosure ?? true,
    semanticBrief: overrides.semanticBrief ?? "Show the product and explain one concrete benefit.",
    resolveNotBeforeEpoch: overrides.resolveNotBeforeEpoch ?? NOW_EPOCH - 60,
    assignmentId: overrides.assignmentId ?? 7,
    agreementHash: overrides.agreementHash ?? `0x${"44".repeat(32)}`,
    submissionHash: overrides.submissionHash ?? `0x${"55".repeat(32)}`,
  });
}

export function makeMetricsEnvelope(overrides: Partial<MetricsEnvelope> = {}): MetricsEnvelope {
  const base = {
    schemaVersion: SUBMITTER_SCHEMA_VERSION,
    kind: "METRICS" as const,
    baseWallet: overrides.baseWallet ?? `0x${"12".repeat(20)}`,
    identityHash: overrides.identityHash ?? `0x${"66".repeat(32)}`,
    expectedHandle: overrides.expectedHandle ?? "influencedx",
    metricsExpiresAtEpoch: overrides.metricsExpiresAtEpoch ?? NOW_EPOCH + 24 * 60 * 60,
  };
  return Object.freeze({
    ...base,
    requestId: overrides.requestId ?? metricsRequestId(base),
  });
}

export function snowflakeAt(epochSeconds: number): string {
  return ((BigInt(epochSeconds) * 1_000n - X_EPOCH_MS) << 22n).toString();
}

export function ownershipResult(requestId: string, outcome: ResolverOutcome = "VERIFIED") {
  return {
    kind: "OWNERSHIP",
    request_id: requestId,
    outcome,
    ...(outcome === "VERIFIED" ? {
      request_match: true,
      post_id_match: true,
      protocol_match: true,
      wallet_match: true,
      issued_at_match: true,
      expires_at_match: true,
      credential_expires_at_match: true,
      challenge_match: true,
      publication_in_window: true,
      identity_match: true,
      author_match: true,
    } : {}),
  };
}

export function finalizedReceipt(envelope: OwnershipEnvelope, overrides: Receipt = {}): Receipt {
  return {
    hash: TX_HASH,
    sender: SIGNER,
    recipient: PINNED_STUDIONET_RESOLVER,
    value: 0,
    statusName: "FINALIZED",
    txExecutionResultName: "FINISHED_WITH_RETURN",
    txDataDecoded: {
      callData: {
        method: "verify_ownership",
        args: [
          envelope.requestId,
          envelope.baseWallet,
          envelope.expectedHandle,
          envelope.postId,
          envelope.challenge,
          envelope.issuedAtEpoch,
          envelope.expiresAtEpoch,
          envelope.credentialExpiresAtEpoch,
        ],
      },
    },
    ...overrides,
  };
}

export function campaignResult(
  envelope: CampaignEnvelope,
  outcome: ResolverOutcome = "PASS",
) {
  return {
    kind: "CAMPAIGN",
    request_id: envelope.requestId,
    handle: envelope.expectedHandle,
    post_id: envelope.postId,
    assignment_id: envelope.assignmentId,
    agreement_hash: envelope.agreementHash,
    submission_hash: envelope.submissionHash,
    outcome,
  };
}

export function finalizedCampaignReceipt(
  envelope: CampaignEnvelope,
  overrides: Receipt = {},
): Receipt {
  return {
    hash: TX_HASH,
    sender: SIGNER,
    recipient: PINNED_STUDIONET_RESOLVER,
    value: 0,
    statusName: "FINALIZED",
    txExecutionResultName: "FINISHED_WITH_RETURN",
    txDataDecoded: {
      callData: {
        method: "resolve_submission",
        args: [...campaignSubmissionArgs(envelope)],
      },
    },
    ...overrides,
  };
}

export function metricsResult(envelope: MetricsEnvelope) {
  return {
    kind: "METRICS",
    request_id: envelope.requestId,
    base_wallet: envelope.baseWallet,
    identity_hash: envelope.identityHash,
    handle: envelope.expectedHandle,
    x_user_id: "2244994945",
    outcome: "VERIFIED",
    identity_match: true,
    protected: false,
    http_status: 200,
    measured_at_epoch: NOW_EPOCH,
    metrics_expires_at_epoch: envelope.metricsExpiresAtEpoch,
    account_created_at_ms: 1_500_000_000_000,
    followers: 100_000,
    following: 320,
    total_posts: 1_500,
    posts_analyzed: 10,
    median_likes: 500,
    median_replies: 40,
    median_reposts: 60,
    median_views: 12_000,
    engagement_rate_bps: 60,
    engagement_consistency: "LOW_RISK",
  } as const;
}

export function finalizedMetricsReceipt(
  envelope: MetricsEnvelope,
  overrides: Receipt = {},
): Receipt {
  return {
    hash: TX_HASH,
    sender: SIGNER,
    recipient: PINNED_STUDIONET_RESOLVER,
    value: 0,
    statusName: "FINALIZED",
    txExecutionResultName: "FINISHED_WITH_RETURN",
    txDataDecoded: {
      callData: {
        method: "snapshot_metrics",
        args: [...metricsSubmissionArgs(envelope)],
      },
    },
    ...overrides,
  };
}

export class FakeQueue implements QueuePublisher {
  submits: string[] = [];
  polls: Array<{ requestId: string; attempt: number }> = [];
  async submit(requestId: string) {
    this.submits.push(requestId);
    return `msg-submit-${this.submits.length}`;
  }
  async poll(requestId: string, attempt: number) {
    this.polls.push({ requestId, attempt });
    return `msg-poll-${this.polls.length}`;
  }
}

export class FakeStudioNetClient implements StudioNetClient {
  readonly signerAddress = SIGNER;
  precheckResult: unknown = null;
  precheckError: Error | null = null;
  receipt: Receipt = {};
  finalResult: unknown = null;
  submitError: Error | null = null;
  submitCalls = 0;
  submitOwnershipCalls = 0;
  submitCampaignCalls = 0;
  submitMetricsCalls = 0;
  activeSubmits = 0;
  maxActiveSubmits = 0;
  submitBarrier: Promise<void> | null = null;

  async readExistingResult() {
    if (this.precheckError) throw this.precheckError;
    return this.precheckResult;
  }
  async submitOwnership() {
    this.submitOwnershipCalls += 1;
    return this.submit();
  }
  async submitCampaign() {
    this.submitCampaignCalls += 1;
    return this.submit();
  }
  async submitMetrics() {
    this.submitMetricsCalls += 1;
    return this.submit();
  }
  private async submit() {
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
  async getTransaction() {
    return this.receipt;
  }
  async readFinalResult() {
    return this.finalResult;
  }
}

export class MemoryRepository implements SubmissionRepository {
  readonly records = new Map<string, SubmissionRecord>();
  failRecordSubmitted = false;
  private gate: {
    token: bigint;
    holderId: string | null;
    requestId: string | null;
    phase: "PRECHECKING" | "BROADCASTING" | null;
    expiresAt: number | null;
  } = { token: 0n, holderId: null, requestId: null, phase: null, expiresAt: null };

  async createOrReplay(envelope: SubmissionEnvelope, envelopeFingerprint: string, callFingerprint: string) {
    const existing = this.records.get(envelope.requestId);
    if (existing) {
      if (existing.envelopeFingerprint !== envelopeFingerprint || existing.callFingerprint !== callFingerprint) {
        throw new SubmitterProblem(409, "REQUEST_ID_COLLISION", "collision");
      }
      return { record: existing, replayed: true };
    }
    const now = new Date();
    const record: SubmissionRecord = Object.freeze({
      requestId: envelope.requestId,
      network: SUBMITTER_NETWORK,
      resolver: PINNED_STUDIONET_RESOLVER.toLowerCase(),
      envelope,
      functionName: submissionFunctionName(envelope),
      envelopeFingerprint,
      callFingerprint,
      status: "QUEUED",
      lifecycleStatus: null,
      executionResult: null,
      resultOutcome: null,
      resultData: null,
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
    this.records.set(envelope.requestId, record);
    return { record, replayed: false };
  }

  async recordQueueAccepted(requestId: string, messageId: string | null) {
    return this.patch(requestId, {
      queueMessageId: this.required(requestId).queueMessageId ?? messageId,
      enqueueAttempts: this.required(requestId).enqueueAttempts + 1,
    });
  }
  async get(requestId: string) { return this.records.get(requestId) ?? null; }
  async getProjection(requestId: string) {
    const record = this.records.get(requestId);
    return record ? projection(record) : null;
  }
  async claimPrecheck(requestId: string, holderId: string, leaseMs: number) {
    const record = this.required(requestId);
    if (!["QUEUED", "PRECHECKING", "PRECHECK_FAILED"].includes(record.status)) return null;
    const free = this.gate.requestId === null;
    const expired = this.gate.phase === "PRECHECKING" && this.gate.expiresAt !== null && this.gate.expiresAt <= Date.now();
    if (!free && !expired) return null;
    this.gate = {
      token: this.gate.token + 1n,
      holderId,
      requestId,
      phase: "PRECHECKING",
      expiresAt: Date.now() + leaseMs,
    };
    this.patch(requestId, { status: "PRECHECKING", errorCode: null });
    return { requestId, holderId, fencingToken: this.gate.token };
  }
  async failPrecheck(claim: SignerClaim, errorCode: string) {
    this.assertClaim(claim, "PRECHECKING");
    this.patch(claim.requestId, { status: "PRECHECK_FAILED", errorCode });
    this.release();
  }
  async beginBroadcast(claim: SignerClaim) {
    if (!this.hasClaim(claim, "PRECHECKING")) return false;
    this.gate.phase = "BROADCASTING";
    this.gate.expiresAt = null;
    this.patch(claim.requestId, { status: "BROADCASTING", broadcastStartedAt: new Date(), errorCode: null });
    return true;
  }
  async recordSubmitted(claim: SignerClaim, txHash: string) {
    this.assertClaim(claim, "BROADCASTING");
    if (this.failRecordSubmitted) throw new Error("simulated database crash after broadcast");
    const record = this.patch(claim.requestId, {
      status: "SUBMITTED",
      txHash,
      envelope: null,
      submittedAt: new Date(),
      pollAttempts: 0,
      errorCode: null,
    });
    this.release();
    return record;
  }
  async quarantineBroadcast(claim: SignerClaim, errorCode: string) {
    this.assertClaim(claim, "BROADCASTING");
    const record = this.patch(claim.requestId, { status: "RECONCILIATION_REQUIRED", envelope: null, errorCode });
    return record;
  }
  async quarantineWithoutBroadcast(requestId: string, claim: SignerClaim, errorCode: string, resultOutcome: ResolverOutcome | null = null) {
    if (requestId !== claim.requestId) throw new Error("bad request");
    this.assertClaim(claim, "PRECHECKING");
    const record = this.patch(requestId, { status: "RECONCILIATION_REQUIRED", envelope: null, errorCode, resultOutcome });
    this.release();
    return record;
  }
  async recordPoll(requestId: string, patch: PollPatch) {
    const record = this.required(requestId);
    if (!["SUBMITTED", "POLLING"].includes(record.status)) return record;
    return this.patch(requestId, patch as Partial<SubmissionRecord>);
  }
  async markPoisoned(requestId: string, errorCode: string) {
    const record = this.records.get(requestId);
    if (record && ["QUEUED", "PRECHECK_FAILED"].includes(record.status)) this.patch(requestId, { status: "POISONED", envelope: null, errorCode });
  }
  async noteDelivery(requestId: string, deliveryCount: number) {
    const record = this.records.get(requestId);
    if (record) this.patch(requestId, { deliveryCount: Math.max(record.deliveryCount, deliveryCount) });
  }
  removeEnvelope(requestId: string) { this.patch(requestId, { envelope: null }); }

  private patch(requestId: string, changes: Partial<SubmissionRecord>) {
    const record = this.required(requestId);
    const updated = Object.freeze({ ...record, ...changes, updatedAt: new Date() });
    this.records.set(requestId, updated);
    return updated;
  }
  private required(requestId: string) {
    const record = this.records.get(requestId);
    if (!record) throw new Error("missing record");
    return record;
  }
  private hasClaim(claim: SignerClaim, phase: "PRECHECKING" | "BROADCASTING") {
    return this.gate.holderId === claim.holderId && this.gate.requestId === claim.requestId && this.gate.token === claim.fencingToken && this.gate.phase === phase;
  }
  private assertClaim(claim: SignerClaim, phase: "PRECHECKING" | "BROADCASTING") {
    if (!this.hasClaim(claim, phase)) throw new Error("fence lost");
  }
  private release() {
    this.gate = { ...this.gate, holderId: null, requestId: null, phase: null, expiresAt: null };
  }
}

function projection(record: SubmissionRecord): SubmissionProjection {
  const { envelope: _a, envelopeFingerprint: _b, callFingerprint: _c, ...rest } = record;
  return rest;
}
