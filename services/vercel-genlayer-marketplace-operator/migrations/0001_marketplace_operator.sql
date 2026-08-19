BEGIN;

CREATE TABLE IF NOT EXISTS influencedx_marketplace_operator_status (
  operation_id text PRIMARY KEY CHECK (operation_id ~ '^0x[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN (
    'QUEUED', 'PRECHECKING', 'PRECHECK_FAILED', 'BROADCASTING',
    'SUBMITTED', 'POLLING', 'FINALIZED', 'EXECUTION_FAILED',
    'NETWORK_TERMINATED', 'RECONCILIATION_REQUIRED',
    'POLLING_EXHAUSTED', 'POISONED'
  )),
  network text NOT NULL CHECK (network = 'studionet'),
  chain_id integer NOT NULL CHECK (chain_id = 61999),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$' AND contract_address <> '0x0000000000000000000000000000000000000000'),
  action text NOT NULL CHECK (action IN ('resolve_assignment', 'expire_assignment', 'finalize_campaign')),
  function_name text NOT NULL CHECK (function_name IN ('resolve_assignment', 'expire_assignment', 'finalize_campaign')),
  value_atto text NOT NULL CHECK (value_atto = '0'),
  lifecycle_status text,
  execution_result text,
  tx_hash text UNIQUE CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  queue_message_id text,
  enqueue_attempts integer NOT NULL DEFAULT 0 CHECK (enqueue_attempts >= 0),
  delivery_count integer NOT NULL DEFAULT 0 CHECK (delivery_count >= 0),
  poll_attempts integer NOT NULL DEFAULT 0 CHECK (poll_attempts >= 0),
  error_code text,
  pre_state_fingerprint text CHECK (pre_state_fingerprint IS NULL OR pre_state_fingerprint ~ '^0x[0-9a-f]{64}$'),
  post_state_fingerprint text CHECK (post_state_fingerprint IS NULL OR post_state_fingerprint ~ '^0x[0-9a-f]{64}$'),
  broadcast_started_at timestamptz,
  submitted_at timestamptz,
  last_polled_at timestamptz,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (action = function_name)
);

CREATE TABLE IF NOT EXISTS influencedx_marketplace_operator_jobs (
  operation_id text PRIMARY KEY REFERENCES influencedx_marketplace_operator_status(operation_id) ON DELETE RESTRICT,
  schema_version smallint NOT NULL CHECK (schema_version = 1),
  envelope_json jsonb NOT NULL,
  envelope_fingerprint text NOT NULL CHECK (envelope_fingerprint ~ '^0x[0-9a-f]{64}$'),
  call_fingerprint text NOT NULL CHECK (call_fingerprint ~ '^0x[0-9a-f]{64}$'),
  pre_state_json jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    jsonb_typeof(envelope_json) = 'object'
    AND envelope_json ?& ARRAY[
      'schemaVersion', 'operationId', 'network', 'chainId',
      'contractAddress', 'action', 'args', 'valueAtto'
    ]
  ),
  CHECK (pre_state_json IS NULL OR jsonb_typeof(pre_state_json) = 'object')
);

CREATE TABLE IF NOT EXISTS influencedx_marketplace_operator_signer_gate (
  gate_name text PRIMARY KEY CHECK (gate_name = 'influencedx-marketplace-operator-signer-v1'),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  holder_id uuid,
  active_operation_id text REFERENCES influencedx_marketplace_operator_status(operation_id) ON DELETE RESTRICT,
  phase text CHECK (phase IS NULL OR phase IN ('PRECHECKING', 'BROADCASTING')),
  lease_expires_at timestamptz,
  acquired_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (holder_id IS NULL AND active_operation_id IS NULL AND phase IS NULL AND lease_expires_at IS NULL AND acquired_at IS NULL)
    OR
    (holder_id IS NOT NULL AND active_operation_id IS NOT NULL AND phase = 'PRECHECKING' AND lease_expires_at IS NOT NULL AND acquired_at IS NOT NULL)
    OR
    (holder_id IS NOT NULL AND active_operation_id IS NOT NULL AND phase = 'BROADCASTING' AND lease_expires_at IS NULL AND acquired_at IS NOT NULL)
  )
);

INSERT INTO influencedx_marketplace_operator_signer_gate (gate_name)
VALUES ('influencedx-marketplace-operator-signer-v1')
ON CONFLICT (gate_name) DO NOTHING;

CREATE INDEX IF NOT EXISTS influencedx_marketplace_operator_status_updated_idx
  ON influencedx_marketplace_operator_status (updated_at DESC);
CREATE INDEX IF NOT EXISTS influencedx_marketplace_operator_status_active_idx
  ON influencedx_marketplace_operator_status (status, updated_at)
  WHERE status NOT IN (
    'FINALIZED', 'EXECUTION_FAILED', 'NETWORK_TERMINATED',
    'RECONCILIATION_REQUIRED', 'POLLING_EXHAUSTED', 'POISONED'
  );

COMMENT ON TABLE influencedx_marketplace_operator_status IS
  'Public-safe status for the isolated, zero-value GenLayer marketplace operator.';
COMMENT ON TABLE influencedx_marketplace_operator_jobs IS
  'Private exact call envelopes and finality snapshots. No arbitrary target, method, args, or value is accepted.';
COMMENT ON TABLE influencedx_marketplace_operator_signer_gate IS
  'Singleton fenced signer gate. BROADCASTING never expires; ambiguous broadcasts require manual reconciliation.';

COMMIT;
