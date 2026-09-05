BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM influencedx_marketplace_operator_signer_gate
    WHERE holder_id IS NOT NULL
       OR active_operation_id IS NOT NULL
       OR phase IS NOT NULL
       OR lease_expires_at IS NOT NULL
       OR acquired_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Marketplace operator signer gate must be idle before the V3 cutover';
  END IF;
END $$;

UPDATE influencedx_marketplace_operator_status
SET status = 'RECONCILIATION_REQUIRED',
    error_code = COALESCE(error_code, 'MARKETPLACE_V3_CUTOVER'),
    updated_at = clock_timestamp()
WHERE contract_address = '0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb'
  AND status NOT IN (
    'FINALIZED', 'EXECUTION_FAILED', 'NETWORK_TERMINATED',
    'RECONCILIATION_REQUIRED', 'POLLING_EXHAUSTED', 'POISONED'
  );

ALTER TABLE influencedx_marketplace_operator_status
  DROP CONSTRAINT IF EXISTS influencedx_marketplace_operator_status_contract_address_check;
ALTER TABLE influencedx_marketplace_operator_status
  ADD CONSTRAINT influencedx_marketplace_operator_status_contract_address_check
  CHECK (contract_address IN (
    '0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb',
    '0x492175c248168ddb9571cbf4c6a14296e3348181'
  ));

COMMIT;
