CREATE TYPE "public"."base_relay_status" AS ENUM(
  'NOT_STARTED',
  'QUORUM_PENDING',
  'BROADCASTING',
  'CONFIRMED',
  'FAILED',
  'RECONCILIATION_REQUIRED'
);--> statement-breakpoint

ALTER TABLE "verification_requests"
  ADD COLUMN "base_relay_status" "base_relay_status" DEFAULT 'NOT_STARTED' NOT NULL,
  ADD COLUMN "base_relay_tx_hash" text,
  ADD COLUMN "base_relay_updated_at" bigint,
  ADD COLUMN "base_confirmed_at" bigint,
  ADD COLUMN "base_relay_error_code" text,
  ADD COLUMN "base_registry_address" text,
  ADD COLUMN "base_profile_id" text,
  ADD COLUMN "base_profile_identity_hash" text,
  ADD COLUMN "base_profile_handle_hash" text,
  ADD COLUMN "base_profile_verification_post_hash" text,
  ADD COLUMN "base_profile_expires_at" bigint,
  ADD COLUMN "base_profile_active" boolean,
  ADD COLUMN "base_profile_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint

ALTER TABLE "verification_requests"
  ADD CONSTRAINT "verification_requests_base_relay_tx_format"
    CHECK ("base_relay_tx_hash" IS NULL OR "base_relay_tx_hash" ~ '^0x[0-9a-f]{64}$'),
  ADD CONSTRAINT "verification_requests_base_registry_format"
    CHECK ("base_registry_address" IS NULL OR "base_registry_address" ~ '^0x[0-9a-fA-F]{40}$'),
  ADD CONSTRAINT "verification_requests_base_profile_id_format"
    CHECK ("base_profile_id" IS NULL OR "base_profile_id" ~ '^[1-9][0-9]*$'),
  ADD CONSTRAINT "verification_requests_base_profile_hashes"
    CHECK (
      ("base_profile_identity_hash" IS NULL OR "base_profile_identity_hash" ~ '^0x[0-9a-f]{64}$')
      AND ("base_profile_handle_hash" IS NULL OR "base_profile_handle_hash" ~ '^0x[0-9a-f]{64}$')
      AND ("base_profile_verification_post_hash" IS NULL OR "base_profile_verification_post_hash" ~ '^0x[0-9a-f]{64}$')
    ),
  ADD CONSTRAINT "verification_requests_base_confirmation_state"
    CHECK (
      "base_relay_status" <> 'CONFIRMED'
      OR (
        "base_relay_tx_hash" IS NOT NULL
        AND "base_confirmed_at" IS NOT NULL
        AND "base_registry_address" IS NOT NULL
        AND "base_profile_id" IS NOT NULL
        AND "base_profile_identity_hash" IS NOT NULL
        AND "base_profile_handle_hash" IS NOT NULL
        AND "base_profile_verification_post_hash" IS NOT NULL
        AND "base_profile_expires_at" IS NOT NULL
        AND "base_profile_active" IS TRUE
        AND "base_profile_verified" IS TRUE
      )
    );--> statement-breakpoint

CREATE INDEX "verification_requests_base_relay_status_idx"
  ON "verification_requests" USING btree ("base_relay_status", "base_relay_updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_requests_base_relay_tx_idx"
  ON "verification_requests" USING btree ("base_relay_tx_hash")
  WHERE "base_relay_tx_hash" IS NOT NULL;--> statement-breakpoint

CREATE TABLE "ownership_authorization_grants" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "request_id" text NOT NULL,
  "genlayer_tx_hash" text NOT NULL,
  "resolver_address" text NOT NULL,
  "base_receiver_address" text NOT NULL,
  "base_registry_address" text NOT NULL,
  "expected_wallet" text NOT NULL,
  "expires_at" bigint NOT NULL,
  "consumed_at" bigint,
  "consumer_key_fingerprint" text,
  "created_at" bigint NOT NULL,
  CONSTRAINT "ownership_authorization_grants_token_hash_format"
    CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ownership_authorization_grants_hash_formats"
    CHECK (
      "request_id" ~ '^0x[0-9a-f]{64}$'
      AND "genlayer_tx_hash" ~ '^0x[0-9a-f]{64}$'
    ),
  CONSTRAINT "ownership_authorization_grants_address_formats"
    CHECK (
      "resolver_address" ~ '^0x[0-9a-fA-F]{40}$'
      AND "base_receiver_address" ~ '^0x[0-9a-fA-F]{40}$'
      AND "base_registry_address" ~ '^0x[0-9a-fA-F]{40}$'
      AND "expected_wallet" ~ '^0x[0-9a-fA-F]{40}$'
    ),
  CONSTRAINT "ownership_authorization_grants_short_lived"
    CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + 900000),
  CONSTRAINT "ownership_authorization_grants_consumption_pair"
    CHECK (("consumed_at" IS NULL) = ("consumer_key_fingerprint" IS NULL)),
  CONSTRAINT "ownership_authorization_grants_consumer_key_format"
    CHECK (
      "consumer_key_fingerprint" IS NULL
      OR "consumer_key_fingerprint" ~ '^[0-9a-f]{64}$'
    )
);--> statement-breakpoint

CREATE INDEX "ownership_authorization_grants_expiry_idx"
  ON "ownership_authorization_grants" USING btree ("expires_at");--> statement-breakpoint

COMMENT ON TABLE "ownership_authorization_grants" IS
  'Single-use Preview grants. Stores only a token digest, public relay bindings, and the ephemeral RSA public-key fingerprint.';
