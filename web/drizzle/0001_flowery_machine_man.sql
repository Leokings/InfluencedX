DROP INDEX `verification_requests_one_active_wallet_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `verification_requests_one_active_owner_idx` ON `verification_requests` (`active_owner_user_id`);--> statement-breakpoint
CREATE INDEX `verification_requests_active_wallet_idx` ON `verification_requests` (`active_wallet`);