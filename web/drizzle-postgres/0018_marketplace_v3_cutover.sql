-- Retire only unfinished web work bound to V2. Completed V2 projections remain
-- available for audit, while all new reads and writes are scoped to V3.

WITH cutover AS (
  SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
)
UPDATE "verification_requests" AS request
SET
  "status" = 'EXPIRED',
  "status_updated_at" = cutover.now_ms,
  "request_expires_at" = LEAST(request."request_expires_at", cutover.now_ms - 1),
  "active_owner_user_id" = NULL,
  "active_wallet" = NULL,
  "wallet_nonce" = NULL,
  "wallet_message" = NULL,
  "x_challenge" = NULL,
  "tweet_text" = NULL,
  "farcaster_challenge" = NULL,
  "farcaster_cast_text" = NULL,
  "purged_at" = COALESCE(request."purged_at", cutover.now_ms),
  "revision" = request."revision" + 1,
  "updated_at" = cutover.now_ms
FROM cutover
WHERE request."status" <> 'EXPIRED'
  AND request."active_owner_user_id" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "marketplace_genlayer_transactions" AS journal
    WHERE journal."prepared_id" = request."activation_prepared_id"
      AND journal."network" = 'studionet'
      AND journal."chain_id" = 61999
      AND journal."contract_address" = '0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb'
  );--> statement-breakpoint

WITH cutover AS (
  SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
)
UPDATE "marketplace_genlayer_transactions" AS journal
SET
  "status" = 'NETWORK_TERMINATED',
  "error_code" = COALESCE(journal."error_code", 'MARKETPLACE_V3_CUTOVER'),
  "last_checked_at" = cutover.now_ms,
  "next_reconcile_at" = 0,
  "fence_token" = NULL,
  "fence_expires_at" = NULL,
  "updated_at" = cutover.now_ms
FROM cutover
WHERE journal."network" = 'studionet'
  AND journal."chain_id" = 61999
  AND journal."contract_address" = '0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb'
  AND journal."status" IN (
    'PREPARED', 'SUBMITTED', 'ACCEPTED', 'RECONCILIATION_REQUIRED'
  );--> statement-breakpoint

-- A maintenance generation is contract-address scoped. V3 must receive a new
-- monotonic generation after the reviewer-facing deployment is verified.
DELETE FROM "marketplace_genlayer_maintenance_generations"
WHERE "network" = 'studionet'
  AND "chain_id" = 61999
  AND "contract_address" = '0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb';
