CREATE TYPE "public"."intent_signature_status" AS ENUM('NOT_PREPARED', 'AWAITING_SIGNATURE', 'VERIFIED');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('WALLET_CHALLENGE_PENDING', 'WALLET_AUTHORIZED', 'X_CHALLENGE_ISSUED', 'INTENT_PREPARED', 'READY_FOR_GENLAYER', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "verification_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"active_owner_user_id" text,
	"active_wallet" text,
	"status" "verification_status" DEFAULT 'WALLET_CHALLENGE_PENDING' NOT NULL,
	"status_updated_at" bigint NOT NULL,
	"request_expires_at" bigint NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"wallet" text NOT NULL,
	"wallet_nonce" text,
	"wallet_nonce_hash" text NOT NULL,
	"wallet_message" text,
	"wallet_message_hash" text NOT NULL,
	"wallet_challenge_expires_at" bigint NOT NULL,
	"wallet_signature_hash" text,
	"wallet_authorized_at" bigint,
	"handle" text,
	"x_challenge" text,
	"tweet_text" text,
	"tweet_text_hash" text,
	"x_challenge_issued_at" bigint,
	"x_challenge_expires_at" bigint,
	"credential_expires_at" bigint,
	"normalized_verification_post_url" text,
	"verification_post_id" text,
	"verification_post_created_at" bigint,
	"finalized_request_id" text,
	"handle_hash" text,
	"verification_post_hash" text,
	"challenge_hash" text,
	"receiver_contract" text,
	"genlayer_contract" text,
	"intent_typed_data_json" text,
	"intent_signature_hash" text,
	"intent_signature_status" "intent_signature_status" DEFAULT 'NOT_PREPARED' NOT NULL,
	"intent_prepared_at" bigint,
	"ready_for_genlayer_at" bigint,
	"purged_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "verification_requests_revision_nonnegative" CHECK ("verification_requests"."revision" >= 0),
	CONSTRAINT "verification_requests_active_pair" CHECK (("verification_requests"."active_owner_user_id" is null) = ("verification_requests"."active_wallet" is null)),
	CONSTRAINT "verification_requests_active_owner_matches" CHECK ("verification_requests"."active_owner_user_id" is null or "verification_requests"."active_owner_user_id" = "verification_requests"."owner_user_id"),
	CONSTRAINT "verification_requests_active_wallet_matches" CHECK ("verification_requests"."active_wallet" is null or "verification_requests"."active_wallet" = "verification_requests"."wallet"),
	CONSTRAINT "verification_requests_expiry_state" CHECK (("verification_requests"."status" = 'EXPIRED' and "verification_requests"."active_owner_user_id" is null) or ("verification_requests"."status" <> 'EXPIRED' and "verification_requests"."active_owner_user_id" is not null)),
	CONSTRAINT "verification_requests_intent_state" CHECK ("verification_requests"."status" = 'EXPIRED' or ("verification_requests"."status" in ('WALLET_CHALLENGE_PENDING', 'WALLET_AUTHORIZED', 'X_CHALLENGE_ISSUED') and "verification_requests"."intent_signature_status" = 'NOT_PREPARED') or ("verification_requests"."status" = 'INTENT_PREPARED' and "verification_requests"."intent_signature_status" = 'AWAITING_SIGNATURE') or ("verification_requests"."status" = 'READY_FOR_GENLAYER' and "verification_requests"."intent_signature_status" = 'VERIFIED'))
);
--> statement-breakpoint
CREATE INDEX "verification_requests_owner_created_idx" ON "verification_requests" USING btree ("owner_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "verification_requests_owner_status_idx" ON "verification_requests" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "verification_requests_owner_active_expiry_idx" ON "verification_requests" USING btree ("owner_user_id","request_expires_at") WHERE "verification_requests"."status" <> 'EXPIRED';--> statement-breakpoint
CREATE UNIQUE INDEX "verification_requests_finalized_request_idx" ON "verification_requests" USING btree ("finalized_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_requests_one_active_owner_idx" ON "verification_requests" USING btree ("active_owner_user_id");--> statement-breakpoint
CREATE INDEX "verification_requests_active_wallet_idx" ON "verification_requests" USING btree ("active_wallet");