export const PAY_ESTIMATE_METHODOLOGY = 'adproof-x-estimate-v1';

const CONTENT_MULTIPLIERS = Object.freeze({ text: 1, thread: 1.3, image: 1.45, video: 2 });
const CONSISTENCY_MULTIPLIERS = Object.freeze({
  LOW_RISK: 1,
  MEDIUM_RISK: 0.78,
  HIGH_RISK: 0.5,
  INSUFFICIENT: 0.65,
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteNonnegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a nonnegative number`);
  return value;
}

export function estimateCreatorPay({
  metrics,
  contentType,
  usageRightsDays = 0,
  exclusivityDays = 0,
  nowEpoch = Math.floor(Date.now() / 1_000),
}) {
  if (!CONTENT_MULTIPLIERS[contentType]) throw new Error('Unsupported content type');
  if (!CONSISTENCY_MULTIPLIERS[metrics.engagement_consistency]) throw new Error('Invalid consistency signal');
  const followers = finiteNonnegative(metrics.followers, 'followers');
  const medianEngagement = finiteNonnegative(
    metrics.median_likes + metrics.median_replies + metrics.median_reposts,
    'median engagement',
  );
  const postsAnalyzed = finiteNonnegative(metrics.posts_analyzed, 'posts analyzed');
  finiteNonnegative(usageRightsDays, 'usage rights days');
  finiteNonnegative(exclusivityDays, 'exclusivity days');

  const accountAgeDays = Math.max(0, (nowEpoch - Math.floor(metrics.account_created_at_ms / 1_000)) / 86_400);
  const observedRate = followers > 0 ? medianEngagement / followers : 0;
  const audienceCents = Math.min(500_000, 2_500 + Math.sqrt(followers) * 280);
  const engagementMultiplier = clamp(observedRate / 0.0025, 0.7, 2.4);
  const ageMultiplier = accountAgeDays < 90 ? 0.75 : accountAgeDays < 365 ? 0.9 : 1;
  const evidenceMultiplier = postsAnalyzed >= 10 ? 1 : postsAnalyzed >= 5 ? 0.9 : 0.72;
  const rightsMultiplier = 1 + Math.min(usageRightsDays, 365) / 365 * 0.75;
  const exclusivityMultiplier = 1 + Math.min(exclusivityDays, 90) / 90 * 0.5;
  const targetCents = Math.round(
    audienceCents
      * engagementMultiplier
      * ageMultiplier
      * evidenceMultiplier
      * CONSISTENCY_MULTIPLIERS[metrics.engagement_consistency]
      * CONTENT_MULTIPLIERS[contentType]
      * rightsMultiplier
      * exclusivityMultiplier,
  );
  const riskFlags = [];
  if (accountAgeDays < 90) riskFlags.push('NEW_ACCOUNT');
  if (metrics.engagement_consistency === 'HIGH_RISK') riskFlags.push('ENGAGEMENT_OUTLIER_HIGH_RISK');
  if (metrics.engagement_consistency === 'MEDIUM_RISK') riskFlags.push('ENGAGEMENT_OUTLIER_MEDIUM_RISK');
  if (postsAnalyzed < 5 || metrics.engagement_consistency === 'INSUFFICIENT') riskFlags.push('INSUFFICIENT_PUBLIC_SAMPLE');
  if (followers > 10_000 && medianEngagement === 0) riskFlags.push('FOLLOWER_ENGAGEMENT_MISMATCH');

  const confidence = riskFlags.includes('ENGAGEMENT_OUTLIER_HIGH_RISK') || postsAnalyzed < 5
    ? 'LOW'
    : postsAnalyzed >= 10 && riskFlags.length === 0 ? 'HIGH' : 'MEDIUM';
  const centsToUsdcMicros = (cents) => BigInt(Math.max(0, cents)) * 10_000n;
  return {
    methodology: PAY_ESTIMATE_METHODOLOGY,
    minimumUsdc: centsToUsdcMicros(Math.round(targetCents * 0.8)),
    targetUsdc: centsToUsdcMicros(targetCents),
    maximumUsdc: centsToUsdcMicros(Math.round(targetCents * 1.25)),
    confidence,
    riskFlags,
    explanation: 'Marketplace estimate only; the creator chooses their application price and the brand chooses whether to accept it.',
  };
}
