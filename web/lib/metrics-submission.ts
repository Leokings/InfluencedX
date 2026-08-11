import { isHash, sha256, stringToHex, type Hex } from "viem";
import {
  ownershipSubmissionStatuses,
  type OwnershipSubmissionStatus,
} from "./ownership-submission.ts";

export const METRICS_SUBMISSION_SCHEMA_VERSION = 1 as const;
export const METRICS_SUBMISSION_KIND = "METRICS" as const;
export const METRICS_BRADBURY_METHOD = "snapshot_metrics" as const;
export const MAX_METRICS_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

export type MetricsOutcome = "VERIFIED" | "REJECTED" | "UNDETERMINED";
export type MetricsConsistency =
  | "LOW_RISK"
  | "MEDIUM_RISK"
  | "HIGH_RISK"
  | "INSUFFICIENT";

export type MetricsSubmissionEnvelope = Readonly<{
  schemaVersion: typeof METRICS_SUBMISSION_SCHEMA_VERSION;
  kind: typeof METRICS_SUBMISSION_KIND;
  requestId: Hex;
  baseWallet: string;
  identityHash: Hex;
  expectedHandle: string;
  metricsExpiresAtEpoch: number;
}>;

export type VerifiedMetricsResult = Readonly<{
  kind: "METRICS";
  request_id: Hex;
  base_wallet: string;
  identity_hash: Hex;
  handle: string;
  x_user_id: string;
  outcome: "VERIFIED";
  identity_match: true;
  protected: false;
  http_status: number;
  measured_at_epoch: number;
  metrics_expires_at_epoch: number;
  account_created_at_ms: number;
  followers: number;
  following: number;
  total_posts: number;
  posts_analyzed: number;
  median_likes: number;
  median_replies: number;
  median_reposts: number;
  median_views: number;
  engagement_rate_bps: number;
  engagement_consistency: MetricsConsistency;
}>;

export type MetricsSubmitterSubmission = Readonly<{
  requestId: Hex;
  functionName: typeof METRICS_BRADBURY_METHOD;
  status: Exclude<
    OwnershipSubmissionStatus,
    "NOT_SUBMITTED" | "DISPATCHING" | "DISPATCH_UNKNOWN"
  >;
  lifecycleStatus: string | null;
  executionResult: string | null;
  resultOutcome: MetricsOutcome | null;
  resultData: VerifiedMetricsResult | null;
  txHash: Hex | null;
  queueMessageId: string | null;
  enqueueAttempts: number;
  deliveryCount: number;
  pollAttempts: number;
  errorCode: string | null;
  broadcastStartedAt: string | null;
  submittedAt: string | null;
  lastPolledAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export function metricsSubmissionRequestId(input: {
  baseWallet: string;
  identityHash: string;
  expectedHandle: string;
  metricsExpiresAtEpoch: number;
}): Hex {
  return sha256(stringToHex([
    "influencedx-x-metrics-v1",
    input.baseWallet.toLowerCase(),
    input.identityHash.toLowerCase(),
    input.expectedHandle,
    input.metricsExpiresAtEpoch,
  ].join("|")));
}

export function buildMetricsSubmissionEnvelope(input: {
  requestId?: unknown;
  baseWallet: unknown;
  identityHash: unknown;
  expectedHandle: unknown;
  metricsExpiresAtEpoch: unknown;
  nowEpoch?: number;
}): MetricsSubmissionEnvelope {
  const nowEpoch = positiveInteger(
    input.nowEpoch ?? Math.floor(Date.now() / 1_000),
    "nowEpoch",
  );
  const envelopeWithoutId = {
    baseWallet: canonicalAddress(input.baseWallet),
    identityHash: bytes32(input.identityHash, "identityHash"),
    expectedHandle: canonicalHandle(input.expectedHandle),
    metricsExpiresAtEpoch: positiveInteger(
      input.metricsExpiresAtEpoch,
      "metricsExpiresAtEpoch",
    ),
  };
  if (
    envelopeWithoutId.metricsExpiresAtEpoch <= nowEpoch ||
    envelopeWithoutId.metricsExpiresAtEpoch > nowEpoch + MAX_METRICS_LIFETIME_SECONDS
  ) {
    throw new Error("Metrics expiry must be in the next seven days.");
  }
  const expectedRequestId = metricsSubmissionRequestId(envelopeWithoutId);
  const requestId = input.requestId === undefined
    ? expectedRequestId
    : bytes32(input.requestId, "requestId");
  if (requestId !== expectedRequestId) {
    throw new Error("requestId does not bind the metrics profile envelope.");
  }
  return Object.freeze({
    schemaVersion: METRICS_SUBMISSION_SCHEMA_VERSION,
    kind: METRICS_SUBMISSION_KIND,
    requestId,
    ...envelopeWithoutId,
  });
}

export function parseMetricsSubmitterSubmission(value: unknown): MetricsSubmitterSubmission {
  if (!record(value) || value.functionName !== METRICS_BRADBURY_METHOD) {
    throw new Error("The metrics submitter response is invalid.");
  }
  const statuses = new Set(ownershipSubmissionStatuses.slice(3));
  if (typeof value.status !== "string" || !statuses.has(value.status as never)) {
    throw new Error("The metrics submitter status is invalid.");
  }
  const outcome = metricsOutcome(value.resultOutcome);
  const resultData = value.resultData === null
    ? null
    : parseVerifiedMetricsResult(value.resultData);
  if (
    (value.status === "FINALIZED" && outcome === "VERIFIED") !==
    (resultData !== null)
  ) {
    throw new Error("The verified metrics result projection is incomplete.");
  }
  const requestId = bytes32(value.requestId, "requestId");
  if (resultData && resultData.request_id !== requestId) {
    throw new Error("The metrics result belongs to another request.");
  }
  return Object.freeze({
    requestId,
    functionName: METRICS_BRADBURY_METHOD,
    status: value.status as MetricsSubmitterSubmission["status"],
    lifecycleStatus: nullableString(value.lifecycleStatus),
    executionResult: nullableString(value.executionResult),
    resultOutcome: outcome,
    resultData,
    txHash: value.txHash === null ? null : bytes32(value.txHash, "txHash"),
    queueMessageId: nullableString(value.queueMessageId),
    enqueueAttempts: nonnegativeInteger(value.enqueueAttempts, "enqueueAttempts"),
    deliveryCount: nonnegativeInteger(value.deliveryCount, "deliveryCount"),
    pollAttempts: nonnegativeInteger(value.pollAttempts, "pollAttempts"),
    errorCode: nullableString(value.errorCode),
    broadcastStartedAt: nullableIso(value.broadcastStartedAt),
    submittedAt: nullableIso(value.submittedAt),
    lastPolledAt: nullableIso(value.lastPolledAt),
    finalizedAt: nullableIso(value.finalizedAt),
    createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt),
  });
}

export function parseVerifiedMetricsResult(value: unknown): VerifiedMetricsResult {
  if (!record(value)) throw new Error("The verified metrics result is invalid.");
  const expected = [
    "account_created_at_ms", "base_wallet", "engagement_consistency",
    "engagement_rate_bps", "followers", "following", "handle", "http_status",
    "identity_hash", "identity_match", "kind", "measured_at_epoch",
    "median_likes", "median_replies", "median_reposts", "median_views",
    "metrics_expires_at_epoch", "outcome", "posts_analyzed", "protected",
    "request_id", "total_posts", "x_user_id",
  ].sort();
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("The verified metrics result fields are invalid.");
  }
  if (
    value.kind !== "METRICS" ||
    value.outcome !== "VERIFIED" ||
    value.identity_match !== true ||
    value.protected !== false ||
    typeof value.x_user_id !== "string" ||
    !/^[0-9]{1,25}$/.test(value.x_user_id)
  ) {
    throw new Error("The verified metrics identity is invalid.");
  }
  const consistency = value.engagement_consistency;
  if (!isConsistency(consistency)) throw new Error("The metrics risk signal is invalid.");
  const measuredAt = positiveInteger(value.measured_at_epoch, "measured_at_epoch");
  const expiresAt = positiveInteger(value.metrics_expires_at_epoch, "metrics_expires_at_epoch");
  const accountCreatedAt = positiveInteger(value.account_created_at_ms, "account_created_at_ms");
  const postsAnalyzed = nonnegativeInteger(value.posts_analyzed, "posts_analyzed");
  const httpStatus = positiveInteger(value.http_status, "http_status");
  const medianLikes = nonnegativeInteger(value.median_likes, "median_likes");
  const medianReplies = nonnegativeInteger(value.median_replies, "median_replies");
  const medianReposts = nonnegativeInteger(value.median_reposts, "median_reposts");
  if (
    expiresAt <= measuredAt ||
    accountCreatedAt > measuredAt * 1_000 ||
    postsAnalyzed > 20 ||
    httpStatus < 100 ||
    httpStatus > 599 ||
    !Number.isSafeInteger(medianLikes + medianReplies + medianReposts)
  ) {
    throw new Error("The verified metrics values are invalid.");
  }
  return Object.freeze({
    kind: "METRICS",
    request_id: bytes32(value.request_id, "request_id"),
    base_wallet: canonicalAddress(value.base_wallet),
    identity_hash: bytes32(value.identity_hash, "identity_hash"),
    handle: canonicalHandle(value.handle),
    x_user_id: value.x_user_id,
    outcome: "VERIFIED",
    identity_match: true,
    protected: false,
    http_status: httpStatus,
    measured_at_epoch: measuredAt,
    metrics_expires_at_epoch: expiresAt,
    account_created_at_ms: accountCreatedAt,
    followers: nonnegativeInteger(value.followers, "followers"),
    following: nonnegativeInteger(value.following, "following"),
    total_posts: nonnegativeInteger(value.total_posts, "total_posts"),
    posts_analyzed: postsAnalyzed,
    median_likes: medianLikes,
    median_replies: medianReplies,
    median_reposts: medianReposts,
    median_views: nonnegativeInteger(value.median_views, "median_views"),
    engagement_rate_bps: nonnegativeInteger(value.engagement_rate_bps, "engagement_rate_bps"),
    engagement_consistency: consistency,
  });
}

function bytes32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHash(value) || value !== value.toLowerCase()) {
    throw new Error(`${label} must be a canonical 32-byte hash.`);
  }
  return value as Hex;
}

function canonicalAddress(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/.test(value)) {
    throw new Error("baseWallet must be a canonical lowercase EVM address.");
  }
  return value;
}

function canonicalHandle(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_]{1,15}$/.test(value)) {
    throw new Error("expectedHandle must be a canonical X handle.");
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a nonnegative safe integer.`);
  }
  return Number(value);
}

function metricsOutcome(value: unknown): MetricsOutcome | null {
  if (value === null) return null;
  if (value === "VERIFIED" || value === "REJECTED" || value === "UNDETERMINED") return value;
  throw new Error("The metrics outcome is invalid.");
}

function isConsistency(value: unknown): value is MetricsConsistency {
  return value === "LOW_RISK" || value === "MEDIUM_RISK" ||
    value === "HIGH_RISK" || value === "INSUFFICIENT";
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 128) throw new Error("A metrics status string is invalid.");
  return value;
}

function iso(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("A metrics status timestamp is invalid.");
  }
  return value;
}

function nullableIso(value: unknown): string | null {
  return value === null ? null : iso(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
