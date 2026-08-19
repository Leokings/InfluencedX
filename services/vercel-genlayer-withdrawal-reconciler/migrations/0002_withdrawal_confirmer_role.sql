BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'influencedx_withdrawal_reconciliations'
      AND column_name = 'contract_owner'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'influencedx_withdrawal_reconciliations'
      AND column_name = 'withdrawal_confirmer'
  ) THEN
    ALTER TABLE influencedx_withdrawal_reconciliations
      RENAME COLUMN contract_owner TO withdrawal_confirmer;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM influencedx_withdrawal_reconciliations
    WHERE withdrawal_confirmer <> '0xaafc5d9075a404d82b8ee1692f7ff802168c5dd8'
  ) THEN
    RAISE EXCEPTION
      'Legacy owner-authorized reconciliation rows require a fresh database or explicit manual archival';
  END IF;
END $$;

ALTER TABLE influencedx_withdrawal_reconciliations
  DROP CONSTRAINT IF EXISTS influencedx_withdrawal_reconciliations_contract_owner_check;
ALTER TABLE influencedx_withdrawal_reconciliations
  DROP CONSTRAINT IF EXISTS influencedx_withdrawal_reconciliations_withdrawal_confirmer_check;
ALTER TABLE influencedx_withdrawal_reconciliations
  ADD CONSTRAINT influencedx_withdrawal_reconciliations_withdrawal_confirmer_check
  CHECK (
    withdrawal_confirmer = '0xaafc5d9075a404d82b8ee1692f7ff802168c5dd8'
  );

ALTER TABLE influencedx_withdrawal_reconciliation_signer_gate
  DROP CONSTRAINT IF EXISTS influencedx_withdrawal_reconciliation_signer_ga_gate_name_check;
ALTER TABLE influencedx_withdrawal_reconciliation_signer_gate
  DROP CONSTRAINT IF EXISTS influencedx_withdrawal_reconciliation_signer_gate_gate_name_check;
DELETE FROM influencedx_withdrawal_reconciliation_signer_gate AS legacy
WHERE legacy.gate_name = 'influencedx-withdrawal-owner-signer-v1'
  AND EXISTS (
    SELECT 1
    FROM influencedx_withdrawal_reconciliation_signer_gate AS current_gate
    WHERE current_gate.gate_name = 'influencedx-withdrawal-confirmer-signer-v1'
  );
UPDATE influencedx_withdrawal_reconciliation_signer_gate
SET gate_name = 'influencedx-withdrawal-confirmer-signer-v1',
    updated_at = clock_timestamp()
WHERE gate_name = 'influencedx-withdrawal-owner-signer-v1';
ALTER TABLE influencedx_withdrawal_reconciliation_signer_gate
  ADD CONSTRAINT influencedx_withdrawal_reconciliation_signer_gate_gate_name_check
  CHECK (gate_name = 'influencedx-withdrawal-confirmer-signer-v1');
INSERT INTO influencedx_withdrawal_reconciliation_signer_gate (gate_name)
VALUES ('influencedx-withdrawal-confirmer-signer-v1')
ON CONFLICT (gate_name) DO NOTHING;

COMMENT ON TABLE influencedx_withdrawal_reconciliation_signer_gate IS
  'Singleton withdrawal confirmer signer fence. BROADCASTING never expires; ambiguous outcomes require manual governance.';

COMMIT;
