CREATE TYPE "public"."ownership_submission_status" AS ENUM('NOT_SUBMITTED', 'DISPATCHING', 'DISPATCH_UNKNOWN', 'QUEUED', 'PRECHECKING', 'PRECHECK_FAILED', 'BROADCASTING', 'SUBMITTED', 'POLLING', 'FINALIZED', 'EXECUTION_FAILED', 'NETWORK_TERMINATED', 'RECONCILIATION_REQUIRED', 'POLLING_EXHAUSTED', 'POISONED');--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN "sealed_evidence_ciphertext" text;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN "sealed_evidence_hash" text;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN "sealed_evidence_expires_at" bigint;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN "sealed_evidence_purged_at" bigint;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN "submission_status" "ownership_submission_status" DEFAULT 'NOT_SUBMITTED' NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN "submission_status_updated_at" bigint;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN "submission_attempts" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN "submission_last_attempt_at" bigint;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN "submission_response_updated_at" bigint;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN "genlayer_tx_hash" text;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN "genlayer_outcome" text;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN "genlayer_error_code" text;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN "genlayer_submitted_at" bigint;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN "genlayer_last_polled_at" bigint;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD COLUMN "genlayer_finalized_at" bigint;--> statement-breakpoint
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_submission_attempts_nonnegative" CHECK ("verification_requests"."submission_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_submission_outcome" CHECK ("verification_requests"."genlayer_outcome" is null or "verification_requests"."genlayer_outcome" in ('VERIFIED', 'REJECTED', 'UNDETERMINED'));--> statement-breakpoint
ALTER TABLE "verification_requests" ADD CONSTRAINT "verification_requests_sealed_evidence_pair" CHECK (("verification_requests"."sealed_evidence_ciphertext" is null) = ("verification_requests"."sealed_evidence_hash" is null));
