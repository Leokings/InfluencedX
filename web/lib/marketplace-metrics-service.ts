import { keccak256, stringToHex, type Hex } from "viem";
import {
  BradburySubmitterProblem,
  createBradburySubmitterClient,
  loadBradburySubmitterConfig,
} from "./bradbury-submitter-client.ts";
import {
  buildMetricsSubmissionEnvelope,
  type MetricsSubmissionEnvelope,
  type MetricsSubmitterSubmission,
  type VerifiedMetricsResult,
} from "./metrics-submission.ts";
import {
  readVerifiedMetricsProfileBinding,
  type VerifiedMetricsProfileBinding,
} from "./marketplace-metrics-binding.ts";
import { estimateMarketplaceCreatorPay } from "./marketplace-pay-estimate.ts";
import {
  attachFinalizedCreatorMetricsSnapshot,
  expireProfileIfNeeded,
  findCreatorProfileByWallet,
  latestMetricsForProfile,
  type CreatorMetricsRow,
  type CreatorProfileRow,
} from "./marketplace-repository.ts";
import { formatUsdcAmount } from "./marketplace-core.ts";
import type { MarketplaceMetricsDto } from "./marketplace-types.ts";
import { ApiProblem } from "./verification-api.ts";
import type { AuthenticatedWalletSession } from "./wallet-session.ts";

export const METRICS_REFRESH_SLOT_SECONDS = 6 * 60 * 60;
export const METRICS_JOB_EXPIRY_SECONDS = 6 * 24 * 60 * 60;
export const METRICS_MIN_FINALITY_WINDOW_SECONDS = 30 * 60;
export const METRICS_MAX_MEASUREMENT_AGE_SECONDS = 24 * 60 * 60;
export const METRICS_RESULT_CLOCK_SKEW_SECONDS = 5 * 60;
const METRICS_FRESH_MS = METRICS_REFRESH_SLOT_SECONDS * 1_000;

export type MarketplaceMetricsRefreshProjection = Readonly<{
  requestId: Hex;
  status: "NOT_SUBMITTED" | MetricsSubmitterSubmission["status"];
  resultOutcome: MetricsSubmitterSubmission["resultOutcome"];
  txHash: Hex | null;
  errorCode: string | null;
  metrics: MarketplaceMetricsDto | null;
}>;

export async function refreshMarketplaceCreatorMetrics(input: {
  wallet: string;
  session: AuthenticatedWalletSession;
  nowMs?: number;
}): Promise<MarketplaceMetricsRefreshProjection> {
  return advanceMarketplaceCreatorMetrics({ ...input, dispatch: true });
}

export async function getMarketplaceCreatorMetricsStatus(input: {
  wallet: string;
  session: AuthenticatedWalletSession;
  nowMs?: number;
}): Promise<MarketplaceMetricsRefreshProjection> {
  return advanceMarketplaceCreatorMetrics({ ...input, dispatch: false });
}

async function advanceMarketplaceCreatorMetrics(input: {
  wallet: string;
  session: AuthenticatedWalletSession;
  dispatch: boolean;
  nowMs?: number;
}): Promise<MarketplaceMetricsRefreshProjection> {
  const nowMs = input.nowMs ?? Date.now();
  const nowEpoch = exactNowEpoch(nowMs);
  const wallet = canonicalWallet(input.wallet);
  if (wallet !== input.session.wallet) {
    throw new ApiProblem(
      403,
      "CREATOR_PROFILE_OWNER_REQUIRED",
      "Only the wallet that owns this creator profile can refresh its metrics.",
    );
  }
  const found = await findCreatorProfileByWallet(wallet);
  if (!found) {
    throw new ApiProblem(
      404,
      "CREATOR_PROFILE_NOT_FOUND",
      "Verify this wallet's X account before requesting creator metrics.",
    );
  }
  const profile = await expireProfileIfNeeded(found, nowMs);
  requireActiveProfile(profile, nowMs);

  const current = await latestMetricsForProfile(profile, nowMs);
  if (current && current.capturedAt >= nowMs - METRICS_FRESH_MS) {
    return finalizedSnapshotProjection(current);
  }

  const binding = await verifiedProfileBinding(profile, nowEpoch);
  const candidates = metricsEnvelopeCandidates(binding, nowEpoch);
  if (candidates.length === 0) {
    throw new ApiProblem(
      409,
      "CREATOR_REVERIFICATION_REQUIRED",
      "The Base creator credential expires too soon for a new metrics snapshot. Reverify the X account first.",
    );
  }
  const config = await loadBradburySubmitterConfig();
  const client = createBradburySubmitterClient(config);

  let envelope = candidates[0];
  let remote: MetricsSubmitterSubmission | null = null;
  try {
    for (const candidate of candidates) {
      const existing = await client.metricsStatus(candidate.requestId);
      if (existing) {
        envelope = candidate;
        remote = existing;
        break;
      }
    }
    if (!remote && input.dispatch) {
      remote = (await client.submitMetrics(envelope)).submission;
    }
  } catch (error) {
    throw submitterFailure(error);
  }

  if (!remote) {
    return Object.freeze({
      requestId: envelope.requestId,
      status: "NOT_SUBMITTED",
      resultOutcome: null,
      txHash: null,
      errorCode: null,
      metrics: current ? metricsDto(current) : null,
    });
  }
  assertRemoteEnvelope(remote, envelope);
  let metrics = current;
  if (remote.status === "FINALIZED" && remote.resultOutcome === "VERIFIED") {
    const result = assertVerifiedMetricsFinality({
      envelope,
      binding,
      submission: remote,
      nowEpoch,
    });
    const estimate = estimateMarketplaceCreatorPay({
      metrics: result,
      contentType: "text",
      nowEpoch: result.measured_at_epoch,
    });
    const medianEngagementCount = safeMedianEngagement(result);
    metrics = await attachFinalizedCreatorMetricsSnapshot({
      profileId: profile.id,
      requestId: envelope.requestId,
      txHash: requiredTxHash(remote.txHash),
      followersCount: result.followers,
      accountCreatedAt: result.account_created_at_ms,
      postsSampled: result.posts_analyzed,
      medianEngagementCount,
      engagementRateBps: result.engagement_rate_bps,
      estimatedPayMinAmount: estimate.minimumUsdc.toString(),
      estimatedPayMaxAmount: estimate.maximumUsdc.toString(),
      riskLevel: metricsRiskLevel(result.engagement_consistency),
      evidenceHash: metricsEvidenceHash(result),
      capturedAt: result.measured_at_epoch * 1_000,
      expiresAt: result.metrics_expires_at_epoch * 1_000,
      nowMs,
    });
  }
  return Object.freeze({
    requestId: envelope.requestId,
    status: remote.status,
    resultOutcome: remote.resultOutcome,
    txHash: remote.txHash,
    errorCode: remote.errorCode,
    metrics: metrics ? metricsDto(metrics) : null,
  });
}

export function metricsEnvelopeCandidates(
  binding: VerifiedMetricsProfileBinding,
  nowEpoch: number,
): readonly MetricsSubmissionEnvelope[] {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch <= 0) {
    throw new Error("Metrics clock is invalid.");
  }
  const currentSlot =
    Math.floor(nowEpoch / METRICS_REFRESH_SLOT_SECONDS) *
    METRICS_REFRESH_SLOT_SECONDS;
  const expiries = [currentSlot, currentSlot - METRICS_REFRESH_SLOT_SECONDS]
    .map((slot) =>
      Math.min(
        slot + METRICS_JOB_EXPIRY_SECONDS,
        binding.credentialExpiresAtEpoch,
      ),
    )
    .filter(
      (expiry, index, values) =>
        expiry - nowEpoch >= METRICS_MIN_FINALITY_WINDOW_SECONDS &&
        values.indexOf(expiry) === index,
    );
  return Object.freeze(
    expiries.map((metricsExpiresAtEpoch) =>
      buildMetricsSubmissionEnvelope({
        baseWallet: binding.wallet,
        identityHash: binding.identityHash,
        expectedHandle: binding.expectedHandle,
        metricsExpiresAtEpoch,
        nowEpoch,
      }),
    ),
  );
}

export function assertVerifiedMetricsFinality(input: {
  envelope: MetricsSubmissionEnvelope;
  binding: VerifiedMetricsProfileBinding;
  submission: MetricsSubmitterSubmission;
  nowEpoch: number;
}): VerifiedMetricsResult {
  const result = input.submission.resultData;
  if (
    input.submission.status !== "FINALIZED" ||
    input.submission.resultOutcome !== "VERIFIED" ||
    !result ||
    !input.submission.txHash
  ) {
    throw new Error("The metrics submission is not a finalized verified result.");
  }
  if (
    input.submission.requestId !== input.envelope.requestId ||
    result.request_id !== input.envelope.requestId ||
    result.base_wallet !== input.binding.wallet ||
    result.base_wallet !== input.envelope.baseWallet ||
    result.identity_hash !== input.binding.identityHash ||
    result.identity_hash !== input.envelope.identityHash ||
    result.handle !== input.binding.expectedHandle ||
    result.handle !== input.envelope.expectedHandle ||
    result.metrics_expires_at_epoch !== input.envelope.metricsExpiresAtEpoch
  ) {
    throw new Error("The finalized metrics result is bound to another profile or request.");
  }
  if (
    result.measured_at_epoch > input.nowEpoch + METRICS_RESULT_CLOCK_SKEW_SECONDS ||
    input.nowEpoch - result.measured_at_epoch >
      METRICS_MAX_MEASUREMENT_AGE_SECONDS ||
    result.metrics_expires_at_epoch <= input.nowEpoch
  ) {
    throw new Error("The finalized metrics result is not fresh.");
  }
  safeMedianEngagement(result);
  return result;
}

export function metricsEvidenceHash(result: VerifiedMetricsResult): Hex {
  const entries = Object.entries(result).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return keccak256(stringToHex(JSON.stringify(Object.fromEntries(entries))));
}

function safeMedianEngagement(result: VerifiedMetricsResult): number {
  const value =
    result.median_likes + result.median_replies + result.median_reposts;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Median engagement exceeds the safe persistence range.");
  }
  return value;
}

function metricsRiskLevel(
  value: VerifiedMetricsResult["engagement_consistency"],
): "LOW" | "MEDIUM" | "HIGH" | "UNDETERMINED" {
  if (value === "LOW_RISK") return "LOW";
  if (value === "MEDIUM_RISK") return "MEDIUM";
  if (value === "HIGH_RISK") return "HIGH";
  return "UNDETERMINED";
}

function finalizedSnapshotProjection(
  row: CreatorMetricsRow,
): MarketplaceMetricsRefreshProjection {
  const txHash = requiredTxHash(row.genlayerTxHash);
  const requestId = requiredHash(row.genlayerRequestId, "metrics request ID");
  return Object.freeze({
    requestId,
    status: "FINALIZED",
    resultOutcome: "VERIFIED",
    txHash,
    errorCode: null,
    metrics: metricsDto(row),
  });
}

function metricsDto(row: CreatorMetricsRow): MarketplaceMetricsDto {
  return {
    id: row.id,
    followersCount: String(row.followersCount),
    accountCreatedAt: new Date(row.accountCreatedAt).toISOString(),
    postsSampled: row.postsSampled,
    medianEngagementCount: String(row.medianEngagementCount),
    engagementRateBps: row.engagementRateBps,
    estimatedPayMinUsdc: formatUsdcAmount(row.estimatedPayMinAmount),
    estimatedPayMaxUsdc: formatUsdcAmount(row.estimatedPayMaxAmount),
    riskLevel: row.riskLevel.toLowerCase() as MarketplaceMetricsDto["riskLevel"],
    evidenceHash: row.evidenceHash,
    capturedAt: new Date(row.capturedAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
  };
}

function requireActiveProfile(profile: CreatorProfileRow, nowMs: number): void {
  if (!profile.active || profile.credentialExpiresAt <= nowMs) {
    throw new ApiProblem(
      409,
      "CREATOR_REVERIFICATION_REQUIRED",
      "The Base creator credential is inactive or expired. Reverify the X account first.",
    );
  }
  if (!profile.publicHandle || !/^[a-z0-9_]{1,15}$/.test(profile.publicHandle)) {
    throw new ApiProblem(
      409,
      "CREATOR_HANDLE_REQUIRED",
      "The verified creator profile has no canonical public X handle.",
    );
  }
}

async function verifiedProfileBinding(
  profile: CreatorProfileRow,
  nowEpoch: number,
): Promise<VerifiedMetricsProfileBinding> {
  try {
    return await readVerifiedMetricsProfileBinding({ profile, nowEpoch });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/mismatch|inactive|expired|no canonical/i.test(message)) {
      throw new ApiProblem(
        409,
        "BASE_PROFILE_BINDING_MISMATCH",
        "The persisted creator profile no longer matches the active Base registry profile.",
      );
    }
    throw new ApiProblem(
      503,
      "BASE_PROFILE_CHECK_UNAVAILABLE",
      "The active Base creator profile could not be checked. Retry shortly.",
    );
  }
}

function assertRemoteEnvelope(
  remote: MetricsSubmitterSubmission,
  envelope: MetricsSubmissionEnvelope,
): void {
  if (
    remote.requestId !== envelope.requestId ||
    remote.functionName !== "snapshot_metrics"
  ) {
    throw new ApiProblem(
      502,
      "GENLAYER_SUBMITTER_MISMATCH",
      "The GenLayer submitter returned another metrics job.",
    );
  }
}

function submitterFailure(error: unknown): ApiProblem {
  if (error instanceof BradburySubmitterProblem) {
    return new ApiProblem(
      503,
      error.ambiguous ? "GENLAYER_SUBMISSION_OUTCOME_UNKNOWN" : error.code,
      error.ambiguous
        ? "The metrics submission outcome is unknown; retrying this exact request is safe."
        : error.message,
    );
  }
  return new ApiProblem(
    503,
    "GENLAYER_SUBMITTER_UNAVAILABLE",
    "GenLayer creator metrics are temporarily unavailable.",
  );
}

function canonicalWallet(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new ApiProblem(400, "INVALID_REQUEST", "wallet is invalid.");
  }
  return normalized;
}

function exactNowEpoch(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("Metrics clock is invalid.");
  }
  return Math.floor(nowMs / 1_000);
}

function requiredHash(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Hex;
}

function requiredTxHash(value: unknown): Hex {
  return requiredHash(value, "GenLayer transaction hash");
}
