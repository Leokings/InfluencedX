BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM influencedx_withdrawal_reconciliations
    WHERE contract_address <> '0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb'
  ) THEN
    RAISE EXCEPTION
      'Withdrawal reconciliation rows for the retired deployment require explicit manual archival before the fresh StudioNet cutover';
  END IF;
END $$;

ALTER TABLE influencedx_withdrawal_reconciliations
  DROP CONSTRAINT IF EXISTS influencedx_withdrawal_reconciliations_contract_address_check;
ALTER TABLE influencedx_withdrawal_reconciliations
  ADD CONSTRAINT influencedx_withdrawal_reconciliations_contract_address_check
  CHECK (contract_address = '0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb');

COMMIT;
