BEGIN;

CREATE TABLE IF NOT EXISTS xproof_bradbury_submission_status (
  request_id text PRIMARY KEY CHECK (request_id ~ '^0x[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN (
    'QUEUED', 'PRECHECKING', 'PRECHECK_FAILED', 'BROADCASTING',
    'SUBMITTED', 'POLLING', 'FINALIZED', 'EXECUTION_FAILED',
    'NETWORK_TERMINATED', 'RECONCILIATION_REQUIRED',
    'POLLING_EXHAUSTED', 'POISONED'
  )),
  network text NOT NULL DEFAULT 'testnet-bradbury' CHECK (network = 'testnet-bradbury'),
  resolver text NOT NULL DEFAULT '0x017311b35dbb9802883bdae7fb0efd7bd77cb0b2'
    CHECK (resolver = '0x017311b35dbb9802883bdae7fb0efd7bd77cb0b2'),
  function_name text NOT NULL DEFAULT 'verify_ownership' CHECK (function_name = 'verify_ownership'),
  lifecycle_status text,
  execution_result text,
  result_outcome text CHECK (result_outcome IS NULL OR result_outcome IN ('VERIFIED', 'REJECTED', 'UNDETERMINED')),
  tx_hash text UNIQUE CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  queue_message_id text,
  enqueue_attempts integer NOT NULL DEFAULT 0 CHECK (enqueue_attempts >= 0),
  delivery_count integer NOT NULL DEFAULT 0 CHECK (delivery_count >= 0),
  poll_attempts integer NOT NULL DEFAULT 0 CHECK (poll_attempts >= 0),
  error_code text,
  broadcast_started_at timestamptz,
  submitted_at timestamptz,
  last_polled_at timestamptz,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS xproof_bradbury_submission_jobs (
  request_id text PRIMARY KEY REFERENCES xproof_bradbury_submission_status(request_id) ON DELETE RESTRICT,
  schema_version smallint NOT NULL CHECK (schema_version = 1),
  envelope_json jsonb,
  envelope_fingerprint text NOT NULL CHECK (envelope_fingerprint ~ '^0x[0-9a-f]{64}$'),
  call_fingerprint text NOT NULL CHECK (call_fingerprint ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (envelope_json IS NULL OR (
    jsonb_typeof(envelope_json) = 'object'
    AND envelope_json ?& ARRAY[
      'schemaVersion', 'requestId', 'baseWallet', 'expectedHandle',
      'postId', 'challenge', 'issuedAtEpoch', 'expiresAtEpoch',
      'credentialExpiresAtEpoch'
    ]
  ))
);

CREATE TABLE IF NOT EXISTS xproof_bradbury_signer_gate (
  gate_name text PRIMARY KEY CHECK (gate_name = 'bradbury-signer-v1'),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  holder_id uuid,
  active_request_id text REFERENCES xproof_bradbury_submission_status(request_id) ON DELETE RESTRICT,
  phase text CHECK (phase IS NULL OR phase IN ('PRECHECKING', 'BROADCASTING')),
  lease_expires_at timestamptz,
  acquired_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (holder_id IS NULL AND active_request_id IS NULL AND phase IS NULL AND lease_expires_at IS NULL AND acquired_at IS NULL)
    OR
    (holder_id IS NOT NULL AND active_request_id IS NOT NULL AND phase = 'PRECHECKING' AND lease_expires_at IS NOT NULL AND acquired_at IS NOT NULL)
    OR
    (holder_id IS NOT NULL AND active_request_id IS NOT NULL AND phase = 'BROADCASTING' AND lease_expires_at IS NULL AND acquired_at IS NOT NULL)
  )
);

INSERT INTO xproof_bradbury_signer_gate (gate_name)
VALUES ('bradbury-signer-v1')
ON CONFLICT (gate_name) DO NOTHING;

CREATE INDEX IF NOT EXISTS xproof_bradbury_status_updated_idx
  ON xproof_bradbury_submission_status (updated_at DESC);
CREATE INDEX IF NOT EXISTS xproof_bradbury_status_nonterminal_idx
  ON xproof_bradbury_submission_status (status, updated_at)
  WHERE status NOT IN (
    'FINALIZED', 'EXECUTION_FAILED', 'NETWORK_TERMINATED',
    'RECONCILIATION_REQUIRED', 'POLLING_EXHAUSTED', 'POISONED'
  );

COMMENT ON TABLE xproof_bradbury_submission_status IS
  'Safe XProof Bradbury status projection. The web application may read this table by request_id.';
COMMENT ON TABLE xproof_bradbury_submission_jobs IS
  'Private submitter work records. envelope_json is purged as soon as broadcast completes or a terminal quarantine is recorded.';
COMMENT ON TABLE xproof_bradbury_signer_gate IS
  'Account-wide fencing gate. BROADCASTING has no expiry and requires reconciliation after a crash.';

COMMIT;
