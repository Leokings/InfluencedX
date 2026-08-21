-- Only the request that inserts a prepared marketplace intent may receive a
-- broadcastable call. Existing audit rows remain immutable and nullable;
-- every new intent is atomically fenced by its exact deterministic key.
ALTER TABLE "marketplace_genlayer_transactions"
  ADD COLUMN IF NOT EXISTS "intent_key" text;

CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_genlayer_transactions_intent_idx"
  ON "marketplace_genlayer_transactions" (
    "network",
    "chain_id",
    "contract_address",
    "intent_key"
  )
  WHERE "intent_key" IS NOT NULL
    AND "status" IN (
      'PREPARED',
      'SUBMITTED',
      'ACCEPTED',
      'FINALIZED',
      'RECONCILIATION_REQUIRED'
    );
