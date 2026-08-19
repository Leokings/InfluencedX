BEGIN;

ALTER TABLE xproof_bradbury_submission_status
  DROP CONSTRAINT IF EXISTS xproof_bradbury_submission_status_network_check;
ALTER TABLE xproof_bradbury_submission_status
  DROP CONSTRAINT IF EXISTS xproof_bradbury_submission_status_resolver_check;
ALTER TABLE xproof_bradbury_submission_status
  DROP CONSTRAINT IF EXISTS xproof_bradbury_submission_status_network_resolver_check;

ALTER TABLE xproof_bradbury_submission_status
  ALTER COLUMN network SET DEFAULT 'studionet';
ALTER TABLE xproof_bradbury_submission_status
  ALTER COLUMN resolver SET DEFAULT '0x0913b5593ff16974e2fd616ca678a4986cb48600';

ALTER TABLE xproof_bradbury_submission_status
  ADD CONSTRAINT xproof_bradbury_submission_status_network_resolver_check CHECK (
    (
      network = 'testnet-bradbury'
      AND resolver = '0x017311b35dbb9802883bdae7fb0efd7bd77cb0b2'
    )
    OR
    (
      network = 'studionet'
      AND resolver = '0x0913b5593ff16974e2fd616ca678a4986cb48600'
    )
  );

COMMENT ON TABLE xproof_bradbury_submission_status IS
  'Safe InfluencedX GenLayer status projection. New rows use StudioNet; historical Bradbury rows remain readable by request_id.';

COMMIT;
