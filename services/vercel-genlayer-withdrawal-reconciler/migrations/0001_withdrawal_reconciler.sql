BEGIN;

CREATE TABLE IF NOT EXISTS influencedx_withdrawal_reconciliations (
  withdrawal_id text PRIMARY KEY CHECK (withdrawal_id ~ '^0x[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN (
    'QUEUED', 'WAITING_FOR_EMISSION', 'WAITING_FOR_TRANSFER', 'PROOF_VERIFIED',
    'BROADCASTING', 'SUBMITTED', 'POLLING', 'FINALIZED',
    'RECONCILIATION_REQUIRED', 'POLLING_EXHAUSTED', 'POISONED'
  )),
  network text NOT NULL CHECK (network = 'studionet'),
  chain_id integer NOT NULL CHECK (chain_id = 61999),
  contract_address text NOT NULL CHECK (contract_address = '0x17eb37a3578e21662f4d654b245238df520663fa'),
  contract_owner text NOT NULL CHECK (contract_owner = '0x797d3b25fb2cca0ff93f60df1910267f3822d655'),
  function_name text NOT NULL CHECK (function_name = 'confirm_withdrawal'),
  value_atto text NOT NULL CHECK (value_atto = '0'),
  evidence_hash text CHECK (evidence_hash IS NULL OR evidence_hash ~ '^0x[0-9a-f]{64}$'),
  transfer_parent_tx_hash text CHECK (transfer_parent_tx_hash IS NULL OR transfer_parent_tx_hash ~ '^0x[0-9a-f]{64}$'),
  transfer_child_tx_hash text CHECK (transfer_child_tx_hash IS NULL OR transfer_child_tx_hash ~ '^0x[0-9a-f]{64}$'),
  confirmation_tx_hash text UNIQUE CHECK (confirmation_tx_hash IS NULL OR confirmation_tx_hash ~ '^0x[0-9a-f]{64}$'),
  lifecycle_status text,
  execution_result text,
  queue_message_id text,
  enqueue_attempts integer NOT NULL DEFAULT 0 CHECK (enqueue_attempts >= 0),
  delivery_count integer NOT NULL DEFAULT 0 CHECK (delivery_count >= 0),
  discovery_attempts integer NOT NULL DEFAULT 0 CHECK (discovery_attempts >= 0),
  poll_attempts integer NOT NULL DEFAULT 0 CHECK (poll_attempts >= 0),
  error_code text,
  broadcast_started_at timestamptz,
  submitted_at timestamptz,
  last_checked_at timestamptz,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (evidence_hash IS NULL AND transfer_parent_tx_hash IS NULL AND transfer_child_tx_hash IS NULL)
    OR
    (evidence_hash IS NOT NULL AND transfer_parent_tx_hash IS NOT NULL AND transfer_child_tx_hash IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS influencedx_withdrawal_reconciliation_jobs (
  withdrawal_id text PRIMARY KEY REFERENCES influencedx_withdrawal_reconciliations(withdrawal_id) ON DELETE RESTRICT,
  schema_version smallint NOT NULL CHECK (schema_version = 1),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^0x[0-9a-f]{64}$'),
  withdrawal_json jsonb,
  counts_before_json jsonb,
  proof_json jsonb,
  proof_fingerprint text CHECK (proof_fingerprint IS NULL OR proof_fingerprint ~ '^0x[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (withdrawal_json IS NULL OR jsonb_typeof(withdrawal_json) = 'object'),
  CHECK (counts_before_json IS NULL OR jsonb_typeof(counts_before_json) = 'object'),
  CHECK (proof_json IS NULL OR jsonb_typeof(proof_json) = 'object'),
  CHECK ((proof_json IS NULL AND proof_fingerprint IS NULL) OR (proof_json IS NOT NULL AND proof_fingerprint IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS influencedx_withdrawal_reconciliation_signer_gate (
  gate_name text PRIMARY KEY CHECK (gate_name = 'influencedx-withdrawal-owner-signer-v1'),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  holder_id uuid,
  active_withdrawal_id text REFERENCES influencedx_withdrawal_reconciliations(withdrawal_id) ON DELETE RESTRICT,
  phase text CHECK (phase IS NULL OR phase IN ('PRECHECKING', 'BROADCASTING')),
  lease_expires_at timestamptz,
  acquired_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (holder_id IS NULL AND active_withdrawal_id IS NULL AND phase IS NULL AND lease_expires_at IS NULL AND acquired_at IS NULL)
    OR
    (holder_id IS NOT NULL AND active_withdrawal_id IS NOT NULL AND phase = 'PRECHECKING' AND lease_expires_at IS NOT NULL AND acquired_at IS NOT NULL)
    OR
    (holder_id IS NOT NULL AND active_withdrawal_id IS NOT NULL AND phase = 'BROADCASTING' AND lease_expires_at IS NULL AND acquired_at IS NOT NULL)
  )
);

INSERT INTO influencedx_withdrawal_reconciliation_signer_gate (gate_name)
VALUES ('influencedx-withdrawal-owner-signer-v1')
ON CONFLICT (gate_name) DO NOTHING;

CREATE INDEX IF NOT EXISTS influencedx_withdrawal_reconciliations_status_idx
  ON influencedx_withdrawal_reconciliations (status, updated_at)
  WHERE status NOT IN ('FINALIZED', 'RECONCILIATION_REQUIRED', 'POLLING_EXHAUSTED', 'POISONED');

COMMENT ON TABLE influencedx_withdrawal_reconciliations IS
  'Public-safe status for finalized StudioNet native-withdrawal delivery reconciliation.';
COMMENT ON TABLE influencedx_withdrawal_reconciliation_jobs IS
  'Private finalized state and exact parent-child transfer proof. Ingress supplies only withdrawal_id.';
COMMENT ON TABLE influencedx_withdrawal_reconciliation_signer_gate IS
  'Singleton owner signer fence. BROADCASTING never expires; ambiguous outcomes require manual governance.';

COMMIT;
