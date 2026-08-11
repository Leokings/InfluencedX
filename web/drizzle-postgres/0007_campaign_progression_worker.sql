ALTER TABLE "marketplace_applications"
  ADD COLUMN "progression_fence_token" text,
  ADD COLUMN "progression_lease_expires_at" bigint,
  ADD COLUMN "progression_next_attempt_at" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN "progression_attempt_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "progression_error_code" text,
  ADD COLUMN "progression_last_attempt_at" bigint;--> statement-breakpoint

CREATE INDEX "marketplace_applications_progression_due_idx"
  ON "marketplace_applications" USING btree (
    "progression_next_attempt_at",
    "updated_at"
  )
  WHERE "request_id" IS NOT NULL AND "resolution_tx_hash" IS NULL;--> statement-breakpoint

ALTER TABLE "marketplace_applications"
  ADD CONSTRAINT "marketplace_applications_progression_lease_pair"
    CHECK (("progression_fence_token" IS NULL) = ("progression_lease_expires_at" IS NULL)),
  ADD CONSTRAINT "marketplace_applications_progression_attempts_nonnegative"
    CHECK ("progression_attempt_count" >= 0),
  ADD CONSTRAINT "marketplace_applications_progression_error_code_format"
    CHECK (
      "progression_error_code" IS NULL
      OR "progression_error_code" ~ '^[A-Z0-9_]{1,64}$'
    );--> statement-breakpoint

COMMENT ON COLUMN "marketplace_applications"."progression_fence_token" IS
  'Opaque CAS token held only by one hosted campaign-progression invocation.';--> statement-breakpoint
COMMENT ON COLUMN "marketplace_applications"."progression_lease_expires_at" IS
  'Bounded lease expiry for GenLayer/finality/Base progression; no signer material is stored here.';
