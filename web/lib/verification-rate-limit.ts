import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import { getDb } from "../db/index.ts";
import { verificationRateLimits } from "../db/schema.ts";
import { ApiProblem } from "./verification-api.ts";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const MIN_SECRET_BYTES = 32;

type RateLimitIdentity = "ip" | "subject" | "wallet" | "request";

type RateLimitRule = {
  identity: RateLimitIdentity;
  policyKey: string;
  limit: number;
  windowMs: number;
};

export type VerificationRateLimitPolicy =
  | "challenge"
  | "authorize"
  | "x-challenge"
  | "intent"
  | "submit"
  | "marketplace-campaign-create"
  | "marketplace-apply"
  | "marketplace-select"
  | "marketplace-accept"
  | "marketplace-metrics-refresh"
  | "marketplace-metrics-status";

export type VerificationRateLimitContext = {
  subject?: string | null;
  wallet?: string | null;
  requestId?: string | null;
};

export type AtomicRateLimitInput = {
  policyKey: string;
  bucketHash: string;
  limit: number;
  windowStartedAt: number;
  windowExpiresAt: number;
  nowMs: number;
};

export type AtomicRateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtMs: number;
};

export type AtomicRateLimitStore = {
  consume(input: AtomicRateLimitInput): Promise<AtomicRateLimitDecision>;
};

type RateLimitRuntime = {
  nodeEnv?: string;
  vercel?: boolean;
};

export type VerificationRateLimitOptions = {
  nowMs?: number;
  runtime?: RateLimitRuntime;
  secret?: string;
  store?: AtomicRateLimitStore;
};

const POLICY_LABELS: Record<VerificationRateLimitPolicy, string> = {
  challenge: "verification-challenge-v1",
  authorize: "verification-authorize-v1",
  "x-challenge": "verification-x-challenge-v1",
  intent: "verification-intent-v1",
  submit: "verification-submit-v1",
  "marketplace-campaign-create": "marketplace-campaign-create-v1",
  "marketplace-apply": "marketplace-apply-v1",
  "marketplace-select": "marketplace-select-v1",
  "marketplace-accept": "marketplace-accept-v1",
  "marketplace-metrics-refresh": "marketplace-metrics-refresh-v1",
  "marketplace-metrics-status": "marketplace-metrics-status-v1",
};

/**
 * Policy keys are versioned deliberately. Any quota/window change must receive
 * a new suffix so an in-flight fixed window never changes semantics halfway
 * through the window.
 */
export const VERIFICATION_RATE_LIMIT_RULES: Readonly<
  Record<VerificationRateLimitPolicy, readonly RateLimitRule[]>
> = {
  challenge: [
    {
      identity: "ip",
      policyKey: "verification.challenge.ip.v1",
      limit: 20,
      windowMs: 10 * MINUTE_MS,
    },
    {
      identity: "subject",
      policyKey: "verification.challenge.subject.v1",
      limit: 5,
      windowMs: 10 * MINUTE_MS,
    },
  ],
  authorize: [
    {
      identity: "ip",
      policyKey: "verification.authorize.ip.v1",
      limit: 30,
      windowMs: 10 * MINUTE_MS,
    },
    {
      identity: "subject",
      policyKey: "verification.authorize.subject.v1",
      limit: 10,
      windowMs: 10 * MINUTE_MS,
    },
  ],
  "x-challenge": [
    {
      identity: "ip",
      policyKey: "verification.x-challenge.ip.v1",
      limit: 20,
      windowMs: HOUR_MS,
    },
    {
      identity: "subject",
      policyKey: "verification.x-challenge.subject.v1",
      limit: 5,
      windowMs: HOUR_MS,
    },
    {
      identity: "wallet",
      policyKey: "verification.x-challenge.wallet.v1",
      limit: 5,
      windowMs: HOUR_MS,
    },
  ],
  intent: [
    {
      identity: "ip",
      policyKey: "verification.intent.ip.v1",
      limit: 60,
      windowMs: HOUR_MS,
    },
    {
      identity: "subject",
      policyKey: "verification.intent.subject.v1",
      limit: 20,
      windowMs: HOUR_MS,
    },
    {
      identity: "wallet",
      policyKey: "verification.intent.wallet.v1",
      limit: 20,
      windowMs: HOUR_MS,
    },
    {
      identity: "request",
      policyKey: "verification.intent.request.v1",
      limit: 20,
      windowMs: HOUR_MS,
    },
  ],
  submit: [
    {
      identity: "ip",
      policyKey: "verification.submit.ip.v1",
      limit: 10,
      windowMs: HOUR_MS,
    },
    {
      identity: "subject",
      policyKey: "verification.submit.subject.v1",
      limit: 3,
      windowMs: HOUR_MS,
    },
    {
      identity: "wallet",
      policyKey: "verification.submit.wallet.v1",
      limit: 3,
      windowMs: HOUR_MS,
    },
    {
      identity: "request",
      policyKey: "verification.submit.request.v1",
      limit: 3,
      windowMs: HOUR_MS,
    },
  ],
  "marketplace-campaign-create": [
    {
      identity: "ip",
      policyKey: "marketplace.campaign-create.ip.v1",
      limit: 30,
      windowMs: HOUR_MS,
    },
    {
      identity: "subject",
      policyKey: "marketplace.campaign-create.subject.v1",
      limit: 10,
      windowMs: HOUR_MS,
    },
    {
      identity: "wallet",
      policyKey: "marketplace.campaign-create.wallet.v1",
      limit: 10,
      windowMs: HOUR_MS,
    },
  ],
  "marketplace-apply": [
    {
      identity: "ip",
      policyKey: "marketplace.apply.ip.v1",
      limit: 60,
      windowMs: HOUR_MS,
    },
    {
      identity: "subject",
      policyKey: "marketplace.apply.subject.v1",
      limit: 20,
      windowMs: HOUR_MS,
    },
    {
      identity: "wallet",
      policyKey: "marketplace.apply.wallet.v1",
      limit: 20,
      windowMs: HOUR_MS,
    },
  ],
  "marketplace-select": [
    {
      identity: "ip",
      policyKey: "marketplace.select.ip.v1",
      limit: 60,
      windowMs: HOUR_MS,
    },
    {
      identity: "subject",
      policyKey: "marketplace.select.subject.v1",
      limit: 30,
      windowMs: HOUR_MS,
    },
    {
      identity: "wallet",
      policyKey: "marketplace.select.wallet.v1",
      limit: 30,
      windowMs: HOUR_MS,
    },
  ],
  "marketplace-accept": [
    {
      identity: "ip",
      policyKey: "marketplace.accept.ip.v1",
      limit: 60,
      windowMs: HOUR_MS,
    },
    {
      identity: "subject",
      policyKey: "marketplace.accept.subject.v1",
      limit: 30,
      windowMs: HOUR_MS,
    },
    {
      identity: "wallet",
      policyKey: "marketplace.accept.wallet.v1",
      limit: 30,
      windowMs: HOUR_MS,
    },
  ],
  "marketplace-metrics-refresh": [
    {
      identity: "ip",
      policyKey: "marketplace.metrics-refresh.ip.v1",
      limit: 20,
      windowMs: HOUR_MS,
    },
    {
      identity: "subject",
      policyKey: "marketplace.metrics-refresh.subject.v1",
      limit: 6,
      windowMs: HOUR_MS,
    },
    {
      identity: "wallet",
      policyKey: "marketplace.metrics-refresh.wallet.v1",
      limit: 6,
      windowMs: HOUR_MS,
    },
  ],
  "marketplace-metrics-status": [
    {
      identity: "ip",
      policyKey: "marketplace.metrics-status.ip.v1",
      limit: 600,
      windowMs: HOUR_MS,
    },
    {
      identity: "subject",
      policyKey: "marketplace.metrics-status.subject.v1",
      limit: 600,
      windowMs: HOUR_MS,
    },
    {
      identity: "wallet",
      policyKey: "marketplace.metrics-status.wallet.v1",
      limit: 600,
      windowMs: HOUR_MS,
    },
  ],
};

const postgresRateLimitStore: AtomicRateLimitStore = {
  consume: consumePostgresRateLimit,
};

/**
 * Applies IP and authenticated-identity quotas before a verification mutation.
 * Each counter is an atomic Postgres upsert. A later, more-specific denial can
 * still consume an earlier IP counter; this conservative behavior avoids
 * bypasses and does not grant more requests than any configured quota.
 */
export async function enforceVerificationRateLimit(
  request: Request,
  policy: VerificationRateLimitPolicy,
  context: VerificationRateLimitContext = {},
  options: VerificationRateLimitOptions = {},
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("The rate-limit clock is invalid.");
  }

  let secret: string;
  let ip: string;
  try {
    secret = rateLimitSecret(options.secret);
    ip = trustedClientIpIdentity(request, options.runtime);
  } catch (error) {
    if (error instanceof RateLimitConfigurationError) {
      throw new ApiProblem(
        503,
        "RATE_LIMIT_CONFIGURATION_REQUIRED",
        "Verification safeguards are not configured in this deployment.",
      );
    }
    throw error;
  }
  const identities: Record<RateLimitIdentity, string | null> = {
    ip,
    subject: normalizedOpaqueIdentity(context.subject),
    wallet: normalizedWalletIdentity(context.wallet),
    request: normalizedOpaqueIdentity(context.requestId),
  };
  const store = options.store ?? postgresRateLimitStore;

  for (const rule of VERIFICATION_RATE_LIMIT_RULES[policy]) {
    const identity = identities[rule.identity];
    if (!identity) continue;

    const windowStartedAt = Math.floor(nowMs / rule.windowMs) * rule.windowMs;
    const windowExpiresAt = windowStartedAt + rule.windowMs;
    const decision = await store.consume({
      policyKey: rule.policyKey,
      bucketHash: rateLimitBucketHash(
        rule.policyKey,
        rule.identity,
        identity,
        secret,
      ),
      limit: rule.limit,
      windowStartedAt,
      windowExpiresAt,
      nowMs,
    });

    if (!decision.allowed) {
      const resetSeconds = Math.max(
        1,
        Math.ceil((decision.resetAtMs - nowMs) / SECOND_MS),
      );
      const windowSeconds = Math.ceil(rule.windowMs / SECOND_MS);
      const label = POLICY_LABELS[policy];
      throw new ApiProblem(
        429,
        "RATE_LIMITED",
        policy.startsWith("marketplace-")
          ? "Too many marketplace actions. Wait before trying again."
          : "Too many verification attempts. Wait before trying again.",
        {
          "RateLimit": `"${label}";r=0;t=${resetSeconds}`,
          "RateLimit-Policy": `"${label}";q=${decision.limit};w=${windowSeconds}`,
          "Retry-After": String(resetSeconds),
        },
      );
    }
  }
}

/**
 * Vercel overwrites spoofable client X-Forwarded-For values and exposes its
 * trusted copy as x-vercel-forwarded-for. Outside Vercel, production traffic
 * has no trusted proxy boundary and therefore fails closed. Development uses
 * one non-identifying local bucket instead of trusting user-supplied headers.
 */
export function trustedClientIpIdentity(
  request: Request,
  runtime: RateLimitRuntime = {},
): string {
  const onVercel = runtime.vercel ?? process.env.VERCEL === "1";
  const nodeEnv = runtime.nodeEnv ?? process.env.NODE_ENV;
  if (!onVercel) {
    if (nodeEnv !== "production") return "local-development";
    throw new RateLimitConfigurationError(
      "A trusted Vercel client IP header is unavailable.",
    );
  }

  const value = request.headers.get("x-vercel-forwarded-for")?.trim();
  if (value && value.length > 64) {
    throw new RateLimitConfigurationError(
      "The trusted Vercel client IP header is invalid.",
    );
  }
  const canonical = value ? canonicalIp(value) : null;
  if (!canonical) {
    throw new RateLimitConfigurationError(
      "The trusted Vercel client IP header is unavailable.",
    );
  }
  return canonical;
}

export function rateLimitBucketHash(
  policyKey: string,
  identityType: RateLimitIdentity,
  identity: string,
  secret: string,
): string {
  const key = validatedSecret(secret);
  return createHmac("sha256", key)
    .update("xproof-rate-limit-v1\0", "utf8")
    .update(policyKey, "utf8")
    .update("\0", "utf8")
    .update(identityType, "utf8")
    .update("\0", "utf8")
    .update(identity, "utf8")
    .digest("hex");
}

async function consumePostgresRateLimit(
  input: AtomicRateLimitInput,
): Promise<AtomicRateLimitDecision> {
  validateAtomicInput(input);
  const [row] = await getDb()
    .insert(verificationRateLimits)
    .values({
      policyKey: input.policyKey,
      bucketHash: input.bucketHash,
      windowStartedAt: input.windowStartedAt,
      windowExpiresAt: input.windowExpiresAt,
      requestCount: 1,
      requestLimit: input.limit,
      createdAt: input.nowMs,
      updatedAt: input.nowMs,
    })
    .onConflictDoUpdate({
      target: [
        verificationRateLimits.policyKey,
        verificationRateLimits.bucketHash,
      ],
      set: {
        windowStartedAt: sql<number>`case when ${verificationRateLimits.windowExpiresAt} <= ${input.nowMs} then ${input.windowStartedAt} else ${verificationRateLimits.windowStartedAt} end`,
        windowExpiresAt: sql<number>`case when ${verificationRateLimits.windowExpiresAt} <= ${input.nowMs} then ${input.windowExpiresAt} else ${verificationRateLimits.windowExpiresAt} end`,
        requestCount: sql<number>`case when ${verificationRateLimits.windowExpiresAt} <= ${input.nowMs} then 1 else ${verificationRateLimits.requestCount} + 1 end`,
        requestLimit: sql<number>`case when ${verificationRateLimits.windowExpiresAt} <= ${input.nowMs} then ${input.limit} else ${verificationRateLimits.requestLimit} end`,
        updatedAt: input.nowMs,
      },
      setWhere: sql`${verificationRateLimits.windowExpiresAt} <= ${input.nowMs} or ${verificationRateLimits.requestCount} < ${verificationRateLimits.requestLimit}`,
    })
    .returning({
      requestCount: verificationRateLimits.requestCount,
      requestLimit: verificationRateLimits.requestLimit,
      windowExpiresAt: verificationRateLimits.windowExpiresAt,
    });

  if (!row) {
    return {
      allowed: false,
      limit: input.limit,
      remaining: 0,
      resetAtMs: input.windowExpiresAt,
    };
  }
  return {
    allowed: true,
    limit: row.requestLimit,
    remaining: Math.max(0, row.requestLimit - row.requestCount),
    resetAtMs: row.windowExpiresAt,
  };
}

function rateLimitSecret(override?: string): string {
  const secret = override ?? process.env.XPROOF_RATE_LIMIT_SECRET;
  if (!secret) {
    throw new RateLimitConfigurationError(
      "XPROOF_RATE_LIMIT_SECRET is unavailable.",
    );
  }
  return validatedSecret(secret);
}

function validatedSecret(secret: string): string {
  if (Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    throw new RateLimitConfigurationError(
      "XPROOF_RATE_LIMIT_SECRET must contain at least 32 bytes.",
    );
  }
  return secret;
}

function normalizedOpaqueIdentity(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) return null;
  return normalized;
}

function normalizedWalletIdentity(value: string | null | undefined): string | null {
  const normalized = normalizedOpaqueIdentity(value);
  return normalized?.toLowerCase() ?? null;
}

function canonicalIp(value: string): string | null {
  if (value.includes(",") || /\s/.test(value)) return null;
  const version = isIP(value);
  if (version === 4) {
    return value
      .split(".")
      .map((part) => String(Number(part)))
      .join(".");
  }
  if (version === 6) {
    try {
      return new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase();
    } catch {
      return null;
    }
  }
  return null;
}

function validateAtomicInput(input: AtomicRateLimitInput): void {
  if (
    !input.policyKey ||
    input.policyKey.length > 128 ||
    !/^[0-9a-f]{64}$/.test(input.bucketHash) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0 ||
    !Number.isSafeInteger(input.windowStartedAt) ||
    !Number.isSafeInteger(input.windowExpiresAt) ||
    !Number.isSafeInteger(input.nowMs) ||
    input.windowStartedAt < 0 ||
    input.windowExpiresAt <= input.windowStartedAt
  ) {
    throw new Error("The atomic rate-limit input is invalid.");
  }
}

export class RateLimitConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitConfigurationError";
  }
}
