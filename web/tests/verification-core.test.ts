import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getAddress } from "viem";
import {
  BASE_SEPOLIA_CHAIN_ID,
  buildOwnershipTweet,
  buildWalletAuthorizationMessage,
  createOwnershipIntent,
  makeRandomBase64Url,
  normalizeXHandle,
  parseVerificationPostUrl,
  shouldExpireVerificationRequest,
  validateVerificationPostTiming,
  xSnowflakeTimestampMs,
} from "../lib/verification-core.ts";
import {
  applicationOriginForMetadata,
  applicationOriginForRequest,
  verificationMutationsEnabled,
} from "../lib/verification-config.ts";
import { ApiProblem, apiError, requireString } from "../lib/verification-api.ts";

const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const RECEIVER = getAddress("0x2222222222222222222222222222222222222222");
const RESOLVER = getAddress("0x3333333333333333333333333333333333333333");
const ISSUED_AT = Date.UTC(2026, 7, 8, 20, 0, 0);

test("wallet challenge rejects a missing wallet as a bounded client error", async () => {
  let problem: unknown;
  try {
    requireString({}, "wallet", 64);
  } catch (error) {
    problem = error;
  }
  assert.ok(problem instanceof ApiProblem);
  const response = apiError(problem);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: { code: "INVALID_REQUEST", message: "wallet is required." },
  });

  const route = await readFile(
    new URL("../app/api/verification/challenge/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /const wallet = requireString\(body, "wallet", 64\)/);
  assert.match(route, /walletSessionMatches\(session, wallet\)/);
  assert.match(route, /wallet,\s*origin: applicationOriginForRequest/);
});

test("normalizes public X handles and rejects profile URLs", () => {
  assert.equal(normalizeXHandle(" @Creator_7 "), "creator_7");
  assert.throws(() => normalizeXHandle("https://x.com/creator"));
  assert.throws(() => normalizeXHandle("sixteen_chars____"));
});

test("strictly parses canonical X and legacy Twitter post URLs", () => {
  const postId = snowflakeFor(ISSUED_AT + 10_000);
  assert.deepEqual(
    parseVerificationPostUrl(`https://twitter.com/Creator_7/status/${postId}`),
    {
      handle: "creator_7",
      postId,
      normalizedUrl: `https://x.com/creator_7/status/${postId}`,
      createdAtMs: ISSUED_AT + 10_000,
    },
  );
  assert.throws(() =>
    parseVerificationPostUrl(`https://x.com/creator_7/status/${postId}?s=20`),
  );
  assert.throws(() =>
    parseVerificationPostUrl(`https://x.com.evil.test/creator_7/status/${postId}`),
  );
  assert.throws(() =>
    parseVerificationPostUrl(`https://x.com/i/web/status/${postId}`),
  );
});

test("derives and validates the timestamp embedded in an X snowflake", () => {
  const postId = snowflakeFor(ISSUED_AT);
  assert.equal(xSnowflakeTimestampMs(postId), ISSUED_AT);
  assert.doesNotThrow(() =>
    validateVerificationPostTiming({
      postCreatedAtMs: ISSUED_AT + 1_000,
      challengeIssuedAtMs: ISSUED_AT,
      challengeExpiresAtMs: ISSUED_AT + 30 * 60_000,
      credentialExpiresAtMs: ISSUED_AT + 30 * 24 * 60 * 60_000,
      nowMs: ISSUED_AT + 2_000,
    }),
  );
  assert.throws(() =>
    validateVerificationPostTiming({
      postCreatedAtMs: ISSUED_AT - 61_000,
      challengeIssuedAtMs: ISSUED_AT,
      challengeExpiresAtMs: ISSUED_AT + 30 * 60_000,
      credentialExpiresAtMs: ISSUED_AT + 30 * 24 * 60 * 60_000,
      nowMs: ISSUED_AT + 2_000,
    }),
  );
});

test("stale active requests expire while terminal rows remain terminal", () => {
  assert.equal(
    shouldExpireVerificationRequest("X_CHALLENGE_ISSUED", 999, 1_000),
    true,
  );
  assert.equal(
    shouldExpireVerificationRequest("READY_FOR_GENLAYER", 1_001, 1_000),
    false,
  );
  assert.equal(shouldExpireVerificationRequest("EXPIRED", 999, 1_000), false);
});

test("wallet authorization message binds origin, request, wallet, chain and expiry", () => {
  const message = buildWalletAuthorizationMessage({
    origin: "https://xproof.example/path-that-is-not-trusted",
    requestId: "request-123",
    wallet: WALLET,
    nonce: "0123456789abcdef0123456789abcdef",
    issuedAtMs: ISSUED_AT,
    expiresAtMs: ISSUED_AT + 5 * 60_000,
  });
  assert.match(message, /Domain: xproof\.example/);
  assert.match(message, /URI: https:\/\/xproof\.example\/verify/);
  assert.match(message, new RegExp(`Chain ID: ${BASE_SEPOLIA_CHAIN_ID}`));
  assert.match(message, /Request ID: request-123/);
  assert.match(message, new RegExp(`Wallet: ${WALLET}`));
  assert.match(message, /Expiration Time: 2026-08-08T20:05:00\.000Z/);
  assert.match(message, /does not approve a payment/);
});

test("application origin comes only from trusted deployment configuration", () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_URL: process.env.VERCEL_URL,
    VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
    VERCEL_PROJECT_PRODUCTION_URL:
      process.env.VERCEL_PROJECT_PRODUCTION_URL,
    XPROOF_APP_ORIGIN: process.env.XPROOF_APP_ORIGIN,
  };
  try {
    Object.assign(process.env, { NODE_ENV: "production" });
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "xproof-preview-123.vercel.app";
    process.env.VERCEL_BRANCH_URL = "xproof-git-feature.vercel.app";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "xproof.vercel.app";
    process.env.XPROOF_APP_ORIGIN = "https://proof.example";

    for (const origin of [
      "https://xproof-preview-123.vercel.app",
      "https://xproof-git-feature.vercel.app",
      "https://proof.example",
    ]) {
      assert.equal(
        applicationOriginForRequest(
          new Request(`${origin}/api/verification/challenge`),
        ),
        origin,
      );
    }
    assert.equal(applicationOriginForMetadata(), "https://proof.example");
    assert.throws(() =>
      applicationOriginForRequest(
        new Request("https://xproof.vercel.app/api/verification/challenge"),
      ),
    );
    assert.throws(() =>
      applicationOriginForRequest(
        new Request("https://attacker.example/api/verification/challenge"),
      ),
    );
    assert.throws(() =>
      applicationOriginForRequest(
        new Request("http://127.0.0.1:3000/api/verification/challenge"),
      ),
    );
    process.env.VERCEL_ENV = "production";
    assert.throws(() =>
      applicationOriginForRequest(
        new Request(
          "https://xproof-preview-123.vercel.app/api/verification/challenge",
        ),
      ),
    );
    assert.equal(
      applicationOriginForRequest(
        new Request("https://proof.example/api/verification/challenge"),
      ),
      "https://proof.example",
    );
    process.env.XPROOF_APP_ORIGIN = "https://proof.example/path";
    assert.throws(() => applicationOriginForMetadata());
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("deployed verification mutations require an explicit kill-switch opt in", () => {
  const previous = {
    VERCEL: process.env.VERCEL,
    XPROOF_VERIFICATION_MUTATIONS_ENABLED:
      process.env.XPROOF_VERIFICATION_MUTATIONS_ENABLED,
  };
  try {
    delete process.env.VERCEL;
    delete process.env.XPROOF_VERIFICATION_MUTATIONS_ENABLED;
    assert.equal(verificationMutationsEnabled(), true);

    process.env.VERCEL = "1";
    assert.equal(verificationMutationsEnabled(), false);
    process.env.XPROOF_VERIFICATION_MUTATIONS_ENABLED = "false";
    assert.equal(verificationMutationsEnabled(), false);
    process.env.XPROOF_VERIFICATION_MUTATIONS_ENABLED = "true";
    assert.equal(verificationMutationsEnabled(), true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("V2 tweet text includes every signed ownership field and fits X", () => {
  const text = buildOwnershipTweet({
    wallet: WALLET,
    challenge: "APV2-abcdefghijklmnopqrstuvwx",
    issuedAtMs: ISSUED_AT,
    challengeExpiresAtMs: ISSUED_AT + 15 * 60_000,
    credentialExpiresAtMs: ISSUED_AT + 30 * 24 * 60 * 60_000,
  });
  assert.ok(text.length <= 280);
  assert.equal(
    text,
    `XProof v2 w=${WALLET} n=APV2-abcdefghijklmnopqrstuvwx i=1786219200 e=1786220100 c=1788811200`,
  );
  const generated = makeRandomBase64Url(18);
  assert.match(generated, /^[A-Za-z0-9_-]{24}$/);
});

test("post-bound V2 request and EIP-712 payload are deterministic", () => {
  const input = {
    wallet: WALLET,
    handle: "XDevelopers",
    postId: "1900000000000000000",
    challenge: "APV2-abcdefghijklmnopqrstuvwx",
    challengeIssuedAtMs: 1_800_000_000_000,
    challengeExpiresAtMs: 1_800_000_900_000,
    credentialExpiresAtMs: 1_802_592_000_000,
    receiverContract: RECEIVER,
    genlayerContract: RESOLVER,
  };
  const first = createOwnershipIntent(input);
  const second = createOwnershipIntent(input);
  assert.deepEqual(first, second);
  assert.equal(
    first.finalizedRequestId,
    "0x1398bdfc25c11bd297ce1f457a0f9df5d9fd07b385a89209e5fc91ca980c0ce6",
  );
  assert.equal(first.typedData.domain.name, "XProofAttestationReceiver");
  assert.equal(first.typedData.domain.version, "2");
  assert.equal(first.typedData.domain.chainId, BASE_SEPOLIA_CHAIN_ID);
  assert.equal(first.typedData.domain.verifyingContract, RECEIVER);
  assert.equal(first.typedData.message.attestationId, first.finalizedRequestId);
  assert.equal(
    first.typedData.message.genlayerContract,
    "0x0000000000000000000000003333333333333333333333333333333333333333",
  );
});

function snowflakeFor(timestampMs: number): string {
  return ((BigInt(timestampMs) - 1_288_834_974_657n) << 22n).toString();
}
