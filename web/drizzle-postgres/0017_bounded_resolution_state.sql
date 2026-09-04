ALTER TABLE "marketplace_genlayer_assignments"
  DROP CONSTRAINT "marketplace_genlayer_assignments_status";--> statement-breakpoint
ALTER TABLE "marketplace_genlayer_assignments"
  ADD CONSTRAINT "marketplace_genlayer_assignments_status"
  CHECK ("status" IN ('SELECTED', 'ACCEPTED', 'SUBMITTED', 'RESOLVING', 'UNDETERMINED', 'SETTLED_PASS', 'SETTLED_FAIL', 'DECLINED', 'EXPIRED', 'REFUNDED'));
