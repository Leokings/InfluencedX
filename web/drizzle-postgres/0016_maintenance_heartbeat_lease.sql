-- Identifies the concrete queue message that won the current five-minute
-- maintenance slot. This lets a competing reseed acknowledge itself while a
-- duplicate delivery of the same leased message remains retryable.
ALTER TABLE "marketplace_genlayer_maintenance_generations"
  ADD COLUMN "heartbeat_message_id" text;

COMMENT ON COLUMN "marketplace_genlayer_maintenance_generations"."heartbeat_message_id" IS
  'Opaque Vercel Queue message ID that most recently claimed a maintenance slot; cleared on generation promotion.';
