CREATE TYPE "public"."marketplace_campaign_relay_status" AS ENUM(
  'PENDING', 'CLAIMED', 'QUORUM_READY', 'SIMULATED', 'BROADCASTING',
  'CONFIRMED', 'RETRYABLE', 'RECONCILIATION_REQUIRED', 'FAILED'
);--> statement-breakpoint

CREATE TABLE "marketplace_campaign_resolution_relays" (
  "request_id" text PRIMARY KEY NOT NULL,
  "application_id" text NOT NULL,
  "resolution_round" integer NOT NULL,
  "assignment_id" text NOT NULL,
  "genlayer_tx_hash" text NOT NULL,
  "expected_outcome" "marketplace_resolution_outcome" NOT NULL,
  "evidence_hash" text,
  "resolved_at" bigint,
  "relay_deadline" bigint,
  "status" "marketplace_campaign_relay_status" DEFAULT 'PENDING' NOT NULL,
  "fence_token" text,
  "lease_expires_at" bigint,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "quorum_digest" text,
  "signer_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "base_tx_hash" text,
  "base_block_number" text,
  "error_code" text,
  "last_attempt_at" bigint,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  CONSTRAINT "marketplace_campaign_resolution_relays_application_id_fkey"
    FOREIGN KEY ("application_id") REFERENCES "public"."marketplace_applications"("id")
    ON DELETE restrict,
  CONSTRAINT "marketplace_campaign_resolution_relays_request_format"
    CHECK ("request_id" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT "marketplace_campaign_resolution_relays_assignment_format"
    CHECK ("assignment_id" ~ '^[1-9][0-9]*$'),
  CONSTRAINT "marketplace_campaign_resolution_relays_round_positive"
    CHECK ("resolution_round" > 0),
  CONSTRAINT "marketplace_campaign_resolution_relays_genlayer_tx_format"
    CHECK ("genlayer_tx_hash" ~ '^0x[0-9a-f]{64}$'),
  CONSTRAINT "marketplace_campaign_resolution_relays_optional_hash_formats"
    CHECK (
      ("evidence_hash" IS NULL OR "evidence_hash" ~ '^0x[0-9a-f]{64}$')
      AND ("quorum_digest" IS NULL OR "quorum_digest" ~ '^0x[0-9a-f]{64}$')
      AND ("base_tx_hash" IS NULL OR "base_tx_hash" ~ '^0x[0-9a-f]{64}$')
    ),
  CONSTRAINT "marketplace_campaign_resolution_relays_lease_pair"
    CHECK (("fence_token" IS NULL) = ("lease_expires_at" IS NULL)),
  CONSTRAINT "marketplace_campaign_resolution_relays_attempts_nonnegative"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "marketplace_campaign_resolution_relays_quorum_state"
    CHECK (
      "status" NOT IN ('QUORUM_READY', 'SIMULATED', 'BROADCASTING', 'CONFIRMED')
      OR (
        "quorum_digest" IS NOT NULL
        AND jsonb_typeof("signer_addresses") = 'array'
        AND jsonb_array_length("signer_addresses") >= 2
        AND "evidence_hash" IS NOT NULL
        AND "resolved_at" IS NOT NULL
        AND "relay_deadline" IS NOT NULL
      )
    ),
  CONSTRAINT "marketplace_campaign_resolution_relays_confirmed_tx"
    CHECK ("status" <> 'CONFIRMED' OR ("base_tx_hash" IS NOT NULL AND "base_block_number" IS NOT NULL))
);--> statement-breakpoint

CREATE UNIQUE INDEX "marketplace_campaign_resolution_relays_application_round_idx"
  ON "marketplace_campaign_resolution_relays" USING btree ("application_id", "resolution_round");--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_campaign_resolution_relays_base_tx_idx"
  ON "marketplace_campaign_resolution_relays" USING btree ("base_tx_hash")
  WHERE "base_tx_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "marketplace_campaign_resolution_relays_status_updated_idx"
  ON "marketplace_campaign_resolution_relays" USING btree ("status", "updated_at");--> statement-breakpoint

COMMENT ON TABLE "marketplace_campaign_resolution_relays" IS
  'Durable one-request/one-round fence for automatic 2-of-3 campaign settlement on Base Sepolia.';
