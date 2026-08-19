import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const sql = neon(databaseUrl, { readOnly: true });
const [state] = await sql.query(`
  select
    (
      to_regclass('public.verification_requests') is not null
      and to_regclass('public.verification_rate_limits') is not null
      and to_regclass('public.marketplace_genlayer_campaign_drafts') is not null
      and to_regclass('public.marketplace_genlayer_profiles') is not null
      and to_regclass('public.marketplace_genlayer_applications_private') is not null
      and to_regclass('public.marketplace_genlayer_campaigns') is not null
      and to_regclass('public.marketplace_genlayer_assignments') is not null
      and to_regclass('public.marketplace_genlayer_transactions') is not null
      and to_regclass('public.marketplace_genlayer_claimable_balances') is not null
      and to_regclass('public.marketplace_genlayer_withdrawals') is not null
      and to_regclass('public.marketplace_genlayer_projection_cursors') is not null
      and to_regclass('public.marketplace_genlayer_maintenance_generations') is not null
    ) as native_tables_ready,
    not exists (
      select 1
      from (values
        ('verification_requests', 'identity_source'),
        ('verification_requests', 'farcaster_username'),
        ('verification_requests', 'farcaster_fid'),
        ('verification_requests', 'farcaster_challenge'),
        ('verification_requests', 'farcaster_cast_text'),
        ('verification_requests', 'farcaster_challenge_issued_at'),
        ('verification_requests', 'farcaster_challenge_expires_at'),
        ('verification_requests', 'farcaster_cast_hash'),
        ('verification_requests', 'activation_prepared_id'),
        ('verification_requests', 'activation_tx_hash'),
        ('verification_requests', 'activation_confirmed_at'),
        ('verification_requests', 'x_ownership_request_id'),
        ('verification_requests', 'farcaster_ownership_request_id'),
        ('marketplace_genlayer_profiles', 'projection_id'),
        ('marketplace_genlayer_profiles', 'network'),
        ('marketplace_genlayer_profiles', 'chain_id'),
        ('marketplace_genlayer_profiles', 'contract_address'),
        ('marketplace_genlayer_profiles', 'source'),
        ('marketplace_genlayer_profiles', 'identity_hash'),
        ('marketplace_genlayer_campaigns', 'projection_id'),
        ('marketplace_genlayer_campaigns', 'campaign_id'),
        ('marketplace_genlayer_campaigns', 'content_source'),
        ('marketplace_genlayer_campaigns', 'budget_atto'),
        ('marketplace_genlayer_campaigns', 'available_atto'),
        ('marketplace_genlayer_campaigns', 'reserved_atto'),
        ('marketplace_genlayer_campaigns', 'settled_atto'),
        ('marketplace_genlayer_campaigns', 'creator_paid_atto'),
        ('marketplace_genlayer_campaigns', 'brand_refunded_atto'),
        ('marketplace_genlayer_campaigns', 'fee_atto'),
        ('marketplace_genlayer_assignments', 'projection_id'),
        ('marketplace_genlayer_assignments', 'network'),
        ('marketplace_genlayer_assignments', 'chain_id'),
        ('marketplace_genlayer_assignments', 'contract_address'),
        ('marketplace_genlayer_assignments', 'assignment_id'),
        ('marketplace_genlayer_assignments', 'content_source'),
        ('marketplace_genlayer_assignments', 'resolution_checks'),
        ('marketplace_genlayer_transactions', 'arg_types'),
        ('marketplace_genlayer_transactions', 'value_atto'),
        ('marketplace_genlayer_withdrawals', 'withdrawal_id'),
        ('marketplace_genlayer_withdrawals', 'recapitalized_atto'),
        ('marketplace_genlayer_maintenance_generations', 'active_deployment_id'),
        ('marketplace_genlayer_maintenance_generations', 'generation'),
        ('marketplace_genlayer_maintenance_generations', 'vercel_project_id'),
        ('marketplace_genlayer_maintenance_generations', 'vercel_environment')
      ) as required(table_name, column_name)
      where not exists (
        select 1 from information_schema.columns c
        where c.table_schema = 'public'
          and c.table_name = required.table_name
          and c.column_name = required.column_name
      )
    ) as native_columns_ready,
    (
      select count(*)::int = 16
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public'
        and c.conname in (
          'verification_requests_identity_source',
          'verification_requests_farcaster_fid',
          'verification_requests_farcaster_cast_hash',
          'verification_requests_activation_tx',
          'verification_requests_expiry_state',
          'verification_requests_identity_bundle_pair',
          'verification_requests_identity_bundle_hashes',
          'marketplace_genlayer_transactions_operation',
          'marketplace_genlayer_profiles_namespace',
          'marketplace_genlayer_profiles_source',
          'marketplace_genlayer_campaigns_namespace',
          'marketplace_genlayer_assignments_namespace',
          'marketplace_genlayer_withdrawals_namespace',
          'marketplace_genlayer_maintenance_generations_namespace',
          'marketplace_genlayer_maintenance_generations_vercel',
          'marketplace_genlayer_maintenance_generations_monotonic'
        )
        and c.convalidated
    ) as native_constraints_ready,
    (
      select count(*)::int = 9
      from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'verification_requests_activation_prepared_idx',
          'marketplace_genlayer_profiles_owner_contract_idx',
          'marketplace_genlayer_profiles_identity_contract_idx',
          'marketplace_genlayer_campaigns_entity_contract_idx',
          'marketplace_genlayer_assignments_entity_contract_idx',
          'marketplace_genlayer_transactions_hash_idx',
          'marketplace_genlayer_withdrawals_entity_contract_idx',
          'marketplace_genlayer_claimable_balances_pk',
          'marketplace_genlayer_maintenance_generations_pk'
        )
    ) as native_indexes_ready,
    (
      select count(*)::int
      from information_schema.columns
      where table_schema = 'public' and table_name = 'verification_requests'
    ) as verification_column_count,
    (
      select count(*)::int
      from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          'marketplace_campaigns', 'marketplace_applications',
          'marketplace_creator_profiles', 'xproof_bradbury_submission_status'
        )
    ) as historical_table_count
`);

const nativeReadiness = {
  tables: Boolean(state?.native_tables_ready),
  columns: Boolean(state?.native_columns_ready),
  constraints: Boolean(state?.native_constraints_ready),
  indexes: Boolean(state?.native_indexes_ready),
};
if (Object.values(nativeReadiness).includes(false)) {
  throw new Error(
    `The InfluencedX GenLayer-native schema is not fully migrated: ${JSON.stringify(nativeReadiness)}`,
  );
}

const [requestState] = await sql.query(
  "select count(*)::int as request_count from public.verification_requests",
);
const [campaignState] = await sql.query(
  "select count(*)::int as campaign_count from public.marketplace_genlayer_campaigns",
);
const [assignmentState] = await sql.query(
  "select count(*)::int as assignment_count from public.marketplace_genlayer_assignments",
);
const [withdrawalState] = await sql.query(
  "select count(*)::int as withdrawal_count from public.marketplace_genlayer_withdrawals",
);

process.stdout.write(JSON.stringify({
  ok: true,
  network: "studionet",
  chainId: 61_999,
  schemaVersion: 4,
  verificationColumns: state.verification_column_count,
  verificationRequests: requestState.request_count,
  campaigns: campaignState.campaign_count,
  assignments: assignmentState.assignment_count,
  withdrawals: withdrawalState.withdrawal_count,
  historicalTablesPresent: state.historical_table_count,
  genLayerNativeReady: true,
}) + "\n");
