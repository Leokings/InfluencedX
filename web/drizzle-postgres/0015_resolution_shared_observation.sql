CREATE SEQUENCE "marketplace_genlayer_shared_observation_ticket_seq"
  AS bigint START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;--> statement-breakpoint

ALTER TABLE "marketplace_genlayer_campaigns"
  DROP CONSTRAINT "marketplace_genlayer_campaigns_money";--> statement-breakpoint

ALTER TABLE "marketplace_genlayer_campaigns"
  ADD CONSTRAINT "marketplace_genlayer_campaigns_money"
  CHECK (
    "budget_atto" > 0
    AND "available_atto" >= 0
    AND "reserved_atto" >= 0
    AND "settled_atto" >= 0
    AND "creator_paid_atto" >= 0
    AND "brand_refunded_atto" >= 0
    AND "fee_atto" >= 0
    AND "available_atto" + "reserved_atto" + "creator_paid_atto" + "brand_refunded_atto" + "fee_atto" = "budget_atto"
    AND "creator_paid_atto" + "fee_atto" <= "settled_atto"
    AND "settled_atto" <= "creator_paid_atto" + "fee_atto" + "brand_refunded_atto"
  );--> statement-breakpoint

ALTER TABLE "marketplace_genlayer_campaigns"
  ADD CONSTRAINT "marketplace_genlayer_campaigns_terminal_balances"
  CHECK (
    "status" = 'OPEN'
    OR ("available_atto" = 0 AND "reserved_atto" = 0)
  );--> statement-breakpoint

ALTER TABLE "marketplace_genlayer_assignments"
  ADD COLUMN "shared_projection_pending" boolean DEFAULT false NOT NULL,
  ADD COLUMN "shared_projection_anchor_tx_hash" text,
  ADD COLUMN "shared_projection_observation_ticket" bigint,
  ADD COLUMN "shared_projection_attempts" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "shared_projection_next_repair_at" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint

-- Rollout precondition: the target deployment has no legacy resolve_assignment
-- terminal rows. verify-database fails closed if one lacks an exact receipt anchor;
-- this migration intentionally does not guess or backfill transaction provenance.

ALTER TABLE "marketplace_genlayer_campaigns"
  ADD COLUMN "observed_after_tx_hash" text,
  ADD COLUMN "observed_after_finalized_at" bigint,
  ADD COLUMN "observation_ticket" bigint,
  ADD COLUMN "observation_revision" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN "observed_at" bigint;--> statement-breakpoint

ALTER TABLE "marketplace_genlayer_claimable_balances"
  ADD COLUMN "observed_after_tx_hash" text,
  ADD COLUMN "observed_after_finalized_at" bigint,
  ADD COLUMN "observation_ticket" bigint,
  ADD COLUMN "observation_revision" bigint DEFAULT 0 NOT NULL,
  ADD COLUMN "observed_at" bigint;--> statement-breakpoint

ALTER TABLE "marketplace_genlayer_assignments"
  ADD CONSTRAINT "marketplace_genlayer_assignments_shared_pending"
  CHECK (
    ("shared_projection_anchor_tx_hash" IS NULL OR "shared_projection_anchor_tx_hash" ~ '^0x[0-9a-f]{64}$')
    AND (
      NOT "shared_projection_pending"
      OR (
        "shared_projection_anchor_tx_hash" = "last_tx_hash"
        AND "status" IN ('SETTLED_PASS', 'SETTLED_FAIL')
      )
    )
  );--> statement-breakpoint

ALTER TABLE "marketplace_genlayer_assignments"
  ADD CONSTRAINT "marketplace_genlayer_assignments_shared_schedule"
  CHECK (
    "shared_projection_attempts" >= 0
    AND "shared_projection_next_repair_at" >= 0
    AND ("shared_projection_observation_ticket" IS NULL OR "shared_projection_observation_ticket" > 0)
  );--> statement-breakpoint

ALTER TABLE "marketplace_genlayer_campaigns"
  ADD CONSTRAINT "marketplace_genlayer_campaigns_observation_tuple"
  CHECK (
    ("observation_revision" = 0 AND "observed_after_tx_hash" IS NULL AND "observed_after_finalized_at" IS NULL AND "observation_ticket" IS NULL AND "observed_at" IS NULL)
    OR
    ("observation_revision" > 0 AND "observed_after_tx_hash" IS NOT NULL AND "observed_after_finalized_at" IS NOT NULL AND "observation_ticket" > 0 AND "observed_at" IS NOT NULL AND "observed_at" >= "observed_after_finalized_at")
  );--> statement-breakpoint

ALTER TABLE "marketplace_genlayer_claimable_balances"
  ADD CONSTRAINT "marketplace_genlayer_claimable_observation_tuple"
  CHECK (
    ("observation_revision" = 0 AND "observed_after_tx_hash" IS NULL AND "observed_after_finalized_at" IS NULL AND "observation_ticket" IS NULL AND "observed_at" IS NULL)
    OR
    ("observation_revision" > 0 AND "observed_after_tx_hash" IS NOT NULL AND "observed_after_finalized_at" IS NOT NULL AND "observation_ticket" > 0 AND "observed_at" IS NOT NULL AND "observed_at" >= "observed_after_finalized_at")
  );--> statement-breakpoint

ALTER TABLE "marketplace_genlayer_campaigns"
  ADD CONSTRAINT "marketplace_genlayer_campaigns_observation_hash"
  CHECK (
    "observed_after_tx_hash" IS NULL
    OR "observed_after_tx_hash" ~ '^0x[0-9a-f]{64}$'
  );--> statement-breakpoint

ALTER TABLE "marketplace_genlayer_claimable_balances"
  ADD CONSTRAINT "marketplace_genlayer_claimable_observation_hash"
  CHECK (
    "observed_after_tx_hash" IS NULL
    OR "observed_after_tx_hash" ~ '^0x[0-9a-f]{64}$'
  );--> statement-breakpoint

CREATE INDEX "marketplace_genlayer_assignments_shared_pending_idx"
  ON "marketplace_genlayer_assignments"
  ("network", "chain_id", "contract_address", "shared_projection_next_repair_at", "projected_at", "projection_id")
  WHERE "shared_projection_pending" = true;--> statement-breakpoint

COMMENT ON COLUMN "marketplace_genlayer_campaigns"."observed_after_tx_hash"
  IS 'Verified finalized receipt known to precede this LATEST_FINAL observation; not single-transaction causality.';--> statement-breakpoint
COMMENT ON COLUMN "marketplace_genlayer_claimable_balances"."observed_after_tx_hash"
  IS 'Verified finalized receipt known to precede this wallet-global LATEST_FINAL observation; not single-transaction causality.';
