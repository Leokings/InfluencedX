BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM influencedx_marketplace_operator_status
    WHERE contract_address <> '0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb'
  ) THEN
    RAISE EXCEPTION
      'Marketplace operator rows for the retired deployment require explicit manual archival before the fresh StudioNet cutover';
  END IF;
END $$;

ALTER TABLE influencedx_marketplace_operator_status
  DROP CONSTRAINT IF EXISTS influencedx_marketplace_operator_status_contract_address_check;
ALTER TABLE influencedx_marketplace_operator_status
  ADD CONSTRAINT influencedx_marketplace_operator_status_contract_address_check
  CHECK (contract_address = '0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb');

COMMIT;
