import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const sql = neon(databaseUrl, { readOnly: true });
const [tableState] = await sql.query(`
  select
    to_regclass('public.verification_requests') is not null as table_ready,
    to_regclass('public.verification_rate_limits') is not null as rate_limits_ready,
    to_regclass('public.xproof_bradbury_submission_status') is not null as submitter_status_ready,
    to_regclass('public.xproof_bradbury_submission_jobs') is not null as submitter_jobs_ready,
    to_regclass('public.xproof_bradbury_signer_gate') is not null as signer_gate_ready,
    to_regclass('public.ownership_authorization_grants') is not null as authorization_grants_ready,
    to_regclass('public.marketplace_campaigns') is not null as marketplace_campaigns_ready,
    to_regclass('public.marketplace_applications') is not null as marketplace_applications_ready,
    to_regclass('public.marketplace_creator_profiles') is not null as marketplace_profiles_ready,
    to_regclass('public.marketplace_creator_metrics_snapshots') is not null as marketplace_metrics_ready,
    to_regclass('public.marketplace_campaign_resolution_relays') is not null as marketplace_relays_ready,
    EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = 'xproof_bradbury_submission_status'
        AND c.conname = 'xproof_bradbury_submission_status_network_resolver_check'
        AND pg_get_constraintdef(c.oid) LIKE '%studionet%'
        AND pg_get_constraintdef(c.oid) LIKE '%testnet-bradbury%'
    ) AS studionet_history_constraint_ready,
    (
      SELECT column_default = '''studionet''::text'
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'xproof_bradbury_submission_status'
        AND column_name = 'network'
    ) AS studionet_default_ready,
    (
      select count(*)::int
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'verification_requests'
    ) as column_count,
    (
      select count(*)::int
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'verification_requests'
        and column_name in (
          'base_relay_status', 'base_relay_tx_hash', 'base_relay_updated_at',
          'base_confirmed_at', 'base_relay_error_code', 'base_registry_address',
          'base_profile_id', 'base_profile_identity_hash',
          'base_profile_handle_hash', 'base_profile_verification_post_hash',
          'base_profile_expires_at', 'base_profile_active',
          'base_profile_verified'
        )
    ) as base_relay_column_count,
    (
      select count(*)::int
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'marketplace_applications'
        and column_name in (
          'genlayer_submitter_status', 'genlayer_tx_hash',
          'genlayer_result_outcome', 'genlayer_lifecycle_status',
          'genlayer_execution_result', 'genlayer_error_code',
          'genlayer_submitted_at', 'genlayer_finalized_at'
        )
    ) as marketplace_genlayer_column_count
    ,(
      select count(*)::int
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'marketplace_campaign_resolution_relays'
    ) as marketplace_relay_column_count
`);

if (
  !tableState?.table_ready ||
  !tableState.rate_limits_ready ||
  !tableState.submitter_status_ready ||
  !tableState.submitter_jobs_ready ||
  !tableState.signer_gate_ready ||
  !tableState.authorization_grants_ready ||
  !tableState.marketplace_campaigns_ready ||
  !tableState.marketplace_applications_ready ||
  !tableState.marketplace_profiles_ready ||
  !tableState.marketplace_metrics_ready ||
  !tableState.marketplace_relays_ready ||
  !tableState.studionet_history_constraint_ready ||
  !tableState.studionet_default_ready ||
  tableState.column_count !== 68 ||
  tableState.base_relay_column_count !== 13 ||
  tableState.marketplace_genlayer_column_count !== 8 ||
  tableState.marketplace_relay_column_count !== 21
) {
  throw new Error("The InfluencedX verification schema is not fully migrated.");
}

const [rowState] = await sql.query(
  "select count(*)::int as request_count from public.verification_requests",
);
const [submissionState] = await sql.query(
  "select count(*)::int as submission_count from public.xproof_bradbury_submission_status",
);
const [authorizationState] = await sql.query(
  "select count(*)::int as authorization_grant_count from public.ownership_authorization_grants",
);
const [marketplaceRelayState] = await sql.query(
  "select count(*)::int as relay_count from public.marketplace_campaign_resolution_relays",
);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    table: "verification_requests",
    columns: tableState.column_count,
    rows: rowState.request_count,
    submitterStatusRows: submissionState.submission_count,
    authorizationGrantRows: authorizationState.authorization_grant_count,
    marketplaceGenLayerColumns: tableState.marketplace_genlayer_column_count,
    marketplaceRelayColumns: tableState.marketplace_relay_column_count,
    marketplaceRelayRows: marketplaceRelayState.relay_count,
    studioNetCutoverReady: true,
  })}\n`,
);
