-- Deployment-generation fence for the GenLayer-native maintenance heartbeat.
--
-- This migration is additive and deliberately creates no active generation.
-- After it is applied, an authenticated call to the internal bootstrap route
-- must explicitly promote the deployment that is allowed to run maintenance.

CREATE TABLE "marketplace_genlayer_maintenance_generations" (
  "network" text NOT NULL,
  "chain_id" integer NOT NULL,
  "contract_address" text NOT NULL,
  "vercel_project_id" text NOT NULL,
  "vercel_environment" text NOT NULL,
  "active_deployment_id" text NOT NULL,
  "generation" bigint NOT NULL,
  "activated_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  CONSTRAINT "marketplace_genlayer_maintenance_generations_pk"
    PRIMARY KEY (
      "network", "chain_id", "contract_address",
      "vercel_project_id", "vercel_environment"
    ),
  CONSTRAINT "marketplace_genlayer_maintenance_generations_namespace"
    CHECK (
      "network" ~ '^[a-z][a-z0-9_-]{1,31}$'
      AND "chain_id" > 0
      AND "contract_address" ~ '^0x[0-9a-f]{40}$'
    ),
  CONSTRAINT "marketplace_genlayer_maintenance_generations_vercel"
    CHECK (
      "vercel_project_id" ~ '^prj_[A-Za-z0-9]{16,96}$'
      AND "vercel_environment" IN ('preview', 'production')
      AND "active_deployment_id" ~ '^dpl_[A-Za-z0-9]{16,96}$'
    ),
  CONSTRAINT "marketplace_genlayer_maintenance_generations_monotonic"
    CHECK (
      "generation" > 0
      AND "activated_at" > 0
      AND "updated_at" >= "activated_at"
    )
);--> statement-breakpoint

COMMENT ON TABLE "marketplace_genlayer_maintenance_generations" IS
  'Authoritative active Vercel deployment and monotonic generation for the GenLayer marketplace maintenance loop. Empty after migration until the authenticated bootstrap route promotes a deployment.';
