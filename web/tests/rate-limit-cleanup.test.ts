import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupExpiredRateLimitBuckets,
  cleanupRequestIsAuthorized,
} from "../lib/rate-limit-cleanup.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);
const SECRET = "cleanup-test-secret-with-at-least-32-bytes";

test("cleanup deletes expired rows in bounded batches", async () => {
  const sizes = [1_000, 1_000, 7];
  const seen: Array<{ cutoffMs: number; batchSize: number }> = [];
  const result = await cleanupExpiredRateLimitBuckets({
    nowMs: NOW,
    deleteBatch: async (input) => {
      seen.push(input);
      return sizes.shift() ?? 0;
    },
  });

  assert.deepEqual(result, {
    cutoffMs: NOW - DAY_MS,
    deleted: 2_007,
    batches: 3,
    capped: false,
  });
  assert.equal(seen.length, 3);
  assert.ok(seen.every((input) => input.batchSize === 1_000));
  assert.ok(seen.every((input) => input.cutoffMs === NOW - DAY_MS));
});

test("cleanup reports backlog without exceeding its hard cap", async () => {
  let calls = 0;
  const result = await cleanupExpiredRateLimitBuckets({
    nowMs: NOW,
    batchSize: 100,
    maxBatches: 3,
    deleteBatch: async () => {
      calls += 1;
      return 100;
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.deleted, 300);
  assert.equal(result.capped, true);
});

test("cleanup never accepts retention shorter than active policy windows", async () => {
  await assert.rejects(
    cleanupExpiredRateLimitBuckets({
      nowMs: NOW,
      retentionMs: DAY_MS - 1,
      deleteBatch: async () => 0,
    }),
    /configuration is invalid/,
  );
});

test("cron authorization is exact and fails closed for weak configuration", () => {
  const authorized = new Request("https://xproof.example/api/internal/rate-limits/cleanup", {
    headers: { authorization: `Bearer ${SECRET}` },
  });
  assert.equal(cleanupRequestIsAuthorized(authorized, SECRET), true);
  assert.equal(
    cleanupRequestIsAuthorized(
      new Request(authorized.url, {
        headers: { authorization: `Bearer ${SECRET}suffix` },
      }),
      SECRET,
    ),
    false,
  );
  assert.equal(cleanupRequestIsAuthorized(authorized, "short"), false);
});
