import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "../db/index.ts";
import { verificationRateLimits } from "../db/schema.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_MAX_BATCHES = 10;

type DeleteExpiredBatch = (input: {
  cutoffMs: number;
  batchSize: number;
}) => Promise<number>;

export type RateLimitCleanupOptions = {
  nowMs?: number;
  retentionMs?: number;
  batchSize?: number;
  maxBatches?: number;
  deleteBatch?: DeleteExpiredBatch;
};

export type RateLimitCleanupResult = {
  cutoffMs: number;
  deleted: number;
  batches: number;
  capped: boolean;
};

/**
 * Deletes old pseudonymous buckets in bounded batches. The one-day retention
 * is longer than every current fixed window, so no active quota can be reset
 * by cleanup. If the cap is reached, the next daily cron continues the work.
 */
export async function cleanupExpiredRateLimitBuckets(
  options: RateLimitCleanupOptions = {},
): Promise<RateLimitCleanupResult> {
  const nowMs = options.nowMs ?? Date.now();
  const retentionMs = options.retentionMs ?? DAY_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(retentionMs) ||
    retentionMs < DAY_MS ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > DEFAULT_BATCH_SIZE ||
    !Number.isSafeInteger(maxBatches) ||
    maxBatches < 1 ||
    maxBatches > DEFAULT_MAX_BATCHES
  ) {
    throw new Error("The rate-limit cleanup configuration is invalid.");
  }

  const cutoffMs = nowMs - retentionMs;
  const deleteBatch = options.deleteBatch ?? deleteExpiredPostgresBatch;
  let deleted = 0;
  let batches = 0;
  let lastBatchWasFull = false;
  while (batches < maxBatches) {
    const count = await deleteBatch({ cutoffMs, batchSize });
    if (!Number.isSafeInteger(count) || count < 0 || count > batchSize) {
      throw new Error("The rate-limit cleanup result is invalid.");
    }
    deleted += count;
    batches += 1;
    lastBatchWasFull = count === batchSize;
    if (!lastBatchWasFull) break;
  }

  return {
    cutoffMs,
    deleted,
    batches,
    capped: batches === maxBatches && lastBatchWasFull,
  };
}

export function cleanupRequestIsAuthorized(
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

async function deleteExpiredPostgresBatch(input: {
  cutoffMs: number;
  batchSize: number;
}): Promise<number> {
  const result = await getDb().execute(sql`
    with stale_buckets as (
      select
        ${verificationRateLimits.policyKey},
        ${verificationRateLimits.bucketHash}
      from ${verificationRateLimits}
      where ${verificationRateLimits.windowExpiresAt} < ${input.cutoffMs}
      order by ${verificationRateLimits.windowExpiresAt} asc
      limit ${input.batchSize}
    ), deleted_buckets as (
      delete from ${verificationRateLimits} as target
      using stale_buckets
      where target.policy_key = stale_buckets.policy_key
        and target.bucket_hash = stale_buckets.bucket_hash
      returning 1
    )
    select count(*)::integer as deleted_count from deleted_buckets
  `);
  const row = (result as unknown as {
    rows?: Array<{ deleted_count?: unknown }>;
  }).rows?.[0];
  const count = Number(row?.deleted_count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("The rate-limit cleanup query returned an invalid count.");
  }
  return count;
}
