-- GenLayer-native InfluencedX marketplace projections.
--
-- This migration is intentionally additive.  The existing Base Sepolia
-- campaign/profile/application rows remain untouched and readable as history;
-- StudioNet becomes authoritative only for rows in this namespaced projection.

ALTER TABLE "verification_requests" ADD COLUMN IF NOT EXISTS "identity_source" text;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN IF NOT EXISTS "farcaster_username" text;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN IF NOT EXISTS "farcaster_fid" text;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN IF NOT EXISTS "farcaster_challenge" text;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN IF NOT EXISTS "farcaster_cast_text" text;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN IF NOT EXISTS "farcaster_challenge_issued_at" bigint;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN IF NOT EXISTS "farcaster_challenge_expires_at" bigint;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN IF NOT EXISTS "farcaster_cast_hash" text;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN IF NOT EXISTS "activation_prepared_id" text;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN IF NOT EXISTS "activation_tx_hash" text;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN IF NOT EXISTS "activation_confirmed_at" bigint;--> statement-breakpoint
ALTER TABLE "verification_requests" DROP CONSTRAINT IF EXISTS "verification_requests_expiry_state";--> statement-breakpoint
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_expiry_state" CHECK (
  ("status" = 'EXPIRED' AND "active_owner_user_id" IS NULL)
  OR (
    "status" <> 'EXPIRED'
    AND (
      "active_owner_user_id" IS NOT NULL
      OR (
        "activation_confirmed_at" IS NOT NULL
        AND "genlayer_outcome" IN ('VERIFIED', 'REJECTED')
      )
    )
  )
);--> statement-breakpoint
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_identity_source" CHECK ("identity_source" IS NULL OR "identity_source" IN ('X', 'FARCASTER'));--> statement-breakpoint
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_farcaster_fid" CHECK ("farcaster_fid" IS NULL OR "farcaster_fid" ~ '^[1-9][0-9]{0,77}$');--> statement-breakpoint
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_farcaster_cast_hash" CHECK ("farcaster_cast_hash" IS NULL OR "farcaster_cast_hash" ~ '^0x[0-9a-f]{40}$');--> statement-breakpoint
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_activation_tx" CHECK ("activation_tx_hash" IS NULL OR "activation_tx_hash" ~ '^0x[0-9a-f]{64}$');--> statement-breakpoint
CREATE INDEX "verification_requests_activation_prepared_idx" ON "verification_requests" ("activation_prepared_id") WHERE "activation_prepared_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE "marketplace_genlayer_campaign_drafts" (
  "id" text PRIMARY KEY NOT NULL,
  "brand_wallet" text NOT NULL,
  "brand_name" text NOT NULL,
  "content_source" text NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "category" text NOT NULL,
  "format" text NOT NULL,
  "deliverables" jsonb NOT NULL,
  "required_phrases" jsonb NOT NULL,
  "forbidden_phrases" jsonb NOT NULL,
  "require_ad_disclosure" boolean NOT NULL,
  "semantic_brief" text NOT NULL,
  "terms_document" jsonb NOT NULL,
  "terms_hash" text NOT NULL,
  "client_nonce" text NOT NULL,
  "budget_atto" numeric(78, 0) NOT NULL,
  "application_deadline_at" bigint NOT NULL,
  "selection_deadline_at" bigint NOT NULL,
  "submission_deadline_at" bigint NOT NULL,
  "retention_seconds" bigint NOT NULL,
  "max_undetermined_retries" integer DEFAULT 2 NOT NULL,
  "status" text DEFAULT 'FUNDING' NOT NULL,
  "revision" bigint DEFAULT 0 NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  CONSTRAINT "marketplace_genlayer_campaign_drafts_wallet"
    CHECK ("brand_wallet" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "marketplace_genlayer_campaign_drafts_source"
    CHECK ("content_source" IN ('X', 'FARCASTER')),
  CONSTRAINT "marketplace_genlayer_campaign_drafts_terms"
    CHECK ("terms_hash" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT "marketplace_genlayer_campaign_drafts_money"
    CHECK ("budget_atto" > 0),
  CONSTRAINT "marketplace_genlayer_campaign_drafts_deadlines"
    CHECK (
      "application_deadline_at" > 0
      AND "selection_deadline_at" > "application_deadline_at"
      AND "submission_deadline_at" > "selection_deadline_at"
      AND "retention_seconds" BETWEEN 60 AND 604800
    ),
  CONSTRAINT "marketplace_genlayer_campaign_drafts_status"
    CHECK ("status" IN (
      'FUNDING', 'OPEN', 'CANCELLED', 'CLOSED'
    )),
  CONSTRAINT "marketplace_genlayer_campaign_drafts_retries"
    CHECK ("max_undetermined_retries" BETWEEN 1 AND 5)
);--> statement-breakpoint

CREATE INDEX "marketplace_genlayer_campaign_drafts_brand_idx"
  ON "marketplace_genlayer_campaign_drafts" ("brand_wallet", "created_at" DESC);--> statement-breakpoint
CREATE INDEX "marketplace_genlayer_campaign_drafts_status_idx"
  ON "marketplace_genlayer_campaign_drafts" ("status", "created_at" DESC);--> statement-breakpoint

CREATE TABLE "marketplace_genlayer_profiles" (
  "projection_id" text PRIMARY KEY NOT NULL,
  "identity_hash" text NOT NULL,
  "network" text DEFAULT 'studionet' NOT NULL,
  "chain_id" integer DEFAULT 61999 NOT NULL,
  "contract_address" text NOT NULL,
  "owner_wallet" text NOT NULL,
  "source" text NOT NULL,
  "handle" text NOT NULL,
  "external_user_id" text NOT NULL,
  "ownership_request_id" text NOT NULL,
  "activation_tx_hash" text NOT NULL,
  "public_handle" text,
  "display_name" text,
  "bio" text,
  "categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "visibility" "marketplace_profile_visibility" DEFAULT 'PUBLIC' NOT NULL,
  "active" boolean NOT NULL,
  "verified_at" bigint NOT NULL,
  "expires_at" bigint NOT NULL,
  "finalized_at" bigint NOT NULL,
  "snapshot_hash" text NOT NULL,
  "projected_at" bigint NOT NULL,
  CONSTRAINT "marketplace_genlayer_profiles_namespace"
    CHECK ("network" ~ '^[a-z][a-z0-9_-]{1,31}$' AND "chain_id" > 0),
  CONSTRAINT "marketplace_genlayer_profiles_hashes"
    CHECK (
      "projection_id" ~ '^0x[0-9a-f]{64}$'
      AND "identity_hash" ~ '^0x[0-9a-f]{64}$'
      AND "ownership_request_id" ~ '^0x[0-9a-f]{64}$'
      AND "activation_tx_hash" ~ '^0x[0-9a-f]{64}$'
      AND "snapshot_hash" ~ '^0x[0-9a-f]{64}$'
    ),
  CONSTRAINT "marketplace_genlayer_profiles_addresses"
    CHECK (
      "contract_address" ~ '^0x[0-9a-f]{40}$'
      AND "owner_wallet" ~ '^0x[0-9a-f]{40}$'
    ),
  CONSTRAINT "marketplace_genlayer_profiles_source"
    CHECK ("source" IN ('X', 'FARCASTER')),
  CONSTRAINT "marketplace_genlayer_profiles_time_order"
    CHECK ("expires_at" > "verified_at" AND "projected_at" >= "finalized_at")
);--> statement-breakpoint

CREATE UNIQUE INDEX "marketplace_genlayer_profiles_owner_contract_idx"
  ON "marketplace_genlayer_profiles" ("network", "chain_id", "contract_address", "owner_wallet", "source");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_genlayer_profiles_identity_contract_idx"
  ON "marketplace_genlayer_profiles" ("network", "chain_id", "contract_address", "identity_hash");--> statement-breakpoint

CREATE TABLE "marketplace_genlayer_applications_private" (
  "id" text PRIMARY KEY NOT NULL,
  "local_campaign_id" text NOT NULL,
  "creator_profile_projection_id" text NOT NULL,
  "creator_wallet" text NOT NULL,
  "requested_rate_atto" numeric(78, 0) NOT NULL,
  "pitch" text NOT NULL,
  "pitch_commitment" text NOT NULL,
  "status" text DEFAULT 'PENDING_ONCHAIN' NOT NULL,
  "revision" bigint DEFAULT 0 NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  CONSTRAINT "marketplace_genlayer_applications_campaign_fkey"
    FOREIGN KEY ("local_campaign_id") REFERENCES "marketplace_genlayer_campaign_drafts"("id")
    ON DELETE restrict,
  CONSTRAINT "marketplace_genlayer_applications_profile_fkey"
    FOREIGN KEY ("creator_profile_projection_id") REFERENCES "marketplace_genlayer_profiles"("projection_id")
    ON DELETE restrict,
  CONSTRAINT "marketplace_genlayer_applications_wallet"
    CHECK ("creator_wallet" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "marketplace_genlayer_applications_money"
    CHECK ("requested_rate_atto" > 0),
  CONSTRAINT "marketplace_genlayer_applications_commitment"
    CHECK ("pitch_commitment" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT "marketplace_genlayer_applications_status"
    CHECK ("status" IN (
      'PENDING_ONCHAIN', 'APPLIED', 'SELECTED', 'ACCEPTED',
      'DECLINED', 'REJECTED', 'WITHDRAWN'
    ))
);--> statement-breakpoint

CREATE UNIQUE INDEX "marketplace_genlayer_applications_campaign_creator_idx"
  ON "marketplace_genlayer_applications_private" ("local_campaign_id", "creator_wallet");--> statement-breakpoint
CREATE INDEX "marketplace_genlayer_applications_creator_idx"
  ON "marketplace_genlayer_applications_private" ("creator_wallet", "created_at" DESC);--> statement-breakpoint

CREATE TABLE "marketplace_genlayer_campaigns" (
  "projection_id" text PRIMARY KEY NOT NULL,
  "campaign_id" text NOT NULL,
  "local_campaign_id" text NOT NULL,
  "network" text DEFAULT 'studionet' NOT NULL,
  "chain_id" integer DEFAULT 61999 NOT NULL,
  "contract_address" text NOT NULL,
  "contract_version" text NOT NULL,
  "brand_wallet" text NOT NULL,
  "client_nonce" text NOT NULL,
  "content_source" text NOT NULL,
  "terms_hash" text NOT NULL,
  "budget_atto" numeric(78, 0) NOT NULL,
  "available_atto" numeric(78, 0) DEFAULT 0 NOT NULL,
  "reserved_atto" numeric(78, 0) DEFAULT 0 NOT NULL,
  "settled_atto" numeric(78, 0) DEFAULT 0 NOT NULL,
  "creator_paid_atto" numeric(78, 0) DEFAULT 0 NOT NULL,
  "brand_refunded_atto" numeric(78, 0) DEFAULT 0 NOT NULL,
  "fee_atto" numeric(78, 0) DEFAULT 0 NOT NULL,
  "status" text NOT NULL,
  "fee_bps" integer NOT NULL,
  "treasury_wallet" text NOT NULL,
  "application_count" integer NOT NULL,
  "assignment_count" integer NOT NULL,
  "max_undetermined_retries" integer NOT NULL,
  "application_deadline_epoch" bigint NOT NULL,
  "selection_deadline_epoch" bigint NOT NULL,
  "submission_deadline_epoch" bigint NOT NULL,
  "retention_seconds" bigint NOT NULL,
  "created_at_epoch" bigint NOT NULL,
  "closed_at_epoch" bigint NOT NULL,
  "creation_tx_hash" text NOT NULL,
  "last_tx_hash" text NOT NULL,
  "finalized_at" bigint NOT NULL,
  "snapshot_hash" text NOT NULL,
  "projected_at" bigint NOT NULL,
  CONSTRAINT "marketplace_genlayer_campaigns_local_campaign_fkey"
    FOREIGN KEY ("local_campaign_id") REFERENCES "marketplace_genlayer_campaign_drafts"("id")
    ON DELETE restrict,
  CONSTRAINT "marketplace_genlayer_campaigns_namespace"
    CHECK ("network" ~ '^[a-z][a-z0-9_-]{1,31}$' AND "chain_id" > 0),
  CONSTRAINT "marketplace_genlayer_campaigns_hashes"
    CHECK (
      "projection_id" ~ '^0x[0-9a-f]{64}$'
      AND "campaign_id" ~ '^0x[0-9a-f]{64}$'
      AND "terms_hash" ~ '^0x[0-9a-f]{64}$'
      AND "creation_tx_hash" ~ '^0x[0-9a-f]{64}$'
      AND "last_tx_hash" ~ '^0x[0-9a-f]{64}$'
      AND "snapshot_hash" ~ '^0x[0-9a-f]{64}$'
    ),
  CONSTRAINT "marketplace_genlayer_campaigns_addresses"
    CHECK (
      "contract_address" ~ '^0x[0-9a-f]{40}$'
      AND "brand_wallet" ~ '^0x[0-9a-f]{40}$'
      AND "treasury_wallet" ~ '^0x[0-9a-f]{40}$'
    ),
  CONSTRAINT "marketplace_genlayer_campaigns_source"
    CHECK ("content_source" IN ('X', 'FARCASTER')),
  CONSTRAINT "marketplace_genlayer_campaigns_money"
    CHECK (
      "budget_atto" > 0
      AND "available_atto" >= 0
      AND "reserved_atto" >= 0
      AND "settled_atto" >= 0
      AND "creator_paid_atto" >= 0
      AND "brand_refunded_atto" >= 0
      AND "fee_atto" >= 0
      AND "available_atto" + "reserved_atto" + "creator_paid_atto" + "brand_refunded_atto" + "fee_atto" = "budget_atto"
      AND "settled_atto" = "creator_paid_atto" + "brand_refunded_atto" + "fee_atto"
    ),
  CONSTRAINT "marketplace_genlayer_campaigns_deadlines"
    CHECK (
      "application_deadline_epoch" > 0
      AND "selection_deadline_epoch" > "application_deadline_epoch"
      AND "submission_deadline_epoch" > "selection_deadline_epoch"
      AND "retention_seconds" BETWEEN 60 AND 604800
    ),
  CONSTRAINT "marketplace_genlayer_campaigns_retries"
    CHECK ("max_undetermined_retries" BETWEEN 1 AND 5),
  CONSTRAINT "marketplace_genlayer_campaigns_status"
    CHECK ("status" IN ('OPEN', 'CANCELLED', 'CLOSED')),
  CONSTRAINT "marketplace_genlayer_campaigns_counts"
    CHECK ("application_count" >= 0 AND "assignment_count" >= 0 AND "fee_bps" BETWEEN 0 AND 1000)
);--> statement-breakpoint

CREATE UNIQUE INDEX "marketplace_genlayer_campaigns_local_idx"
  ON "marketplace_genlayer_campaigns" ("local_campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_genlayer_campaigns_entity_contract_idx"
  ON "marketplace_genlayer_campaigns" ("network", "chain_id", "contract_address", "campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_genlayer_campaigns_tx_idx"
  ON "marketplace_genlayer_campaigns" ("network", "chain_id", "contract_address", "creation_tx_hash");--> statement-breakpoint
CREATE INDEX "marketplace_genlayer_campaigns_status_idx"
  ON "marketplace_genlayer_campaigns" ("status", "projected_at");--> statement-breakpoint

CREATE TABLE "marketplace_genlayer_assignments" (
  "projection_id" text PRIMARY KEY NOT NULL,
  "assignment_id" text NOT NULL,
  "network" text DEFAULT 'studionet' NOT NULL,
  "chain_id" integer DEFAULT 61999 NOT NULL,
  "contract_address" text NOT NULL,
  "contract_version" text NOT NULL,
  "campaign_projection_id" text NOT NULL,
  "campaign_id" text NOT NULL,
  "local_application_id" text NOT NULL,
  "brand_wallet" text NOT NULL,
  "creator_wallet" text NOT NULL,
  "content_source" text NOT NULL,
  "creator_handle" text NOT NULL,
  "creator_external_user_id" text NOT NULL,
  "creator_identity_hash" text NOT NULL,
  "application_id" text NOT NULL,
  "agreed_rate_atto" numeric(78, 0) NOT NULL,
  "agreement_hash" text NOT NULL,
  "status" text NOT NULL,
  "selected_at_epoch" bigint NOT NULL,
  "acceptance_deadline_epoch" bigint NOT NULL,
  "accepted_at_epoch" bigint NOT NULL,
  "post_id" text NOT NULL,
  "submission_hash" text,
  "resolution_request_id" text,
  "resolution_attempts" integer DEFAULT 0 NOT NULL,
  "resolution_eligible_at_epoch" bigint DEFAULT 0 NOT NULL,
  "last_resolution_at_epoch" bigint DEFAULT 0 NOT NULL,
  "evidence_hash" text,
  "outcome" "marketplace_resolution_outcome",
  "reasoning" text DEFAULT '' NOT NULL,
  "resolution_checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "resolution_round" integer DEFAULT 0 NOT NULL,
  "max_undetermined_retries" integer NOT NULL,
  "creator_credit_atto" numeric(78, 0) DEFAULT 0 NOT NULL,
  "brand_credit_atto" numeric(78, 0) DEFAULT 0 NOT NULL,
  "fee_atto" numeric(78, 0) DEFAULT 0 NOT NULL,
  "submitted_at_epoch" bigint DEFAULT 0 NOT NULL,
  "settled_at_epoch" bigint DEFAULT 0 NOT NULL,
  "closed_at_epoch" bigint DEFAULT 0 NOT NULL,
  "selection_tx_hash" text NOT NULL,
  "last_tx_hash" text NOT NULL,
  "finalized_at" bigint NOT NULL,
  "snapshot_hash" text NOT NULL,
  "projected_at" bigint NOT NULL,
  CONSTRAINT "marketplace_genlayer_assignments_campaign_fkey"
    FOREIGN KEY ("campaign_projection_id") REFERENCES "marketplace_genlayer_campaigns"("projection_id")
    ON DELETE restrict,
  CONSTRAINT "marketplace_genlayer_assignments_application_fkey"
    FOREIGN KEY ("local_application_id") REFERENCES "marketplace_genlayer_applications_private"("id")
    ON DELETE restrict,
  CONSTRAINT "marketplace_genlayer_assignments_namespace"
    CHECK ("network" ~ '^[a-z][a-z0-9_-]{1,31}$' AND "chain_id" > 0),
  CONSTRAINT "marketplace_genlayer_assignments_hashes"
    CHECK (
      "projection_id" ~ '^0x[0-9a-f]{64}$'
      AND "assignment_id" ~ '^0x[0-9a-f]{64}$'
      AND "campaign_id" ~ '^0x[0-9a-f]{64}$'
      AND "application_id" ~ '^0x[0-9a-f]{64}$'
      AND "agreement_hash" ~ '^0x[0-9a-f]{64}$'
      AND "creator_identity_hash" ~ '^0x[0-9a-f]{64}$'
      AND "selection_tx_hash" ~ '^0x[0-9a-f]{64}$'
      AND "last_tx_hash" ~ '^0x[0-9a-f]{64}$'
      AND "snapshot_hash" ~ '^0x[0-9a-f]{64}$'
      AND ("resolution_request_id" IS NULL OR "resolution_request_id" ~ '^0x[0-9a-f]{64}$')
      AND ("submission_hash" IS NULL OR "submission_hash" ~ '^0x[0-9a-f]{64}$')
      AND ("evidence_hash" IS NULL OR "evidence_hash" ~ '^0x[0-9a-f]{64}$')
    ),
  CONSTRAINT "marketplace_genlayer_assignments_creator"
    CHECK ("contract_address" ~ '^0x[0-9a-f]{40}$' AND "brand_wallet" ~ '^0x[0-9a-f]{40}$' AND "creator_wallet" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "marketplace_genlayer_assignments_source"
    CHECK ("content_source" IN ('X', 'FARCASTER')),
  CONSTRAINT "marketplace_genlayer_assignments_money"
    CHECK (
      "agreed_rate_atto" > 0
      AND "creator_credit_atto" >= 0
      AND "brand_credit_atto" >= 0
      AND "fee_atto" >= 0
      AND "creator_credit_atto" + "brand_credit_atto" + "fee_atto" <= "agreed_rate_atto"
    ),
  CONSTRAINT "marketplace_genlayer_assignments_rounds"
    CHECK (
      "resolution_round" >= 0
      AND "resolution_attempts" >= 0
      AND "max_undetermined_retries" BETWEEN 1 AND 5
      AND "resolution_attempts" <= "max_undetermined_retries"
    ),
  CONSTRAINT "marketplace_genlayer_assignments_status"
    CHECK ("status" IN ('SELECTED', 'ACCEPTED', 'SUBMITTED', 'UNDETERMINED', 'SETTLED_PASS', 'SETTLED_FAIL', 'DECLINED', 'EXPIRED', 'REFUNDED'))
);--> statement-breakpoint

CREATE UNIQUE INDEX "marketplace_genlayer_assignments_application_idx"
  ON "marketplace_genlayer_assignments" ("local_application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_genlayer_assignments_entity_contract_idx"
  ON "marketplace_genlayer_assignments" ("network", "chain_id", "contract_address", "assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_genlayer_assignments_selection_tx_idx"
  ON "marketplace_genlayer_assignments" ("campaign_projection_id", "selection_tx_hash");--> statement-breakpoint
CREATE INDEX "marketplace_genlayer_assignments_campaign_status_idx"
  ON "marketplace_genlayer_assignments" ("campaign_id", "status");--> statement-breakpoint

CREATE TABLE "marketplace_genlayer_transactions" (
  "prepared_id" text PRIMARY KEY NOT NULL,
  "network" text DEFAULT 'studionet' NOT NULL,
  "chain_id" integer DEFAULT 61999 NOT NULL,
  "contract_address" text NOT NULL,
  "operation" text NOT NULL,
  "function_name" text NOT NULL,
  "args" jsonb NOT NULL,
  "arg_types" jsonb NOT NULL,
  "args_hash" text NOT NULL,
  "value_atto" numeric(78, 0) DEFAULT 0 NOT NULL,
  "actor_wallet" text NOT NULL,
  "local_campaign_id" text,
  "local_application_id" text,
  "onchain_entity_id" text,
  "transaction_hash" text,
  "status" text DEFAULT 'PREPARED' NOT NULL,
  "lifecycle_status" text,
  "execution_result" text,
  "error_code" text,
  "submitted_at" bigint,
  "accepted_at" bigint,
  "finalized_at" bigint,
  "last_checked_at" bigint,
  "reconciliation_attempts" integer DEFAULT 0 NOT NULL,
  "next_reconcile_at" bigint DEFAULT 0 NOT NULL,
  "fence_token" text,
  "fence_expires_at" bigint,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  CONSTRAINT "marketplace_genlayer_transactions_campaign_fkey"
    FOREIGN KEY ("local_campaign_id") REFERENCES "marketplace_genlayer_campaign_drafts"("id")
    ON DELETE restrict,
  CONSTRAINT "marketplace_genlayer_transactions_application_fkey"
    FOREIGN KEY ("local_application_id") REFERENCES "marketplace_genlayer_applications_private"("id")
    ON DELETE restrict,
  CONSTRAINT "marketplace_genlayer_transactions_namespace"
    CHECK ("network" ~ '^[a-z][a-z0-9_-]{1,31}$' AND "chain_id" > 0),
  CONSTRAINT "marketplace_genlayer_transactions_status"
    CHECK ("status" IN (
      'PREPARED', 'SUBMITTED', 'ACCEPTED', 'FINALIZED',
      'EXECUTION_FAILED', 'NETWORK_TERMINATED', 'RECONCILIATION_REQUIRED'
    )),
  CONSTRAINT "marketplace_genlayer_transactions_operation"
    CHECK ("operation" IN (
      'ACTIVATE_CREATOR', 'CREATE_CAMPAIGN', 'APPLY',
      'WITHDRAW_APPLICATION', 'SELECT_CREATOR', 'ACCEPT_ASSIGNMENT',
      'DECLINE_ASSIGNMENT', 'SUBMIT_EVIDENCE', 'RESOLVE_ASSIGNMENT',
      'EXPIRE_ASSIGNMENT', 'REFUND_UNALLOCATED', 'CANCEL_CAMPAIGN',
      'FINALIZE_CAMPAIGN', 'REFUND_UNDETERMINED', 'REQUEST_WITHDRAWAL',
      'EXECUTE_WITHDRAWAL', 'RECAPITALIZE_FAILED_WITHDRAWAL'
    )),
  CONSTRAINT "marketplace_genlayer_transactions_addresses"
    CHECK (
      "contract_address" ~ '^0x[0-9a-f]{40}$'
      AND "actor_wallet" ~ '^0x[0-9a-f]{40}$'
    ),
  CONSTRAINT "marketplace_genlayer_transactions_hashes"
    CHECK (
      "args_hash" ~ '^0x[0-9a-f]{64}$'
      AND ("transaction_hash" IS NULL OR "transaction_hash" ~ '^0x[0-9a-f]{64}$')
      AND ("onchain_entity_id" IS NULL OR "onchain_entity_id" ~ '^0x[0-9a-f]{64}$')
    ),
  CONSTRAINT "marketplace_genlayer_transactions_money"
    CHECK ("value_atto" >= 0),
  CONSTRAINT "marketplace_genlayer_transactions_finality"
    CHECK (
      "status" <> 'FINALIZED'
      OR ("transaction_hash" IS NOT NULL AND "finalized_at" IS NOT NULL AND "error_code" IS NULL)
    ),
  CONSTRAINT "marketplace_genlayer_transactions_fence"
    CHECK (("fence_token" IS NULL) = ("fence_expires_at" IS NULL))
);--> statement-breakpoint

CREATE UNIQUE INDEX "marketplace_genlayer_transactions_hash_idx"
  ON "marketplace_genlayer_transactions" ("network", "chain_id", "transaction_hash")
  WHERE "transaction_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "marketplace_genlayer_transactions_reconcile_idx"
  ON "marketplace_genlayer_transactions" ("next_reconcile_at", "updated_at")
  WHERE "status" IN ('SUBMITTED', 'ACCEPTED', 'RECONCILIATION_REQUIRED');--> statement-breakpoint
CREATE INDEX "marketplace_genlayer_transactions_campaign_idx"
  ON "marketplace_genlayer_transactions" ("local_campaign_id", "created_at");--> statement-breakpoint

CREATE TABLE "marketplace_genlayer_claimable_balances" (
  "network" text DEFAULT 'studionet' NOT NULL,
  "chain_id" integer DEFAULT 61999 NOT NULL,
  "contract_address" text NOT NULL,
  "wallet" text NOT NULL,
  "amount_atto" numeric(78, 0) DEFAULT 0 NOT NULL,
  "next_withdrawal_nonce" bigint DEFAULT 0 NOT NULL,
  "last_transaction_hash" text NOT NULL,
  "snapshot_hash" text NOT NULL,
  "projected_at" bigint NOT NULL,
  CONSTRAINT "marketplace_genlayer_claimable_balances_pk"
    PRIMARY KEY ("network", "chain_id", "contract_address", "wallet"),
  CONSTRAINT "marketplace_genlayer_claimable_balances_namespace"
    CHECK ("network" ~ '^[a-z][a-z0-9_-]{1,31}$' AND "chain_id" > 0),
  CONSTRAINT "marketplace_genlayer_claimable_balances_addresses"
    CHECK (
      "contract_address" ~ '^0x[0-9a-f]{40}$'
      AND "wallet" ~ '^0x[0-9a-f]{40}$'
    ),
  CONSTRAINT "marketplace_genlayer_claimable_balances_amount"
    CHECK ("amount_atto" >= 0),
  CONSTRAINT "marketplace_genlayer_claimable_balances_tx"
    CHECK ("last_transaction_hash" ~ '^0x[0-9a-f]{64}$' AND "snapshot_hash" ~ '^0x[0-9a-f]{64}$')
);--> statement-breakpoint

CREATE TABLE "marketplace_genlayer_withdrawals" (
  "projection_id" text PRIMARY KEY NOT NULL,
  "withdrawal_id" text NOT NULL,
  "network" text DEFAULT 'studionet' NOT NULL,
  "chain_id" integer DEFAULT 61999 NOT NULL,
  "contract_address" text NOT NULL,
  "contract_version" text NOT NULL,
  "account" text NOT NULL,
  "nonce" bigint NOT NULL,
  "amount_atto" numeric(78, 0) NOT NULL,
  "status" text NOT NULL,
  "requested_at_epoch" bigint NOT NULL,
  "emitted_at_epoch" bigint NOT NULL,
  "reconciled_at_epoch" bigint NOT NULL,
  "evidence_hash" text NOT NULL,
  "recapitalized_atto" numeric(78, 0) DEFAULT 0 NOT NULL,
  "request_tx_hash" text NOT NULL,
  "last_tx_hash" text NOT NULL,
  "finalized_at" bigint NOT NULL,
  "snapshot_hash" text NOT NULL,
  "projected_at" bigint NOT NULL,
  CONSTRAINT "marketplace_genlayer_withdrawals_namespace"
    CHECK ("network" ~ '^[a-z][a-z0-9_-]{1,31}$' AND "chain_id" > 0),
  CONSTRAINT "marketplace_genlayer_withdrawals_addresses"
    CHECK ("contract_address" ~ '^0x[0-9a-f]{40}$' AND "account" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "marketplace_genlayer_withdrawals_hashes"
    CHECK ("projection_id" ~ '^0x[0-9a-f]{64}$' AND "withdrawal_id" ~ '^0x[0-9a-f]{64}$' AND "evidence_hash" ~ '^0x[0-9a-f]{64}$' AND "request_tx_hash" ~ '^0x[0-9a-f]{64}$' AND "last_tx_hash" ~ '^0x[0-9a-f]{64}$' AND "snapshot_hash" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT "marketplace_genlayer_withdrawals_money"
    CHECK ("amount_atto" > 0 AND "recapitalized_atto" >= 0 AND "recapitalized_atto" <= "amount_atto"),
  CONSTRAINT "marketplace_genlayer_withdrawals_status"
    CHECK ("status" IN ('PENDING', 'EMITTED_UNCONFIRMED', 'CONFIRMED', 'RESTORED_FAILED'))
);--> statement-breakpoint

CREATE UNIQUE INDEX "marketplace_genlayer_withdrawals_entity_contract_idx"
  ON "marketplace_genlayer_withdrawals" ("network", "chain_id", "contract_address", "withdrawal_id");--> statement-breakpoint
CREATE INDEX "marketplace_genlayer_withdrawals_account_status_idx"
  ON "marketplace_genlayer_withdrawals" ("network", "chain_id", "contract_address", "account", "status", "projected_at" DESC);--> statement-breakpoint

CREATE TABLE "marketplace_genlayer_projection_cursors" (
  "network" text DEFAULT 'studionet' NOT NULL,
  "chain_id" integer DEFAULT 61999 NOT NULL,
  "contract_address" text NOT NULL,
  "contract_version" text NOT NULL,
  "last_transaction_hash" text,
  "last_finalized_at" bigint,
  "snapshot_hash" text,
  "revision" bigint DEFAULT 0 NOT NULL,
  "updated_at" bigint NOT NULL,
  CONSTRAINT "marketplace_genlayer_projection_cursors_pk"
    PRIMARY KEY ("network", "chain_id", "contract_address"),
  CONSTRAINT "marketplace_genlayer_projection_cursors_namespace"
    CHECK ("network" ~ '^[a-z][a-z0-9_-]{1,31}$' AND "chain_id" > 0),
  CONSTRAINT "marketplace_genlayer_projection_cursors_address"
    CHECK ("contract_address" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "marketplace_genlayer_projection_cursors_hashes"
    CHECK (
      ("last_transaction_hash" IS NULL OR "last_transaction_hash" ~ '^0x[0-9a-f]{64}$')
      AND ("snapshot_hash" IS NULL OR "snapshot_hash" ~ '^0x[0-9a-f]{64}$')
    )
);--> statement-breakpoint

COMMENT ON TABLE "marketplace_genlayer_campaigns" IS
  'Authoritative StudioNet marketplace projection using native GEN atto units. Legacy Base campaign rows remain read-only history.';--> statement-breakpoint
COMMENT ON TABLE "marketplace_genlayer_transactions" IS
  'Prepared, submitted, finalized, and reconcilable GenLayer marketplace transaction journal; contains no signer material.';--> statement-breakpoint
COMMENT ON COLUMN "marketplace_genlayer_applications_private"."pitch" IS
  'Private offchain creator pitch. Only its commitment may be sent to GenLayer.';
