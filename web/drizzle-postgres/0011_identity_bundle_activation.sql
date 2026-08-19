-- Bind one verification row and one transaction journal entry to the two
-- child ownership requests committed by activate_identity_bundle.

ALTER TABLE "verification_requests"
  ADD COLUMN IF NOT EXISTS "x_ownership_request_id" text;--> statement-breakpoint
ALTER TABLE "verification_requests"
  ADD COLUMN IF NOT EXISTS "farcaster_ownership_request_id" text;--> statement-breakpoint

-- The replacement bundle-only contract has a fresh zero state. Release every
-- legacy verification lock and purge only its ephemeral signing/challenge
-- material. Immutable request hashes, prepared-call bindings, transaction
-- hashes, outcomes, and journal rows remain available for audit.
WITH cutover AS (
  SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
)
UPDATE "verification_requests"
SET
  "status" = 'EXPIRED',
  "status_updated_at" = cutover.now_ms,
  "request_expires_at" = LEAST("request_expires_at", cutover.now_ms - 1),
  "active_owner_user_id" = NULL,
  "active_wallet" = NULL,
  "wallet_nonce" = NULL,
  "wallet_message" = NULL,
  "x_challenge" = NULL,
  "tweet_text" = NULL,
  "farcaster_challenge" = NULL,
  "farcaster_cast_text" = NULL,
  "purged_at" = COALESCE("purged_at", cutover.now_ms),
  "revision" = "revision" + 1,
  "updated_at" = cutover.now_ms
FROM cutover
WHERE "x_ownership_request_id" IS NULL
  AND "farcaster_ownership_request_id" IS NULL
  AND "status" <> 'EXPIRED';--> statement-breakpoint

WITH cutover AS (
  SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms
)
UPDATE "marketplace_genlayer_transactions"
SET
  "status" = 'NETWORK_TERMINATED',
  "error_code" = 'IDENTITY_BUNDLE_CUTOVER',
  "last_checked_at" = cutover.now_ms,
  "next_reconcile_at" = 0,
  "fence_token" = NULL,
  "fence_expires_at" = NULL,
  "updated_at" = cutover.now_ms
FROM cutover
WHERE "operation" = 'ACTIVATE_CREATOR'
  AND "status" IN ('PREPARED', 'SUBMITTED', 'ACCEPTED', 'RECONCILIATION_REQUIRED');--> statement-breakpoint

ALTER TABLE "verification_requests"
  DROP CONSTRAINT IF EXISTS "verification_requests_identity_bundle_pair";--> statement-breakpoint
ALTER TABLE "verification_requests"
  ADD CONSTRAINT "verification_requests_identity_bundle_pair" CHECK (
    ("x_ownership_request_id" IS NULL) = ("farcaster_ownership_request_id" IS NULL)
  );--> statement-breakpoint
ALTER TABLE "verification_requests"
  DROP CONSTRAINT IF EXISTS "verification_requests_identity_bundle_hashes";--> statement-breakpoint
ALTER TABLE "verification_requests"
  ADD CONSTRAINT "verification_requests_identity_bundle_hashes" CHECK (
    ("x_ownership_request_id" IS NULL OR "x_ownership_request_id" ~ '^0x[0-9a-f]{64}$')
    AND (
      "farcaster_ownership_request_id" IS NULL
      OR "farcaster_ownership_request_id" ~ '^0x[0-9a-f]{64}$'
    )
  );--> statement-breakpoint

ALTER TABLE "marketplace_genlayer_transactions"
  DROP CONSTRAINT IF EXISTS "marketplace_genlayer_transactions_operation";--> statement-breakpoint
ALTER TABLE "marketplace_genlayer_transactions"
  ADD CONSTRAINT "marketplace_genlayer_transactions_operation" CHECK (
    "operation" IN (
      'ACTIVATE_IDENTITY_BUNDLE', 'CREATE_CAMPAIGN', 'APPLY',
      'WITHDRAW_APPLICATION', 'SELECT_CREATOR', 'ACCEPT_ASSIGNMENT',
      'DECLINE_ASSIGNMENT', 'SUBMIT_EVIDENCE', 'RESOLVE_ASSIGNMENT',
      'EXPIRE_ASSIGNMENT', 'REFUND_UNALLOCATED', 'CANCEL_CAMPAIGN',
      'FINALIZE_CAMPAIGN', 'REFUND_UNDETERMINED', 'REQUEST_WITHDRAWAL',
      'EXECUTE_WITHDRAWAL', 'RECAPITALIZE_FAILED_WITHDRAWAL'
    )
  ) NOT VALID;--> statement-breakpoint
ALTER TABLE "marketplace_genlayer_transactions"
  VALIDATE CONSTRAINT "marketplace_genlayer_transactions_operation";
