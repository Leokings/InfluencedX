BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM influencedx_withdrawal_reconciliations
    WHERE contract_address = '0x58d598b8323e9c1d041989dcce80e737109de347'
  ) THEN
    RAISE EXCEPTION
      'Retired marketplace reconciliation rows require explicit manual archival before the identity-bundle cutover';
  END IF;
END $$;

ALTER TABLE influencedx_withdrawal_reconciliations
  DROP CONSTRAINT IF EXISTS influencedx_withdrawal_reconciliations_contract_address_check;
ALTER TABLE influencedx_withdrawal_reconciliations
  ADD CONSTRAINT influencedx_withdrawal_reconciliations_contract_address_check
  CHECK (contract_address = '0xeaceba807a7a4dc370f3b5a8e45539596b8551b4');

COMMIT;
