BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM influencedx_withdrawal_reconciliation_signer_gate
    WHERE holder_id IS NOT NULL
       OR active_withdrawal_id IS NOT NULL
       OR phase IS NOT NULL
       OR lease_expires_at IS NOT NULL
       OR acquired_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Withdrawal reconciler signer gate must be idle before the V3 cutover';
  END IF;
END $$;

UPDATE influencedx_withdrawal_reconciliations
SET status = 'RECONCILIATION_REQUIRED',
    error_code = COALESCE(error_code, 'MARKETPLACE_V3_CUTOVER'),
    updated_at = clock_timestamp()
WHERE contract_address = '0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb'
  AND status NOT IN ('FINALIZED', 'RECONCILIATION_REQUIRED', 'POLLING_EXHAUSTED', 'POISONED');

ALTER TABLE influencedx_withdrawal_reconciliations
  DROP CONSTRAINT IF EXISTS influencedx_withdrawal_reconciliations_contract_address_check;
ALTER TABLE influencedx_withdrawal_reconciliations
  ADD CONSTRAINT influencedx_withdrawal_reconciliations_contract_address_check
  CHECK (contract_address IN (
    '0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb',
    '0x492175c248168ddb9571cbf4c6a14296e3348181'
  ));

COMMIT;
