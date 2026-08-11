import assert from "node:assert/strict";
import test from "node:test";
import { ApiProblem, apiError } from "../lib/verification-api.ts";
import {
  RateLimitConfigurationError,
  VERIFICATION_RATE_LIMIT_RULES,
  enforceVerificationRateLimit,
  rateLimitBucketHash,
  trustedClientIpIdentity,
  type AtomicRateLimitDecision,
  type AtomicRateLimitInput,
  type AtomicRateLimitStore,
} from "../lib/verification-rate-limit.ts";

const SECRET = "rate-limit-test-secret-with-at-least-32-bytes";
const NOW = Date.UTC(2026, 7, 9, 12, 5, 0);
const SUBJECT = "A".repeat(43);
const WALLET = "0x1111111111111111111111111111111111111111";

test("Vercel rate-limit identity trusts only its non-chain forwarded header", () => {
  const request = new Request("https://xproof.example/api/verification/challenge", {
    headers: {
      "x-forwarded-for": "203.0.113.250",
      "x-vercel-forwarded-for": "2001:0db8:0:0:0:0:0:1",
    },
  });
  assert.equal(
    trustedClientIpIdentity(request, { vercel: true, nodeEnv: "production" }),
    "2001:db8::1",
  );

  assert.throws(
    () =>
      trustedClientIpIdentity(
        new Request(request.url, {
          headers: {
            "x-vercel-forwarded-for": "198.51.100.1, 198.51.100.2",
          },
        }),
        { vercel: true, nodeEnv: "production" },
      ),
    RateLimitConfigurationError,
  );
  assert.throws(
    () =>
      trustedClientIpIdentity(new Request(request.url), {
        vercel: false,
        nodeEnv: "production",
      }),
    RateLimitConfigurationError,
  );
  assert.equal(
    trustedClientIpIdentity(
      new Request("http://localhost:3000/api/verification/challenge", {
        headers: { "x-forwarded-for": "203.0.113.99" },
      }),
      { vercel: false, nodeEnv: "development" },
    ),
    "local-development",
  );
});

test("stored bucket values are scoped HMAC digests, never raw identities", async () => {
  const consumed: AtomicRateLimitInput[] = [];
  const store: AtomicRateLimitStore = {
    async consume(input) {
      consumed.push(input);
      return allowedDecision(input, 1);
    },
  };
  await enforceVerificationRateLimit(
    vercelRequest("203.0.113.4"),
    "x-challenge",
    { subject: SUBJECT, wallet: WALLET, requestId: "request-secret" },
    {
      nowMs: NOW,
      runtime: { vercel: true, nodeEnv: "production" },
      secret: SECRET,
      store,
    },
  );

  assert.equal(consumed.length, 3);
  for (const input of consumed) {
    assert.match(input.bucketHash, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(input.bucketHash, /203\.0\.113\.4/i);
    assert.doesNotMatch(input.bucketHash, /1111111111/i);
    assert.notEqual(input.bucketHash, SUBJECT);
  }
  assert.equal(new Set(consumed.map((input) => input.bucketHash)).size, 3);
  assert.notEqual(
    rateLimitBucketHash("policy.a.v1", "subject", SUBJECT, SECRET),
    rateLimitBucketHash("policy.b.v1", "subject", SUBJECT, SECRET),
  );
});

test("concurrent attempts cannot exceed the most specific policy quota", async () => {
  const store = new SerializedMemoryStore();
  const attempts = await Promise.allSettled(
    Array.from({ length: 100 }, () =>
      enforceVerificationRateLimit(
        vercelRequest("198.51.100.9"),
        "x-challenge",
        { subject: SUBJECT, wallet: WALLET },
        {
          nowMs: NOW,
          runtime: { vercel: true, nodeEnv: "production" },
          secret: SECRET,
          store,
        },
      ),
    ),
  );
  const allowed = attempts.filter((result) => result.status === "fulfilled");
  const denied = attempts.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );

  assert.equal(allowed.length, 5);
  assert.equal(denied.length, 95);
  for (const result of denied) {
    assert.ok(result.reason instanceof ApiProblem);
    assert.equal(result.reason.status, 429);
    assert.equal(result.reason.code, "RATE_LIMITED");
  }

  const nextWindow = NOW + 60 * 60 * 1_000;
  await assert.doesNotReject(() =>
    enforceVerificationRateLimit(
      vercelRequest("198.51.100.9"),
      "x-challenge",
      { subject: SUBJECT, wallet: WALLET },
      {
        nowMs: nextWindow,
        runtime: { vercel: true, nodeEnv: "production" },
        secret: SECRET,
        store,
      },
    ),
  );
});

test("denials are sanitized and return Retry-After plus modern RateLimit fields", async () => {
  const deniedStore: AtomicRateLimitStore = {
    async consume(input) {
      return {
        allowed: false,
        limit: input.limit,
        remaining: 0,
        resetAtMs: NOW + 42_000,
      };
    },
  };
  let error: unknown;
  try {
    await enforceVerificationRateLimit(
      vercelRequest("192.0.2.5"),
      "submit",
      { subject: SUBJECT, wallet: WALLET, requestId: "request-1" },
      {
        nowMs: NOW,
        runtime: { vercel: true, nodeEnv: "production" },
        secret: SECRET,
        store: deniedStore,
      },
    );
  } catch (caught) {
    error = caught;
  }
  const response = apiError(error);
  const payload = (await response.json()) as {
    error: { code: string; message: string };
  };

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "42");
  assert.equal(
    response.headers.get("ratelimit"),
    '"verification-submit-v1";r=0;t=42',
  );
  assert.equal(
    response.headers.get("ratelimit-policy"),
    '"verification-submit-v1";q=10;w=3600',
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(payload, {
    error: {
      code: "RATE_LIMITED",
      message: "Too many verification attempts. Wait before trying again.",
    },
  });
  assert.doesNotMatch(JSON.stringify(payload), /192\.0\.2\.5|subject|wallet/i);
});

test("missing secrets and untrusted production proxies fail closed", async () => {
  const store = new SerializedMemoryStore();
  for (const options of [
    {
      runtime: { vercel: true, nodeEnv: "production" },
      secret: "short",
      request: vercelRequest("192.0.2.1"),
    },
    {
      runtime: { vercel: false, nodeEnv: "production" },
      secret: SECRET,
      request: vercelRequest("192.0.2.1"),
    },
  ] as const) {
    await assert.rejects(
      enforceVerificationRateLimit(
        options.request,
        "challenge",
        { subject: SUBJECT },
        {
          nowMs: NOW,
          runtime: options.runtime,
          secret: options.secret,
          store,
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ApiProblem);
        assert.equal(error.status, 503);
        assert.equal(error.code, "RATE_LIMIT_CONFIGURATION_REQUIRED");
        assert.doesNotMatch(error.message, /secret|header|vercel/i);
        return true;
      },
    );
  }
});

test("production policies keep submission stricter than recovery operations", () => {
  const submitSubject = VERIFICATION_RATE_LIMIT_RULES.submit.find(
    (rule) => rule.identity === "subject",
  );
  const intentSubject = VERIFICATION_RATE_LIMIT_RULES.intent.find(
    (rule) => rule.identity === "subject",
  );
  assert.ok(submitSubject && intentSubject);
  assert.equal(submitSubject.limit, 3);
  assert.ok(intentSubject.limit > submitSubject.limit);
  const metricsRefresh = VERIFICATION_RATE_LIMIT_RULES[
    "marketplace-metrics-refresh"
  ].find((rule) => rule.identity === "wallet");
  const metricsStatus = VERIFICATION_RATE_LIMIT_RULES[
    "marketplace-metrics-status"
  ].find((rule) => rule.identity === "wallet");
  assert.equal(metricsRefresh?.limit, 6);
  assert.equal(metricsStatus?.limit, 600);
  assert.ok((metricsStatus?.limit ?? 0) > (metricsRefresh?.limit ?? 0));
  for (const rules of Object.values(VERIFICATION_RATE_LIMIT_RULES)) {
    for (const rule of rules) {
      assert.match(rule.policyKey, /\.v\d+$/);
      assert.ok(rule.limit > 0);
      assert.ok(rule.windowMs >= 10 * 60 * 1_000);
    }
  }
});

function vercelRequest(ip: string): Request {
  return new Request("https://xproof.example/api/verification/challenge", {
    method: "POST",
    headers: { "x-vercel-forwarded-for": ip },
  });
}

function allowedDecision(
  input: AtomicRateLimitInput,
  count: number,
): AtomicRateLimitDecision {
  return {
    allowed: true,
    limit: input.limit,
    remaining: Math.max(0, input.limit - count),
    resetAtMs: input.windowExpiresAt,
  };
}

class SerializedMemoryStore implements AtomicRateLimitStore {
  readonly #rows = new Map<
    string,
    { count: number; limit: number; resetAtMs: number }
  >();
  #tail: Promise<void> = Promise.resolve();

  async consume(input: AtomicRateLimitInput): Promise<AtomicRateLimitDecision> {
    let unlock!: () => void;
    const current = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await current;
    try {
      const key = `${input.policyKey}:${input.bucketHash}`;
      let row = this.#rows.get(key);
      if (!row || row.resetAtMs <= input.nowMs) {
        row = { count: 0, limit: input.limit, resetAtMs: input.windowExpiresAt };
      }
      if (row.count >= row.limit) {
        return {
          allowed: false,
          limit: row.limit,
          remaining: 0,
          resetAtMs: row.resetAtMs,
        };
      }
      row.count += 1;
      this.#rows.set(key, row);
      return {
        allowed: true,
        limit: row.limit,
        remaining: row.limit - row.count,
        resetAtMs: row.resetAtMs,
      };
    } finally {
      unlock();
    }
  }
}
