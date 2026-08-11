ALTER TABLE x_verification_challenges
  ALTER COLUMN identity_commitment DROP NOT NULL,
  ADD COLUMN protocol_version smallint,
  ADD COLUMN x_post_id text,
  ADD COLUMN credential_expires_at timestamptz;

UPDATE x_verification_challenges
SET protocol_version = 1
WHERE protocol_version IS NULL;

ALTER TABLE x_verification_challenges
  ALTER COLUMN protocol_version SET NOT NULL,
  ALTER COLUMN protocol_version SET DEFAULT 2,
  ADD CONSTRAINT x_verification_challenges_protocol_version_check
    CHECK (protocol_version IN (1, 2)),
  ADD CONSTRAINT x_verification_challenges_v2_post_id_check
    CHECK (protocol_version <> 2 OR x_post_id IS NULL OR x_post_id ~ '^[0-9]{5,25}$'),
  ADD CONSTRAINT x_verification_challenges_v2_finalization_check
    CHECK (
      protocol_version <> 2
      OR (x_post_id IS NULL AND genlayer_request_id IS NULL)
      OR (x_post_id IS NOT NULL AND genlayer_request_id IS NOT NULL)
    ),
  ADD CONSTRAINT x_verification_challenges_v2_window_check
    CHECK (
      protocol_version <> 2
      OR (
        expires_at >= issued_at + interval '5 minutes'
        AND expires_at <= issued_at + interval '60 minutes'
      )
    ),
  ADD CONSTRAINT x_verification_challenges_v2_credential_expiry_check
    CHECK (
      protocol_version <> 2
      OR (
        credential_expires_at IS NOT NULL
        AND credential_expires_at >= issued_at + interval '1 day'
        AND credential_expires_at <= issued_at + interval '90 days'
      )
    );

CREATE UNIQUE INDEX x_verification_challenges_v2_post_id_uidx
  ON x_verification_challenges (x_post_id)
  WHERE protocol_version = 2 AND x_post_id IS NOT NULL;

COMMENT ON COLUMN x_verification_challenges.protocol_version IS
  'Ownership protocol version. New challenges use APV2.';

COMMENT ON COLUMN x_verification_challenges.identity_commitment IS
  'Nullable until GenLayer validators derive the immutable X user ID during APV2 consensus.';

COMMENT ON COLUMN x_verification_challenges.genlayer_request_id IS
  'For APV2, SHA-256 of xproof-x-ownership-v2|wallet|handle|postId|challenge|issued|expires|credentialExpiry.';
