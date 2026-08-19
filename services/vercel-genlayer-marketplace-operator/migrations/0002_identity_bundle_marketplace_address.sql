BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM influencedx_marketplace_operator_status
    WHERE contract_address <> '0xeaceba807a7a4dc370f3b5a8e45539596b8551b4'
  ) THEN
    RAISE EXCEPTION
      'Marketplace operator rows for another deployment require explicit manual archival before the identity-bundle cutover';
  END IF;
END $$;

ALTER TABLE influencedx_marketplace_operator_status
  DROP CONSTRAINT IF EXISTS influencedx_marketplace_operator_status_contract_address_check;
ALTER TABLE influencedx_marketplace_operator_status
  ADD CONSTRAINT influencedx_marketplace_operator_status_contract_address_check
  CHECK (contract_address = '0xeaceba807a7a4dc370f3b5a8e45539596b8551b4');

COMMIT;
