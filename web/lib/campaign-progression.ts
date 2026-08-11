import { randomUUID, timingSafeEqual } from "node:crypto";
import { advanceMarketplaceGenLayerResolutionByRequestId } from "./marketplace-genlayer-bridge.ts";
import {
  claimMarketplaceProgressionByRequestId,
  claimNextMarketplaceProgression,
  findMarketplaceResolutionContextByRequestId,
  finishMarketplaceProgression,
  type MarketplaceProgressionClaim,
} from "./marketplace-repository.ts";
import { ApiProblem } from "./verification-api.ts";

const DEFAULT_BATCH_SIZE = 3;
const MAX_BATCH_SIZE = 8;
const LEASE_DURATION_MS = 4 * 60 * 1_000;
const ACTIVE_POLL_DELAY_MS = 45 * 1_000;
const MIN_RETRY_DELAY_MS = 60 * 1_000;
const MAX_RETRY_DELAY_MS = 15 * 60 * 1_000;

type ProgressionResult = Awaited<
  ReturnType<typeof advanceMarketplaceGenLayerResolutionByRequestId>
>;

export type CampaignProgressionDependencies = Readonly<{
  nowMs?: () => number;
  assertConfigured?: () => void | Promise<void>;
  randomFenceToken?: () => string;
  claim?: typeof claimNextMarketplaceProgression;
  claimByRequestId?: typeof claimMarketplaceProgressionByRequestId;
  findContext?: typeof findMarketplaceResolutionContextByRequestId;
  advance?: typeof advanceMarketplaceGenLayerResolutionByRequestId;
  finish?: typeof finishMarketplaceProgression;
}>;

export type CampaignProgressionBatchResult = Readonly<{
  claimed: number;
  advanced: number;
  finalized: number;
  retryScheduled: number;
  terminal: number;
  leaseLost: number;
  capped: boolean;
}>;

type ClaimResult = Readonly<{
  kind: "ADVANCED" | "FINALIZED" | "RETRY_SCHEDULED" | "TERMINAL" | "LEASE_LOST";
}>;

const TERMINAL_GENLAYER_STATUSES = new Set([
  "PRECHECK_FAILED",
  "EXECUTION_FAILED",
  "NETWORK_TERMINATED",
  "RECONCILIATION_REQUIRED",
  "POLLING_EXHAUSTED",
  "POISONED",
]);

/**
 * Advances a bounded set of due campaign resolutions. Claims are fenced in
 * Neon before any network call and are processed concurrently so one slow Base
 * receipt cannot make the batch unbounded. The submitter and relay remain the
 * only services that know how to broadcast; this worker stores no signer key.
 */
export async function runCampaignProgressionBatch(options: {
  batchSize?: number;
  dependencies?: CampaignProgressionDependencies;
} = {}): Promise<CampaignProgressionBatchResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error("The campaign progression batch size is invalid.");
  }
  const dependencies = options.dependencies ?? {};
  await (dependencies.assertConfigured ?? assertCampaignProgressionConfigured)();
  const now = dependencies.nowMs ?? Date.now;
  const claim = dependencies.claim ?? claimNextMarketplaceProgression;
  const randomFenceToken = dependencies.randomFenceToken ?? randomUUID;
  const claims: MarketplaceProgressionClaim[] = [];
  for (let index = 0; index < batchSize; index += 1) {
    const nowMs = checkedNow(now());
    const claimed = await claim({
      fenceToken: randomFenceToken(),
      nowMs,
      leaseDurationMs: LEASE_DURATION_MS,
    });
    if (!claimed) break;
    claims.push(claimed);
  }

  const results = await Promise.all(
    claims.map((claimed) => processClaim(claimed, dependencies, now)),
  );
  return Object.freeze({
    claimed: claims.length,
    advanced: results.filter((result) => result.kind === "ADVANCED").length,
    finalized: results.filter((result) => result.kind === "FINALIZED").length,
    retryScheduled: results.filter((result) => result.kind === "RETRY_SCHEDULED").length,
    terminal: results.filter((result) => result.kind === "TERMINAL").length,
    leaseLost: results.filter((result) => result.kind === "LEASE_LOST").length,
    capped: claims.length === batchSize,
  });
}

/**
 * Processes exactly one request-bound queue message. Any nonterminal result is
 * surfaced as a retry signal; the queue controls redelivery while the Neon
 * fence remains the authoritative idempotency boundary.
 */
export async function processQueuedCampaignProgression(input: {
  requestId: string;
  campaignId: string;
  applicationId: string;
  dependencies?: CampaignProgressionDependencies;
}): Promise<Readonly<{ kind: "FINALIZED" | "TERMINAL" }>> {
  const dependencies = input.dependencies ?? {};
  await (dependencies.assertConfigured ?? assertCampaignProgressionConfigured)();
  const now = dependencies.nowMs ?? Date.now;
  const nowMs = checkedNow(now());
  const claimed = await (
    dependencies.claimByRequestId ?? claimMarketplaceProgressionByRequestId
  )({
    requestId: input.requestId,
    expectedApplicationId: input.applicationId,
    expectedCampaignId: input.campaignId,
    fenceToken: (dependencies.randomFenceToken ?? randomUUID)(),
    nowMs,
    leaseDurationMs: LEASE_DURATION_MS,
  });
  if (!claimed) {
    const context = await (
      dependencies.findContext ?? findMarketplaceResolutionContextByRequestId
    )(input.requestId);
    if (!context) return Object.freeze({ kind: "TERMINAL" });
    if (
      context.application.id !== input.applicationId ||
      context.campaign.id !== input.campaignId
    ) {
      throw new CampaignProgressionPoisonError(
        "The queue message no longer matches its persisted campaign binding.",
      );
    }
    if (
      context.application.resolutionTxHash !== null ||
      ["PAID", "REFUNDED", "CANCELLED"].includes(context.campaign.status)
    ) {
      return Object.freeze({ kind: "TERMINAL" });
    }
    if (TERMINAL_GENLAYER_STATUSES.has(context.application.genlayerSubmitterStatus ?? "")) {
      return Object.freeze({ kind: "TERMINAL" });
    }
    throw new CampaignProgressionRetryError(
      "The campaign progression lease is busy or not due yet.",
    );
  }

  const result = await processClaim(claimed, dependencies, now);
  if (result.kind === "FINALIZED" || result.kind === "TERMINAL") {
    return Object.freeze({ kind: result.kind });
  }
  throw new CampaignProgressionRetryError(
    result.kind === "LEASE_LOST"
      ? "The campaign progression lease changed before completion."
      : "The campaign resolution is not terminal yet.",
  );
}

export class CampaignProgressionRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignProgressionRetryError";
  }
}

export class CampaignProgressionPoisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignProgressionPoisonError";
  }
}

export function campaignProgressionQueueRetryDelaySeconds(
  deliveryCount: number,
): number {
  if (!Number.isSafeInteger(deliveryCount) || deliveryCount < 1) return 60;
  return Math.min(15 * 60, 60 * 2 ** Math.min(deliveryCount - 1, 4));
}

export function campaignProgressionRequestIsAuthorized(
  request: Request,
  secret: string,
): boolean {
  if (Buffer.byteLength(secret, "utf8") < 32) return false;
  const provided = request.headers.get("authorization");
  if (!provided) return false;
  const expectedBytes = Buffer.from(`Bearer ${secret}`, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
}

/** Fail before claiming work if any hosted boundary is disabled or malformed. */
export function assertCampaignProgressionConfigured(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const marketplaceEnabled = env.XPROOF_MARKETPLACE_MUTATIONS_ENABLED === undefined
    ? env.XPROOF_VERIFICATION_MUTATIONS_ENABLED === "true"
    : env.XPROOF_MARKETPLACE_MUTATIONS_ENABLED === "true";
  if (!marketplaceEnabled) throw configurationError();
  if (env.XPROOF_SUBMITTER_BRIDGE_ENABLED !== "true") throw configurationError();
  if (env.XPROOF_CAMPAIGN_RELAY_BRIDGE_ENABLED !== "true") throw configurationError();
  exactHttpsOrigin(env.XPROOF_SUBMITTER_URL);
  exactHttpsOrigin(env.XPROOF_CAMPAIGN_RELAY_URL);
  const relayToken = env.XPROOF_CAMPAIGN_RELAY_SERVICE_TOKEN;
  if (
    typeof relayToken !== "string" ||
    Buffer.byteLength(relayToken, "utf8") < 32 ||
    Buffer.byteLength(relayToken, "utf8") > 256
  ) {
    throw configurationError();
  }
  const databaseUrl = env.DATABASE_URL;
  if (typeof databaseUrl !== "string") throw configurationError();
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw configurationError();
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
    throw configurationError();
  }
}

async function processClaim(
  claim: MarketplaceProgressionClaim,
  dependencies: CampaignProgressionDependencies,
  now: () => number,
): Promise<ClaimResult> {
  const advance = dependencies.advance ?? advanceMarketplaceGenLayerResolutionByRequestId;
  const finish = dependencies.finish ?? finishMarketplaceProgression;
  try {
    const result = await advance({
      requestId: claim.requestId,
      expectedApplicationId: claim.applicationId,
      expectedCampaignId: claim.campaignId,
      nowMs: checkedNow(now()),
    });
    const completion = completionFor(result, checkedNow(now()));
    const owned = await finish({
      applicationId: claim.applicationId,
      fenceToken: claim.fenceToken,
      nextAttemptAt: completion.nextAttemptAt,
      errorCode: completion.errorCode,
      nowMs: completion.nowMs,
    });
    if (!owned) return Object.freeze({ kind: "LEASE_LOST" });
    return Object.freeze({ kind: completion.kind });
  } catch (error) {
    const nowMs = checkedNow(now());
    const owned = await finish({
      applicationId: claim.applicationId,
      fenceToken: claim.fenceToken,
      nextAttemptAt: nowMs + retryDelayMs(claim.attemptCount),
      errorCode: safeProgressionErrorCode(error),
      nowMs,
    });
    return Object.freeze({ kind: owned ? "RETRY_SCHEDULED" : "LEASE_LOST" });
  }
}

function completionFor(result: ProgressionResult, nowMs: number): Readonly<{
  kind: "ADVANCED" | "FINALIZED" | "TERMINAL";
  nowMs: number;
  nextAttemptAt: number;
  errorCode: string | null;
}> {
  if (result.submission.status === "FINALIZED") {
    if (result.settlement?.status !== "CONFIRMED" || !result.settlement.broadcast) {
      throw new ApiProblem(
        503,
        result.settlement?.status === "SIMULATED"
          ? "BASE_RELAY_BROADCAST_DISABLED"
          : "BASE_RELAY_CONFIGURATION_REQUIRED",
        "The finalized campaign cannot be marked settled without a confirmed Base broadcast.",
      );
    }
    return Object.freeze({
      kind: "FINALIZED",
      nowMs,
      nextAttemptAt: nowMs,
      errorCode: null,
    });
  }
  if (TERMINAL_GENLAYER_STATUSES.has(result.submission.status)) {
    return Object.freeze({
      kind: "TERMINAL",
      nowMs,
      nextAttemptAt: nowMs,
      errorCode: safeProjectionCode(result.submission.errorCode),
    });
  }
  return Object.freeze({
    kind: "ADVANCED",
    nowMs,
    nextAttemptAt: nowMs + ACTIVE_POLL_DELAY_MS,
    errorCode: null,
  });
}

function retryDelayMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(0, attemptCount - 1), 8);
  return Math.min(MAX_RETRY_DELAY_MS, MIN_RETRY_DELAY_MS * 2 ** exponent);
}

function safeProgressionErrorCode(error: unknown): string {
  if (error instanceof ApiProblem && /^[A-Z0-9_]{1,64}$/.test(error.code)) {
    return error.code;
  }
  return "CAMPAIGN_PROGRESSION_FAILED";
}

function safeProjectionCode(value: string | null): string | null {
  return value && /^[A-Z0-9_]{1,64}$/.test(value)
    ? value
    : "GENLAYER_TERMINAL";
}

function checkedNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("The campaign progression clock is invalid.");
  }
  return value;
}

function exactHttpsOrigin(value: unknown): string {
  if (typeof value !== "string") throw configurationError();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.port
  ) {
    throw configurationError();
  }
  return url.origin;
}

function configurationError(): ApiProblem {
  return new ApiProblem(
    503,
    "CAMPAIGN_PROGRESSION_CONFIGURATION_REQUIRED",
    "Automatic campaign progression is unavailable.",
  );
}
