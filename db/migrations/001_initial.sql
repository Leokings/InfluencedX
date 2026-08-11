CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_wallet bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE creator_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  display_name text NOT NULL,
  bio text,
  base_profile_id numeric(78, 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE x_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_profile_id uuid NOT NULL UNIQUE REFERENCES creator_profiles(id),
  x_user_id text NOT NULL UNIQUE,
  current_handle text NOT NULL,
  identity_commitment bytea NOT NULL UNIQUE,
  consented_at timestamptz NOT NULL,
  verified_at timestamptz,
  verification_expires_at timestamptz,
  source_status text NOT NULL DEFAULT 'active',
  deletion_requested_at timestamptz,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE x_verification_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_profile_id uuid NOT NULL REFERENCES creator_profiles(id),
  wallet bytea NOT NULL,
  expected_handle text NOT NULL,
  identity_commitment bytea NOT NULL,
  challenge_digest bytea NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  genlayer_request_id bytea UNIQUE,
  CHECK (expires_at > issued_at)
);

CREATE TABLE creator_metric_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  x_account_id uuid NOT NULL REFERENCES x_accounts(id),
  methodology_version integer NOT NULL,
  followers bigint,
  following bigint,
  account_created_at timestamptz,
  posts_analyzed integer NOT NULL DEFAULT 0,
  median_likes bigint,
  median_replies bigint,
  median_reposts bigint,
  median_views bigint,
  engagement_rate_bps integer,
  engagement_consistency text NOT NULL,
  raw_evidence jsonb,
  evidence_digest bytea NOT NULL,
  measured_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CHECK (engagement_consistency IN ('LOW_RISK', 'MEDIUM_RISK', 'HIGH_RISK', 'INSUFFICIENT'))
);

CREATE TABLE brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_campaign_id numeric(78, 0) UNIQUE,
  brand_id uuid NOT NULL REFERENCES brands(id),
  title text NOT NULL,
  description text NOT NULL,
  terms jsonb NOT NULL,
  terms_digest bytea NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  creator_profile_id uuid NOT NULL REFERENCES creator_profiles(id),
  proposal text NOT NULL,
  requested_amount numeric(78, 0) NOT NULL,
  signed_payload jsonb NOT NULL,
  signature bytea NOT NULL,
  status text NOT NULL DEFAULT 'submitted',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, creator_profile_id)
);

CREATE TABLE submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  creator_profile_id uuid NOT NULL REFERENCES creator_profiles(id),
  x_post_id text NOT NULL,
  x_post_url text NOT NULL,
  submission_digest bytea NOT NULL UNIQUE,
  source_status text NOT NULL DEFAULT 'active',
  submitted_at timestamptz NOT NULL,
  deletion_requested_at timestamptz,
  deleted_at timestamptz
);

CREATE TABLE resolution_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submissions(id),
  request_digest bytea NOT NULL UNIQUE,
  genlayer_transaction bytea,
  status text NOT NULL DEFAULT 'pending',
  outcome text,
  evidence_digest bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE chain_events (
  id bigserial PRIMARY KEY,
  chain text NOT NULL,
  transaction_hash bytea NOT NULL,
  log_index integer NOT NULL,
  block_number bigint NOT NULL,
  event_name text NOT NULL,
  payload jsonb NOT NULL,
  canonical boolean NOT NULL DEFAULT true,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, transaction_hash, log_index)
);

CREATE INDEX metric_snapshots_account_measured_idx
  ON creator_metric_snapshots (x_account_id, measured_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX campaigns_status_created_idx ON campaigns (status, created_at DESC);
CREATE INDEX applications_campaign_status_idx ON applications (campaign_id, status);
CREATE INDEX resolution_requests_status_idx ON resolution_requests (status, created_at);
