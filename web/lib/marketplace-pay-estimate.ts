import type { VerifiedMetricsResult } from "./metrics-submission.ts";

export const INFLUENCEDX_PAY_ESTIMATE_METHODOLOGY =
  "adproof-x-estimate-v1" as const;

const CONTENT_MULTIPLIERS = Object.freeze({
  text: 1,
  thread: 1.3,
  image: 1.45,
  video: 2,
});
const CONSISTENCY_MULTIPLIERS = Object.freeze({
  LOW_RISK: 1,
  MEDIUM_RISK: 0.78,
  HIGH_RISK: 0.5,
  INSUFFICIENT: 0.65,
});

/** Exact TypeScript port of src/marketplace/pay-estimate.mjs. */
export function estimateMarketplaceCreatorPay(input: {
  metrics: Pick<
    VerifiedMetricsResult,
    | "followers"
    | "median_likes"
    | "median_replies"
    | "median_reposts"
    | "posts_analyzed"
    | "account_created_at_ms"
    | "engagement_consistency"
  >;
  contentType?: keyof typeof CONTENT_MULTIPLIERS;
  usageRightsDays?: number;
  exclusivityDays?: number;
  nowEpoch?: number;
}) {
  const contentType = input.contentType ?? "text";
  const usageRightsDays = input.usageRightsDays ?? 0;
  const exclusivityDays = input.exclusivityDays ?? 0;
  const nowEpoch = input.nowEpoch ?? Math.floor(Date.now() / 1_000);
  const followers = finiteNonnegative(input.metrics.followers, "followers");
  const medianEngagement = safeNonnegativeInteger(
    input.metrics.median_likes + input.metrics.median_replies + input.metrics.median_reposts,
    "median engagement",
  );
  const postsAnalyzed = finiteNonnegative(input.metrics.posts_analyzed, "posts analyzed");
  finiteNonnegative(usageRightsDays, "usage rights days");
  finiteNonnegative(exclusivityDays, "exclusivity days");
  finiteNonnegative(nowEpoch, "now epoch");

  const accountAgeDays = Math.max(
    0,
    (nowEpoch - Math.floor(input.metrics.account_created_at_ms / 1_000)) / 86_400,
  );
  const observedRate = followers > 0 ? medianEngagement / followers : 0;
  const audienceCents = Math.min(500_000, 2_500 + Math.sqrt(followers) * 280);
  const engagementMultiplier = clamp(observedRate / 0.0025, 0.7, 2.4);
  const ageMultiplier = accountAgeDays < 90 ? 0.75 : accountAgeDays < 365 ? 0.9 : 1;
  const evidenceMultiplier = postsAnalyzed >= 10 ? 1 : postsAnalyzed >= 5 ? 0.9 : 0.72;
  const rightsMultiplier = 1 + Math.min(usageRightsDays, 365) / 365 * 0.75;
  const exclusivityMultiplier = 1 + Math.min(exclusivityDays, 90) / 90 * 0.5;
  const targetCents = Math.round(
    audienceCents *
      engagementMultiplier *
      ageMultiplier *
      evidenceMultiplier *
      CONSISTENCY_MULTIPLIERS[input.metrics.engagement_consistency] *
      CONTENT_MULTIPLIERS[contentType] *
      rightsMultiplier *
      exclusivityMultiplier,
  );
  const riskFlags: string[] = [];
  if (accountAgeDays < 90) riskFlags.push("NEW_ACCOUNT");
  if (input.metrics.engagement_consistency === "HIGH_RISK") {
    riskFlags.push("ENGAGEMENT_OUTLIER_HIGH_RISK");
  }
  if (input.metrics.engagement_consistency === "MEDIUM_RISK") {
    riskFlags.push("ENGAGEMENT_OUTLIER_MEDIUM_RISK");
  }
  if (postsAnalyzed < 5 || input.metrics.engagement_consistency === "INSUFFICIENT") {
    riskFlags.push("INSUFFICIENT_PUBLIC_SAMPLE");
  }
  if (followers > 10_000 && medianEngagement === 0) {
    riskFlags.push("FOLLOWER_ENGAGEMENT_MISMATCH");
  }
  const confidence = riskFlags.includes("ENGAGEMENT_OUTLIER_HIGH_RISK") || postsAnalyzed < 5
    ? "LOW"
    : postsAnalyzed >= 10 && riskFlags.length === 0
      ? "HIGH"
      : "MEDIUM";
  const centsToUsdcMicros = (cents: number) =>
    BigInt(Math.max(0, cents)) * 10_000n;
  return Object.freeze({
    methodology: INFLUENCEDX_PAY_ESTIMATE_METHODOLOGY,
    minimumUsdc: centsToUsdcMicros(Math.round(targetCents * 0.8)),
    targetUsdc: centsToUsdcMicros(targetCents),
    maximumUsdc: centsToUsdcMicros(Math.round(targetCents * 1.25)),
    confidence,
    riskFlags: Object.freeze(riskFlags),
    explanation:
      "Marketplace estimate only; the creator chooses their application price and the brand chooses whether to accept it.",
  });
}

function finiteNonnegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative number.`);
  }
  return value;
}

function safeNonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer.`);
  }
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
