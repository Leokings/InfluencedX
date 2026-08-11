CREATE TYPE "public"."marketplace_campaign_status" AS ENUM(
  'DRAFT', 'FUNDING', 'OPEN', 'MATCHED', 'ACTIVE', 'SUBMITTED',
  'RESOLVING', 'PAID', 'REFUNDED', 'CANCELLED'
);--> statement-breakpoint
CREATE TYPE "public"."marketplace_funding_status" AS ENUM(
  'UNFUNDED', 'PENDING', 'FUNDED', 'FAILED'
);--> statement-breakpoint
CREATE TYPE "public"."marketplace_application_status" AS ENUM(
  'APPLIED', 'SELECTED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'
);--> statement-breakpoint
CREATE TYPE "public"."marketplace_profile_visibility" AS ENUM(
  'PUBLIC', 'UNLISTED', 'PRIVATE'
);--> statement-breakpoint
CREATE TYPE "public"."marketplace_metric_risk_level" AS ENUM(
  'LOW', 'MEDIUM', 'HIGH', 'UNDETERMINED'
);--> statement-breakpoint
CREATE TYPE "public"."marketplace_resolution_outcome" AS ENUM(
  'PASS', 'FAIL', 'UNDETERMINED'
);--> statement-breakpoint

CREATE TABLE "marketplace_campaigns" (
  "id" text PRIMARY KEY NOT NULL,
  "brand_wallet" text NOT NULL,
  "brand_name" text NOT NULL,
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
  "budget_amount" numeric(78, 0) NOT NULL,
  "token_address" text NOT NULL,
  "token_decimals" integer DEFAULT 6 NOT NULL,
  "chain_id" integer DEFAULT 84532 NOT NULL,
  "deadline_at" bigint NOT NULL,
  "selection_deadline_at" bigint NOT NULL,
  "submission_deadline_at" bigint NOT NULL,
  "retention_seconds" bigint NOT NULL,
  "status" "marketplace_campaign_status" DEFAULT 'FUNDING' NOT NULL,
  "funding_status" "marketplace_funding_status" DEFAULT 'UNFUNDED' NOT NULL,
  "escrow_contract" text,
  "escrow_campaign_id" text,
  "funding_tx_hash" text,
  "funded_at" bigint,
  "revision" bigint DEFAULT 0 NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  CONSTRAINT "marketplace_campaigns_brand_wallet_format"
    CHECK ("brand_wallet" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "marketplace_campaigns_token_address_format"
    CHECK ("token_address" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "marketplace_campaigns_base_sepolia_only"
    CHECK ("chain_id" = 84532 AND "token_decimals" = 6),
  CONSTRAINT "marketplace_campaigns_positive_budget"
    CHECK ("budget_amount" > 0),
  CONSTRAINT "marketplace_campaigns_terms_hash_format"
    CHECK ("terms_hash" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT "marketplace_campaigns_deadline_order"
    CHECK (
      "deadline_at" > "created_at"
      AND "selection_deadline_at" > "deadline_at"
      AND "submission_deadline_at" > "selection_deadline_at"
      AND "retention_seconds" > 0
    ),
  CONSTRAINT "marketplace_campaigns_escrow_address_format"
    CHECK ("escrow_contract" IS NULL OR "escrow_contract" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "marketplace_campaigns_funding_tx_format"
    CHECK ("funding_tx_hash" IS NULL OR "funding_tx_hash" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT "marketplace_campaigns_funded_binding"
    CHECK (
      "funding_status" <> 'FUNDED'
      OR (
        "escrow_contract" IS NOT NULL
        AND "escrow_campaign_id" IS NOT NULL
        AND "funding_tx_hash" IS NOT NULL
        AND "funded_at" IS NOT NULL
      )
    ),
  CONSTRAINT "marketplace_campaigns_open_requires_funding"
    CHECK (
      "status" NOT IN ('OPEN', 'MATCHED', 'ACTIVE', 'SUBMITTED', 'RESOLVING', 'PAID')
      OR "funding_status" = 'FUNDED'
    ),
  CONSTRAINT "marketplace_campaigns_revision_nonnegative"
    CHECK ("revision" >= 0)
);--> statement-breakpoint

CREATE INDEX "marketplace_campaigns_status_created_idx"
  ON "marketplace_campaigns" USING btree ("status", "created_at" DESC);--> statement-breakpoint
CREATE INDEX "marketplace_campaigns_brand_created_idx"
  ON "marketplace_campaigns" USING btree ("brand_wallet", "created_at" DESC);--> statement-breakpoint
CREATE INDEX "marketplace_campaigns_category_status_idx"
  ON "marketplace_campaigns" USING btree ("category", "status");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_campaigns_funding_tx_idx"
  ON "marketplace_campaigns" USING btree ("funding_tx_hash")
  WHERE "funding_tx_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_campaigns_escrow_campaign_idx"
  ON "marketplace_campaigns" USING btree ("escrow_contract", "escrow_campaign_id")
  WHERE "escrow_contract" IS NOT NULL AND "escrow_campaign_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE "marketplace_creator_profiles" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_wallet" text NOT NULL,
  "base_profile_id" text NOT NULL,
  "identity_hash" text NOT NULL,
  "handle_hash" text NOT NULL,
  "verification_post_hash" text NOT NULL,
  "verification_tx_hash" text NOT NULL,
  "public_handle" text,
  "display_name" text,
  "bio" text,
  "categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "visibility" "marketplace_profile_visibility" DEFAULT 'PUBLIC' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "credential_expires_at" bigint NOT NULL,
  "verified_at" bigint NOT NULL,
  "latest_metrics_snapshot_id" text,
  "metrics_updated_at" bigint,
  "revision" bigint DEFAULT 0 NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  CONSTRAINT "marketplace_creator_profiles_owner_wallet_format"
    CHECK ("owner_wallet" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "marketplace_creator_profiles_base_profile_id_format"
    CHECK ("base_profile_id" ~ '^[1-9][0-9]*$'),
  CONSTRAINT "marketplace_creator_profiles_commitment_formats"
    CHECK (
      "identity_hash" ~ '^0x[0-9a-f]{64}$'
      AND "handle_hash" ~ '^0x[0-9a-f]{64}$'
      AND "verification_post_hash" ~ '^0x[0-9a-f]{64}$'
    ),
  CONSTRAINT "marketplace_creator_profiles_verification_tx_format"
    CHECK ("verification_tx_hash" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT "marketplace_creator_profiles_credential_order"
    CHECK ("credential_expires_at" > "verified_at"),
  CONSTRAINT "marketplace_creator_profiles_revision_nonnegative"
    CHECK ("revision" >= 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX "marketplace_creator_profiles_owner_wallet_idx"
  ON "marketplace_creator_profiles" USING btree ("owner_wallet");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_creator_profiles_base_profile_idx"
  ON "marketplace_creator_profiles" USING btree ("base_profile_id");--> statement-breakpoint
CREATE INDEX "marketplace_creator_profiles_visibility_updated_idx"
  ON "marketplace_creator_profiles" USING btree ("visibility", "updated_at" DESC);--> statement-breakpoint

CREATE TABLE "marketplace_creator_metrics_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "profile_id" text NOT NULL,
  "followers_count" bigint NOT NULL,
  "account_created_at" bigint NOT NULL,
  "posts_sampled" integer NOT NULL,
  "median_engagement_count" bigint NOT NULL,
  "engagement_rate_bps" integer NOT NULL,
  "estimated_pay_min_amount" numeric(78, 0) NOT NULL,
  "estimated_pay_max_amount" numeric(78, 0) NOT NULL,
  "risk_level" "marketplace_metric_risk_level" NOT NULL,
  "evidence_hash" text NOT NULL,
  "genlayer_request_id" text,
  "genlayer_tx_hash" text,
  "captured_at" bigint NOT NULL,
  "expires_at" bigint NOT NULL,
  "created_at" bigint NOT NULL,
  CONSTRAINT "marketplace_creator_metrics_snapshots_profile_id_fkey"
    FOREIGN KEY ("profile_id") REFERENCES "public"."marketplace_creator_profiles"("id")
    ON DELETE cascade,
  CONSTRAINT "marketplace_creator_metrics_nonnegative"
    CHECK (
      "followers_count" >= 0
      AND "posts_sampled" >= 0
      AND "median_engagement_count" >= 0
      AND "engagement_rate_bps" >= 0
    ),
  CONSTRAINT "marketplace_creator_metrics_pay_range"
    CHECK (
      "estimated_pay_min_amount" >= 0
      AND "estimated_pay_max_amount" >= "estimated_pay_min_amount"
    ),
  CONSTRAINT "marketplace_creator_metrics_evidence_hash_format"
    CHECK ("evidence_hash" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT "marketplace_creator_metrics_genlayer_hash_formats"
    CHECK (
      ("genlayer_request_id" IS NULL OR "genlayer_request_id" ~ '^0x[0-9a-f]{64}$')
      AND ("genlayer_tx_hash" IS NULL OR "genlayer_tx_hash" ~ '^0x[0-9a-f]{64}$')
    ),
  CONSTRAINT "marketplace_creator_metrics_time_order"
    CHECK ("account_created_at" <= "captured_at" AND "expires_at" > "captured_at")
);--> statement-breakpoint

CREATE INDEX "marketplace_creator_metrics_profile_captured_idx"
  ON "marketplace_creator_metrics_snapshots" USING btree ("profile_id", "captured_at" DESC);--> statement-breakpoint

CREATE TABLE "marketplace_applications" (
  "id" text PRIMARY KEY NOT NULL,
  "campaign_id" text NOT NULL,
  "creator_wallet" text NOT NULL,
  "creator_profile_id" text NOT NULL,
  "creator_handle" text,
  "creator_handle_hash" text NOT NULL,
  "requested_amount" numeric(78, 0) NOT NULL,
  "pitch" text NOT NULL,
  "status" "marketplace_application_status" DEFAULT 'APPLIED' NOT NULL,
  "revision" bigint DEFAULT 0 NOT NULL,
  "selected_at" bigint,
  "accepted_at" bigint,
  "escrow_assignment_id" text,
  "identity_hash" text,
  "agreement_hash" text,
  "selection_tx_hash" text,
  "acceptance_tx_hash" text,
  "post_id_hash" text,
  "x_post_id" text,
  "submission_hash" text,
  "submission_tx_hash" text,
  "submitted_at" bigint,
  "request_id" text,
  "resolution_round" integer DEFAULT 0 NOT NULL,
  "resolution_request_tx_hash" text,
  "resolution_requested_at" bigint,
  "resolution_outcome" "marketplace_resolution_outcome",
  "resolution_evidence_hash" text,
  "resolution_tx_hash" text,
  "claim_tx_hash" text,
  "genlayer_submitter_status" text,
  "genlayer_tx_hash" text,
  "genlayer_result_outcome" "marketplace_resolution_outcome",
  "genlayer_lifecycle_status" text,
  "genlayer_execution_result" text,
  "genlayer_error_code" text,
  "genlayer_submitted_at" bigint,
  "genlayer_finalized_at" bigint,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  CONSTRAINT "marketplace_applications_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "public"."marketplace_campaigns"("id")
    ON DELETE cascade,
  CONSTRAINT "marketplace_applications_creator_profile_id_fkey"
    FOREIGN KEY ("creator_profile_id") REFERENCES "public"."marketplace_creator_profiles"("id")
    ON DELETE restrict,
  CONSTRAINT "marketplace_applications_creator_wallet_format"
    CHECK ("creator_wallet" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "marketplace_applications_handle_hash_format"
    CHECK ("creator_handle_hash" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT "marketplace_applications_positive_rate"
    CHECK ("requested_amount" > 0),
  CONSTRAINT "marketplace_applications_revision_nonnegative"
    CHECK ("revision" >= 0),
  CONSTRAINT "marketplace_applications_selection_timestamps"
    CHECK (
      ("status" NOT IN ('SELECTED', 'ACCEPTED') OR "selected_at" IS NOT NULL)
      AND ("status" <> 'ACCEPTED' OR "accepted_at" IS NOT NULL)
    ),
  CONSTRAINT "marketplace_applications_assignment_id_format"
    CHECK ("escrow_assignment_id" IS NULL OR "escrow_assignment_id" ~ '^[1-9][0-9]*$'),
  CONSTRAINT "marketplace_applications_commitment_formats"
    CHECK (
      ("identity_hash" IS NULL OR "identity_hash" ~ '^0x[0-9a-f]{64}$')
      AND ("agreement_hash" IS NULL OR "agreement_hash" ~ '^0x[0-9a-f]{64}$')
      AND ("post_id_hash" IS NULL OR "post_id_hash" ~ '^0x[0-9a-f]{64}$')
      AND ("submission_hash" IS NULL OR "submission_hash" ~ '^0x[0-9a-f]{64}$')
      AND ("request_id" IS NULL OR "request_id" ~ '^0x[0-9a-f]{64}$')
      AND ("resolution_evidence_hash" IS NULL OR "resolution_evidence_hash" ~ '^0x[0-9a-f]{64}$')
    ),
  CONSTRAINT "marketplace_applications_x_post_id_format"
    CHECK ("x_post_id" IS NULL OR "x_post_id" ~ '^[1-9][0-9]{5,24}$'),
  CONSTRAINT "marketplace_applications_submission_state"
    CHECK (
      ("submission_tx_hash" IS NULL) = ("submitted_at" IS NULL)
      AND ("submission_hash" IS NULL) = ("post_id_hash" IS NULL)
      AND ("post_id_hash" IS NULL) = ("x_post_id" IS NULL)
    ),
  CONSTRAINT "marketplace_applications_resolution_request_state"
    CHECK (
      ("resolution_request_tx_hash" IS NULL) = ("resolution_requested_at" IS NULL)
      AND ("request_id" IS NULL) = ("resolution_request_tx_hash" IS NULL)
    ),
  CONSTRAINT "marketplace_applications_transaction_hash_formats"
    CHECK (
      ("selection_tx_hash" IS NULL OR "selection_tx_hash" ~ '^0x[0-9a-f]{64}$')
      AND ("acceptance_tx_hash" IS NULL OR "acceptance_tx_hash" ~ '^0x[0-9a-f]{64}$')
      AND ("submission_tx_hash" IS NULL OR "submission_tx_hash" ~ '^0x[0-9a-f]{64}$')
      AND ("resolution_request_tx_hash" IS NULL OR "resolution_request_tx_hash" ~ '^0x[0-9a-f]{64}$')
      AND ("resolution_tx_hash" IS NULL OR "resolution_tx_hash" ~ '^0x[0-9a-f]{64}$')
      AND ("claim_tx_hash" IS NULL OR "claim_tx_hash" ~ '^0x[0-9a-f]{64}$')
    ),
  CONSTRAINT "marketplace_applications_resolution_round_nonnegative"
    CHECK ("resolution_round" >= 0),
  CONSTRAINT "marketplace_applications_genlayer_tx_format"
    CHECK ("genlayer_tx_hash" IS NULL OR "genlayer_tx_hash" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT "marketplace_applications_genlayer_status_values"
    CHECK (
      "genlayer_submitter_status" IS NULL
      OR "genlayer_submitter_status" IN (
        'QUEUED', 'PRECHECKING', 'PRECHECK_FAILED', 'BROADCASTING', 'SUBMITTED',
        'POLLING', 'FINALIZED', 'EXECUTION_FAILED', 'NETWORK_TERMINATED',
        'RECONCILIATION_REQUIRED', 'POLLING_EXHAUSTED', 'POISONED'
      )
    ),
  CONSTRAINT "marketplace_applications_genlayer_finality"
    CHECK (
      "genlayer_submitter_status" <> 'FINALIZED'
      OR (
        "genlayer_tx_hash" IS NOT NULL
        AND "genlayer_result_outcome" IS NOT NULL
        AND "genlayer_finalized_at" IS NOT NULL
        AND "genlayer_error_code" IS NULL
      )
    )
);--> statement-breakpoint

CREATE UNIQUE INDEX "marketplace_applications_campaign_creator_idx"
  ON "marketplace_applications" USING btree ("campaign_id", "creator_wallet");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_applications_one_selected_idx"
  ON "marketplace_applications" USING btree ("campaign_id")
  WHERE "status" IN ('SELECTED', 'ACCEPTED');--> statement-breakpoint
CREATE INDEX "marketplace_applications_creator_created_idx"
  ON "marketplace_applications" USING btree ("creator_wallet", "created_at" DESC);--> statement-breakpoint
CREATE INDEX "marketplace_applications_campaign_status_idx"
  ON "marketplace_applications" USING btree ("campaign_id", "status");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_applications_selection_tx_idx"
  ON "marketplace_applications" USING btree ("selection_tx_hash")
  WHERE "selection_tx_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_applications_acceptance_tx_idx"
  ON "marketplace_applications" USING btree ("acceptance_tx_hash")
  WHERE "acceptance_tx_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_applications_submission_tx_idx"
  ON "marketplace_applications" USING btree ("submission_tx_hash")
  WHERE "submission_tx_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_applications_resolution_request_tx_idx"
  ON "marketplace_applications" USING btree ("resolution_request_tx_hash")
  WHERE "resolution_request_tx_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_applications_request_id_idx"
  ON "marketplace_applications" USING btree ("request_id")
  WHERE "request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_applications_genlayer_tx_idx"
  ON "marketplace_applications" USING btree ("genlayer_tx_hash")
  WHERE "genlayer_tx_hash" IS NOT NULL;--> statement-breakpoint

COMMENT ON TABLE "marketplace_campaigns" IS
  'InfluencedX campaign intents and receipt-verified Base Sepolia escrow bindings.';--> statement-breakpoint
COMMENT ON TABLE "marketplace_creator_profiles" IS
  'Public creator presentation plus Base registry commitments; contains no raw verification evidence.';--> statement-breakpoint
COMMENT ON TABLE "marketplace_creator_metrics_snapshots" IS
  'Sanitized GenLayer metric projections and evidence commitments; contains no fetched X payloads.';
