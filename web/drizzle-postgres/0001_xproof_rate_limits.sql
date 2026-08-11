CREATE TABLE "verification_rate_limits" (
	"policy_key" text NOT NULL,
	"bucket_hash" text NOT NULL,
	"window_started_at" bigint NOT NULL,
	"window_expires_at" bigint NOT NULL,
	"request_count" integer NOT NULL,
	"request_limit" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "verification_rate_limits_policy_bucket_pk" PRIMARY KEY("policy_key","bucket_hash"),
	CONSTRAINT "verification_rate_limits_bucket_hash_format" CHECK ("verification_rate_limits"."bucket_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "verification_rate_limits_window_order" CHECK ("verification_rate_limits"."window_started_at" >= 0 and "verification_rate_limits"."window_expires_at" > "verification_rate_limits"."window_started_at"),
	CONSTRAINT "verification_rate_limits_positive_counts" CHECK ("verification_rate_limits"."request_count" > 0 and "verification_rate_limits"."request_limit" > 0 and "verification_rate_limits"."request_count" <= "verification_rate_limits"."request_limit")
);
--> statement-breakpoint
CREATE INDEX "verification_rate_limits_expiry_idx" ON "verification_rate_limits" USING btree ("window_expires_at");