-- A durable browser-session fence for hash-bound identity activations.
-- Hosted reconciliation may continue, but a tab carrying a cookie that is in
-- the process of being cleared cannot start or replace verification evidence.
ALTER TABLE "verification_requests"
  ADD COLUMN IF NOT EXISTS "session_detached_at" bigint;
