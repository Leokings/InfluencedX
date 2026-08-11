import { randomUUID } from "node:crypto";

import {
  CAMPAIGN_SUBMITTER_METHOD,
  METRICS_SUBMITTER_METHOD,
  MAX_POLL_ATTEMPTS,
  PINNED_BRADBURY_RESOLVER,
  PRECHECK_LEASE_MS,
  SUBMITTER_METHOD,
  TERMINAL_STATUSES,
} from "./constants";
import {
  campaignSubmissionArgs,
  envelopeFingerprint,
  isCampaignEnvelope,
  isMetricsEnvelope,
  normalizeSubmissionCallArgs,
  submissionCallFingerprint,
  submissionFunctionName,
  submitterEnvelopeArgs,
} from "./envelope";
import { GateBusyError, PoisonMessageError, SubmitterProblem } from "./problem";
import type { QueuePublisher } from "./queue-publisher";
import type {
  BradburyClient,
  QueueMessage,
  Receipt,
  MetricsResultData,
  ResolverOutcome,
  SubmissionProjection,
  SubmissionRecord,
  SubmissionRepository,
  SubmissionEnvelope,
  SubmitterFunctionName,
} from "./types";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const OWNERSHIP_OUTCOMES = new Set<ResolverOutcome>(["VERIFIED", "REJECTED", "UNDETERMINED"]);
const CAMPAIGN_OUTCOMES = new Set<ResolverOutcome>(["PASS", "FAIL", "UNDETERMINED"]);
const METRICS_OUTCOMES = new Set<ResolverOutcome>(["VERIFIED", "REJECTED", "UNDETERMINED"]);
const VERIFIED_FLAGS = [
  "request_match",
  "post_id_match",
  "protocol_match",
  "wallet_match",
  "issued_at_match",
  "expires_at_match",
  "credential_expires_at_match",
  "challenge_match",
  "publication_in_window",
  "identity_match",
  "author_match",
] as const;

export class SubmissionService {
  constructor(
    private readonly repository: SubmissionRepository,
    private readonly client: BradburyClient,
    private readonly queue: QueuePublisher,
    private readonly now = () => new Date(),
  ) {}

  async process(message: QueueMessage, deliveryCount: number): Promise<void> {
    await this.repository.noteDelivery(message.requestId, deliveryCount);
    const record = await this.repository.get(message.requestId);
    if (!record) throw new PoisonMessageError("UNKNOWN_QUEUE_REQUEST", "The queue request does not exist.", message.requestId);
    if (TERMINAL_STATUSES.has(record.status)) return;
    if (record.status === "SUBMITTED" || record.status === "POLLING") {
      await this.poll(record);
      return;
    }
    if (record.status === "BROADCASTING") throw new GateBusyError();
    await this.submit(record);
  }

  private async submit(record: SubmissionRecord): Promise<void> {
    if (!record.envelope) {
      await this.repository.markPoisoned(record.requestId, "SUBMISSION_ENVELOPE_MISSING");
      throw new PoisonMessageError("SUBMISSION_ENVELOPE_MISSING", "The durable submitter envelope is missing.", record.requestId);
    }
    if (submissionFunctionName(record.envelope) !== record.functionName) {
      await this.repository.markPoisoned(record.requestId, "SUBMISSION_METHOD_MISMATCH");
      throw new PoisonMessageError(
        "SUBMISSION_METHOD_MISMATCH",
        "The durable envelope does not match its allowlisted resolver method.",
        record.requestId,
      );
    }
    if (
      envelopeFingerprint(record.envelope) !== record.envelopeFingerprint ||
      submissionCallFingerprint(record.envelope) !== record.callFingerprint
    ) {
      await this.repository.markPoisoned(record.requestId, "SUBMISSION_ENVELOPE_INTEGRITY_MISMATCH");
      throw new PoisonMessageError(
        "SUBMISSION_ENVELOPE_INTEGRITY_MISMATCH",
        "The durable envelope no longer matches its accepted fingerprints.",
        record.requestId,
      );
    }
    const claim = await this.repository.claimPrecheck(record.requestId, randomUUID(), PRECHECK_LEASE_MS);
    if (!claim) throw new GateBusyError();

    let existing: unknown;
    try {
      existing = await this.client.readExistingResult(record.requestId);
    } catch {
      await this.repository.failPrecheck(claim, "BRADBURY_PRECHECK_UNAVAILABLE");
      throw new SubmitterProblem(503, "BRADBURY_PRECHECK_UNAVAILABLE", "Bradbury could not be checked safely; no transaction was submitted.");
    }
    if (existing !== null) {
      let outcome: ResolverOutcome | null = null;
      let code = "EXISTING_RESULT_INVALID";
      try {
        outcome = assertResolverResult(existing, record.requestId, record.functionName, record.envelope);
        code = "RESULT_EXISTS_WITHOUT_LOCAL_TRANSACTION";
      } catch {
        // Invalid/mismatched results are quarantined with no broadcast.
      }
      await this.repository.quarantineWithoutBroadcast(record.requestId, claim, code, outcome);
      return;
    }

    if (!(await this.repository.beginBroadcast(claim))) throw new GateBusyError();
    let txHash: string;
    try {
      txHash = isCampaignEnvelope(record.envelope)
        ? await this.client.submitCampaign(record.envelope)
        : isMetricsEnvelope(record.envelope)
          ? await this.client.submitMetrics(record.envelope)
          : await this.client.submitOwnership(record.envelope);
    } catch {
      await this.repository.quarantineBroadcast(claim, "BROADCAST_OUTCOME_UNKNOWN");
      return;
    }
    if (!TX_HASH.test(txHash)) {
      await this.repository.quarantineBroadcast(claim, "INVALID_TRANSACTION_HASH");
      return;
    }
    await this.repository.recordSubmitted(claim, txHash.toLowerCase());
    await this.queue.poll(record.requestId, 0);
  }

  private async poll(record: SubmissionRecord): Promise<void> {
    if (!record.txHash) {
      await this.repository.recordPoll(record.requestId, {
        status: "RECONCILIATION_REQUIRED",
        errorCode: "TRANSACTION_HASH_MISSING",
      });
      return;
    }
    const attempt = record.pollAttempts + 1;
    if (attempt > MAX_POLL_ATTEMPTS) {
      await this.repository.recordPoll(record.requestId, {
        status: "POLLING_EXHAUSTED",
        pollAttempts: attempt,
        errorCode: "POLLING_ATTEMPTS_EXHAUSTED",
      });
      return;
    }

    let receipt: Receipt;
    try {
      receipt = await this.client.getTransaction(record.txHash);
    } catch {
      await this.repository.recordPoll(record.requestId, {
        pollAttempts: attempt,
        lastPolledAt: this.now(),
        errorCode: "BRADBURY_POLL_UNAVAILABLE",
      });
      throw new SubmitterProblem(503, "BRADBURY_POLL_UNAVAILABLE", "Bradbury transaction polling is temporarily unavailable.");
    }

    const bindingError = transactionBindingError(receipt, record, this.client.signerAddress);
    if (bindingError) {
      await this.repository.recordPoll(record.requestId, {
        status: "RECONCILIATION_REQUIRED",
        pollAttempts: attempt,
        lastPolledAt: this.now(),
        errorCode: bindingError,
      });
      return;
    }

    const lifecycleStatus = normalizedString(receipt.statusName ?? receipt.status) ?? "UNKNOWN";
    const executionResult = normalizedString(receipt.txExecutionResultName ?? receipt.txExecutionResult);
    if (lifecycleStatus === "CANCELED") {
      await this.repository.recordPoll(record.requestId, {
        status: "NETWORK_TERMINATED",
        lifecycleStatus,
        executionResult,
        pollAttempts: attempt,
        lastPolledAt: this.now(),
        errorCode: "TRANSACTION_CANCELED",
      });
      return;
    }
    if (lifecycleStatus === "FINALIZED") {
      if (executionResult !== "FINISHED_WITH_RETURN") {
        await this.repository.recordPoll(record.requestId, {
          status: "EXECUTION_FAILED",
          lifecycleStatus,
          executionResult,
          pollAttempts: attempt,
          lastPolledAt: this.now(),
          finalizedAt: this.now(),
          errorCode: "GENLAYER_EXECUTION_FAILED",
        });
        return;
      }
      let outcome: ResolverOutcome;
      let resultData: MetricsResultData | null = null;
      try {
        const finalResult = await this.client.readFinalResult(record.requestId);
        outcome = assertResolverResult(
          finalResult,
          record.requestId,
          record.functionName,
          undefined,
          receipt,
        );
        if (record.functionName === METRICS_SUBMITTER_METHOD && outcome === "VERIFIED") {
          resultData = sanitizeVerifiedMetricsResult(finalResult);
        }
      } catch {
        await this.repository.recordPoll(record.requestId, {
          status: "RECONCILIATION_REQUIRED",
          lifecycleStatus,
          executionResult,
          pollAttempts: attempt,
          lastPolledAt: this.now(),
          errorCode: "FINAL_RESULT_INVALID",
        });
        return;
      }
      await this.repository.recordPoll(record.requestId, {
        status: "FINALIZED",
        lifecycleStatus,
        executionResult,
        resultOutcome: outcome,
        resultData,
        pollAttempts: attempt,
        lastPolledAt: this.now(),
        finalizedAt: this.now(),
        errorCode: null,
      });
      return;
    }

    await this.repository.recordPoll(record.requestId, {
      status: "POLLING",
      lifecycleStatus,
      executionResult,
      pollAttempts: attempt,
      lastPolledAt: this.now(),
      errorCode: null,
    });
    await this.queue.poll(record.requestId, attempt);
  }
}

export function transactionBindingError(
  receipt: Receipt,
  record: Pick<SubmissionRecord, "requestId" | "txHash" | "callFingerprint" | "functionName">,
  signerAddress: string,
): string | null {
  const hash = normalizedString(receipt.hash ?? receipt.txId);
  if (!hash) return "TRANSACTION_HASH_MISSING_FROM_RECEIPT";
  if (!record.txHash || hash.toLowerCase() !== record.txHash.toLowerCase()) return "TRANSACTION_HASH_MISMATCH";

  const sender = normalizedString(receipt.from_address ?? receipt.sender);
  if (!sender) return "TRANSACTION_SENDER_MISSING";
  if (sender.toLowerCase() !== signerAddress.toLowerCase()) return "TRANSACTION_SENDER_MISMATCH";

  const recipient = normalizedString(receipt.toAddress ?? receipt.recipient ?? receipt.to_address);
  if (!recipient) return "TRANSACTION_RESOLVER_MISSING";
  if (recipient.toLowerCase() !== PINNED_BRADBURY_RESOLVER.toLowerCase()) return "TRANSACTION_RESOLVER_MISMATCH";

  // Bradbury's consensus transaction view (the object returned by
  // genlayer-js getTransaction) does not currently expose the outer EVM
  // transaction value. The only write adapter in this service hard-codes
  // `value: 0n`, and callers cannot supply or override it. If a future SDK
  // does expose the field, continue to fail closed on malformed/non-zero
  // values; absence alone is not a binding failure for this receipt schema.
  if ("value" in receipt) {
    const value = receipt.value;
    const canonical =
      typeof value === "bigint" ||
      (typeof value === "number" && Number.isSafeInteger(value)) ||
      (typeof value === "string" && /^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value));
    if (!canonical) return "TRANSACTION_VALUE_INVALID";
    if (BigInt(value as string | number | bigint) !== 0n) return "TRANSACTION_VALUE_MISMATCH";
  }

  const { method, args } = decodedTransactionCall(receipt);
  if (typeof method !== "string") return "TRANSACTION_METHOD_MISSING";
  if (method !== record.functionName) return "TRANSACTION_METHOD_MISMATCH";
  if (!Array.isArray(args)) return "TRANSACTION_ARGUMENTS_MISSING";
  try {
    if (submissionCallFingerprint(args, record.functionName) !== record.callFingerprint) return "TRANSACTION_ARGUMENTS_MISMATCH";
  } catch {
    return "TRANSACTION_ARGUMENTS_INVALID";
  }
  return null;
}

export function assertResolverResult(
  value: unknown,
  requestId: string,
  functionName: SubmitterFunctionName = SUBMITTER_METHOD,
  envelope?: SubmissionEnvelope | null,
  receipt?: Receipt,
): ResolverOutcome {
  const result = asRecord(value);
  const expectedKind = functionName === CAMPAIGN_SUBMITTER_METHOD
    ? "CAMPAIGN"
    : functionName === METRICS_SUBMITTER_METHOD
      ? "METRICS"
      : "OWNERSHIP";
  if (!result || result.kind !== expectedKind) throw new Error("Resolver result kind is invalid.");
  if (typeof result.request_id !== "string" || result.request_id.toLowerCase() !== requestId.toLowerCase()) throw new Error("Resolver request ID mismatch.");
  const outcomes = functionName === CAMPAIGN_SUBMITTER_METHOD
    ? CAMPAIGN_OUTCOMES
    : functionName === METRICS_SUBMITTER_METHOD
      ? METRICS_OUTCOMES
      : OWNERSHIP_OUTCOMES;
  if (typeof result.outcome !== "string" || !outcomes.has(result.outcome as ResolverOutcome)) throw new Error("Resolver outcome is invalid.");
  if (functionName === CAMPAIGN_SUBMITTER_METHOD) {
    let args: readonly unknown[];
    if (envelope) {
      if (!isCampaignEnvelope(envelope)) throw new Error("Campaign envelope is invalid.");
      args = campaignSubmissionArgs(envelope);
    } else {
      const decoded = decodedTransactionCall(receipt ?? {});
      if (decoded.method !== CAMPAIGN_SUBMITTER_METHOD || !Array.isArray(decoded.args)) {
        throw new Error("Final campaign transaction arguments are unavailable.");
      }
      args = normalizeSubmissionCallArgs(decoded.args, CAMPAIGN_SUBMITTER_METHOD);
    }
    assertCampaignResultBinding(result, args);
  }
  if (functionName === METRICS_SUBMITTER_METHOD) {
    let args: readonly unknown[];
    if (envelope) {
      if (!isMetricsEnvelope(envelope)) throw new Error("Metrics envelope is invalid.");
      args = submitterEnvelopeArgs(envelope);
    } else {
      const decoded = decodedTransactionCall(receipt ?? {});
      if (decoded.method !== METRICS_SUBMITTER_METHOD || !Array.isArray(decoded.args)) {
        throw new Error("Final metrics transaction arguments are unavailable.");
      }
      args = normalizeSubmissionCallArgs(decoded.args, METRICS_SUBMITTER_METHOD);
    }
    assertMetricsResultBinding(result, args);
    if (result.outcome === "VERIFIED") sanitizeVerifiedMetricsResult(result);
  }
  if (
    functionName === SUBMITTER_METHOD &&
    result.outcome === "VERIFIED" &&
    VERIFIED_FLAGS.some((field) => result[field] !== true)
  ) {
    throw new Error("A verified resolver result is missing an exact proof check.");
  }
  return result.outcome as ResolverOutcome;
}

function assertMetricsResultBinding(
  result: Record<string, unknown>,
  rawArgs: readonly unknown[],
): void {
  const args = normalizeSubmissionCallArgs(rawArgs, METRICS_SUBMITTER_METHOD);
  if (result.request_id !== args[0]) throw new Error("Metrics result request ID is not canonical.");
  if (result.base_wallet !== args[1]) throw new Error("Metrics result wallet mismatch.");
  if (result.identity_hash !== args[2]) throw new Error("Metrics result identity mismatch.");
  if (result.handle !== args[3]) throw new Error("Metrics result handle mismatch.");
  if (canonicalSafeInteger(result.metrics_expires_at_epoch, "metrics expiry") !== args[4]) {
    throw new Error("Metrics result expiry mismatch.");
  }
  const measuredAt = canonicalSafeInteger(result.measured_at_epoch, "metrics measurement time");
  if (measuredAt <= 0 || measuredAt >= Number(args[4])) {
    throw new Error("Metrics result measurement time is invalid.");
  }
  if (typeof result.identity_match !== "boolean") {
    throw new Error("Metrics result identity check is invalid.");
  }
}

export function sanitizeVerifiedMetricsResult(value: unknown): MetricsResultData {
  const result = asRecord(value);
  if (!result || result.kind !== "METRICS" || result.outcome !== "VERIFIED") {
    throw new Error("Verified metrics result is invalid.");
  }
  const expectedKeys = [
    "account_created_at_ms",
    "base_wallet",
    "engagement_consistency",
    "engagement_rate_bps",
    "followers",
    "following",
    "handle",
    "http_status",
    "identity_hash",
    "identity_match",
    "kind",
    "measured_at_epoch",
    "median_likes",
    "median_replies",
    "median_reposts",
    "median_views",
    "metrics_expires_at_epoch",
    "outcome",
    "posts_analyzed",
    "protected",
    "request_id",
    "total_posts",
    "x_user_id",
  ].sort();
  const actualKeys = Object.keys(result).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("Verified metrics result fields are invalid.");
  }
  if (
    result.identity_match !== true ||
    result.protected !== false ||
    typeof result.x_user_id !== "string" ||
    !/^[0-9]{1,25}$/.test(result.x_user_id)
  ) {
    throw new Error("Verified metrics identity evidence is invalid.");
  }
  const consistency = result.engagement_consistency;
  if (
    consistency !== "LOW_RISK" &&
    consistency !== "MEDIUM_RISK" &&
    consistency !== "HIGH_RISK" &&
    consistency !== "INSUFFICIENT"
  ) {
    throw new Error("Verified metrics consistency is invalid.");
  }
  const measuredAt = positiveSafeInteger(result.measured_at_epoch, "measured_at_epoch");
  const expiresAt = positiveSafeInteger(result.metrics_expires_at_epoch, "metrics_expires_at_epoch");
  const accountCreatedAt = positiveSafeInteger(result.account_created_at_ms, "account_created_at_ms");
  if (expiresAt <= measuredAt || accountCreatedAt > measuredAt * 1_000) {
    throw new Error("Verified metrics timestamps are invalid.");
  }
  const postsAnalyzed = nonnegativeSafeInteger(result.posts_analyzed, "posts_analyzed");
  if (postsAnalyzed > 20) throw new Error("Verified metrics sample size is invalid.");
  const httpStatus = positiveSafeInteger(result.http_status, "http_status");
  if (httpStatus < 100 || httpStatus > 599) throw new Error("Verified metrics HTTP status is invalid.");
  const medianLikes = nonnegativeSafeInteger(result.median_likes, "median_likes");
  const medianReplies = nonnegativeSafeInteger(result.median_replies, "median_replies");
  const medianReposts = nonnegativeSafeInteger(result.median_reposts, "median_reposts");
  if (!Number.isSafeInteger(medianLikes + medianReplies + medianReposts)) {
    throw new Error("Verified metrics median engagement is outside the safe range.");
  }
  return Object.freeze({
    kind: "METRICS",
    request_id: canonicalHash(result.request_id, "request_id"),
    base_wallet: canonicalAddress(result.base_wallet),
    identity_hash: canonicalHash(result.identity_hash, "identity_hash"),
    handle: canonicalHandle(result.handle),
    x_user_id: result.x_user_id,
    outcome: "VERIFIED",
    identity_match: true,
    protected: false,
    http_status: httpStatus,
    measured_at_epoch: measuredAt,
    metrics_expires_at_epoch: expiresAt,
    account_created_at_ms: accountCreatedAt,
    followers: nonnegativeSafeInteger(result.followers, "followers"),
    following: nonnegativeSafeInteger(result.following, "following"),
    total_posts: nonnegativeSafeInteger(result.total_posts, "total_posts"),
    posts_analyzed: postsAnalyzed,
    median_likes: medianLikes,
    median_replies: medianReplies,
    median_reposts: medianReposts,
    median_views: nonnegativeSafeInteger(result.median_views, "median_views"),
    engagement_rate_bps: nonnegativeSafeInteger(result.engagement_rate_bps, "engagement_rate_bps"),
    engagement_consistency: consistency,
  });
}

function assertCampaignResultBinding(
  result: Record<string, unknown>,
  rawArgs: readonly unknown[],
): void {
  const args = normalizeSubmissionCallArgs(rawArgs, CAMPAIGN_SUBMITTER_METHOD);
  if (result.request_id !== args[0]) throw new Error("Campaign result request ID is not canonical.");
  if (result.handle !== args[1]) throw new Error("Campaign result handle mismatch.");
  if (result.post_id !== args[2]) throw new Error("Campaign result post ID mismatch.");
  if (Number(result.assignment_id) !== args[8] || !Number.isSafeInteger(result.assignment_id)) {
    throw new Error("Campaign result assignment ID mismatch.");
  }
  if (result.agreement_hash !== args[9]) throw new Error("Campaign result agreement hash mismatch.");
  if (result.submission_hash !== args[10]) throw new Error("Campaign result submission hash mismatch.");
}

export function project(record: SubmissionRecord): SubmissionProjection {
  const { envelope: _envelope, envelopeFingerprint: _envelopeFingerprint, callFingerprint: _callFingerprint, ...projection } = record;
  return Object.freeze(projection);
}

function normalizedString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function decodedTransactionCall(receipt: Receipt): {
  method: unknown;
  args: unknown;
} {
  const decoded = asRecord(receipt.txDataDecoded);
  const callDataValue = decoded?.callData;
  const callData = callDataValue instanceof Map ? callDataValue : asRecord(callDataValue);
  return {
    method: callData instanceof Map ? callData.get("method") : callData?.method,
    args: callData instanceof Map ? callData.get("args") : callData?.args,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is invalid.`);
  return Number(value);
}

function positiveSafeInteger(value: unknown, label: string): number {
  const parsed = canonicalSafeInteger(value, label);
  if (parsed <= 0) throw new Error(`${label} must be positive.`);
  return parsed;
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  const parsed = canonicalSafeInteger(value, label);
  if (parsed < 0) throw new Error(`${label} must be nonnegative.`);
  return parsed;
}

function canonicalHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} is not a canonical hash.`);
  }
  return value;
}

function canonicalAddress(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/.test(value)) {
    throw new Error("Metrics wallet is not canonical.");
  }
  return value;
}

function canonicalHandle(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_]{1,15}$/.test(value)) {
    throw new Error("Metrics handle is not canonical.");
  }
  return value;
}
