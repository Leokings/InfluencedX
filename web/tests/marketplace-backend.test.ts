import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  marketplaceApplications,
  marketplaceCampaignResolutionRelays,
  marketplaceCampaigns,
  marketplaceCreatorMetricsSnapshots,
  marketplaceCreatorProfiles,
} from "../db/postgres-schema.ts";
import {
  formatUsdcAmount,
  parseUsdcAmount,
  usdcAtomsToDecimal,
} from "../lib/marketplace-core.ts";
import {
  INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT,
  prepareAssignmentAcceptance,
} from "../lib/marketplace-chain.ts";
import {
  assertExactMarketplaceCall,
  authorizeMarketplaceCall,
} from "../lib/marketplace-receipts.ts";
import {
  canTransitionGenLayerStatus,
  exactMetricsSnapshot,
  type CreatorMetricsRow,
  type FinalizedCreatorMetricsSnapshot,
} from "../lib/marketplace-repository.ts";

test("marketplace REST amounts are canonical USDC atom strings", () => {
  assert.equal(parseUsdcAmount("1200000000", "budgetUsdc"), "1200000000");
  assert.equal(formatUsdcAmount("1200000000"), "1200000000");
  assert.equal(usdcAtomsToDecimal("1200000000"), "1200");
  assert.equal(usdcAtomsToDecimal("1250000"), "1.25");

  for (const value of ["0", "01", "1.2", " 1000000", 1_000_000, null]) {
    assert.throws(
      () => parseUsdcAmount(value, "budgetUsdc"),
      /canonical positive USDC atomic-unit string/,
    );
  }
  assert.throws(
    () => parseUsdcAmount((1n << 256n).toString(), "budgetUsdc"),
    /uint256/,
  );
});

test("0006 campaign settlement migration fences each request and never persists signatures", async () => {
  const migration = await readFile(
    new URL(
      "../drizzle-postgres/0006_campaign_settlement_relay.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const config = getTableConfig(marketplaceCampaignResolutionRelays);
  assert.equal(config.name, "marketplace_campaign_resolution_relays");
  for (const column of config.columns) {
    assert.match(migration, new RegExp(`"${column.name}"`));
  }
  assert.match(migration, /PRIMARY KEY NOT NULL/);
  assert.match(migration, /application_round_idx/);
  assert.match(migration, /RECONCILIATION_REQUIRED/);
  assert.match(migration, /jsonb_array_length\("signer_addresses"\) >= 2/);
  assert.match(migration, /"status" <> 'CONFIRMED'/);
  assert.doesNotMatch(migration, /watcher_signature|signatures/);
});

test("marketplace schema pins funding, selection, privacy, and receipt invariants", () => {
  const campaigns = getTableConfig(marketplaceCampaigns);
  const campaignChecks = new Set(campaigns.checks.map((item) => item.name));
  const campaignIndexes = new Set(campaigns.indexes.map((item) => item.config.name));
  assert.ok(campaignChecks.has("marketplace_campaigns_open_requires_funding"));
  assert.ok(campaignChecks.has("marketplace_campaigns_funded_binding"));
  assert.ok(campaignChecks.has("marketplace_campaigns_base_sepolia_only"));
  assert.ok(campaignIndexes.has("marketplace_campaigns_funding_tx_idx"));
  assert.ok(campaignIndexes.has("marketplace_campaigns_escrow_campaign_idx"));

  const applications = getTableConfig(marketplaceApplications);
  const applicationChecks = new Set(applications.checks.map((item) => item.name));
  const applicationIndexes = new Set(
    applications.indexes.map((item) => item.config.name),
  );
  assert.ok(applicationChecks.has("marketplace_applications_submission_state"));
  assert.ok(
    applicationChecks.has("marketplace_applications_resolution_request_state"),
  );
  assert.ok(applicationIndexes.has("marketplace_applications_one_selected_idx"));
  assert.ok(applicationIndexes.has("marketplace_applications_selection_tx_idx"));
  assert.ok(applicationIndexes.has("marketplace_applications_submission_tx_idx"));
  assert.ok(applicationIndexes.has("marketplace_applications_progression_due_idx"));
  assert.ok(
    applicationChecks.has("marketplace_applications_progression_lease_pair"),
  );
  assert.ok(
    applicationChecks.has(
      "marketplace_applications_progression_attempts_nonnegative",
    ),
  );
});

test("creator marketplace storage contains commitments, not raw X evidence", () => {
  const profiles = getTableConfig(marketplaceCreatorProfiles);
  const profileColumns = new Set(profiles.columns.map((column) => column.name));
  assert.ok(profileColumns.has("identity_hash"));
  assert.ok(profileColumns.has("handle_hash"));
  assert.ok(profileColumns.has("verification_tx_hash"));
  for (const forbidden of [
    "verification_post_body",
    "x_api_response",
    "profile_html",
    "evidence_json",
  ]) {
    assert.equal(profileColumns.has(forbidden), false);
  }

  const metrics = getTableConfig(marketplaceCreatorMetricsSnapshots);
  const metricColumns = new Set(metrics.columns.map((column) => column.name));
  assert.ok(metricColumns.has("followers_count"));
  assert.ok(metricColumns.has("engagement_rate_bps"));
  assert.ok(metricColumns.has("evidence_hash"));
  assert.equal(metricColumns.has("raw_response"), false);
});

test("fresh wallet sessions can reuse a still-active verification by wallet", async () => {
  const source = await readFile(
    new URL("../lib/marketplace-repository.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export async function upsertVerifiedCreatorProfile");
  const end = source.indexOf("export async function insertApplicationIfOpen", start);
  assert.ok(start >= 0 && end > start);
  const lookup = source.slice(start, end);
  assert.match(
    lookup,
    /lower\(\$\{verificationRequests\.wallet\}\).*input\.wallet\.toLowerCase\(\)/s,
  );
  assert.doesNotMatch(lookup, /ownerUserId|verificationRequests\.ownerUserId/);
});

test("public profiles materialize directly from a confirmed wallet verification", async () => {
  const source = await readFile(
    new URL("../lib/marketplace-service.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export async function getPublicMarketplaceCreatorProfile");
  const end = source.indexOf("export function campaignDto", start);
  assert.ok(start >= 0 && end > start);
  const lookup = source.slice(start, end);
  assert.match(lookup, /findPublicCreatorProfileByWallet\(normalized\)/);
  assert.match(lookup, /upsertVerifiedCreatorProfile\(\{/);
  assert.match(lookup, /wallet: normalized/);
});

test("receipt binding rejects a valid call made by the wrong actor", () => {
  const call = prepareAssignmentAcceptance({
    chainId: 84_532,
    assignmentId: "7",
  });
  const expectedActor = "0x1111111111111111111111111111111111111111";
  const transaction = {
    hash: `0x${"1".repeat(64)}` as `0x${string}`,
    blockHash: `0x${"2".repeat(64)}` as `0x${string}`,
    blockNumber: 123n,
    from: "0x2222222222222222222222222222222222222222" as const,
    to: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
    input: call.data,
    value: 0n,
    receiptStatus: "success" as const,
    logs: [],
  };
  assert.throws(
    () => assertExactMarketplaceCall(transaction, call, expectedActor),
    /authorized marketplace action/,
  );
});

test("receipt binding accepts an effect-bound EIP-7702 marketplace execution", async () => {
  const call = prepareAssignmentAcceptance({
    chainId: 84_532,
    assignmentId: "7",
  });
  const expectedActor = "0x1111111111111111111111111111111111111111";
  const transaction = {
    hash: `0x${"1".repeat(64)}` as `0x${string}`,
    blockHash: `0x${"2".repeat(64)}` as `0x${string}`,
    blockNumber: 123n,
    from: "0x2222222222222222222222222222222222222222" as const,
    to: "0x3333333333333333333333333333333333333333" as const,
    input: "0xcef6d209" as const,
    value: 0n,
    receiptStatus: "success" as const,
    logs: [{ address: call.address, data: "0x" as const, topics: [] }],
  };
  assert.equal(
    await authorizeMarketplaceCall(transaction, call, expectedActor, {
      trace: {
        type: "CALL",
        from: expectedActor,
        to: call.address,
        input: call.data,
        value: "0x0",
      },
    }),
    "wrapped",
  );
  await assert.rejects(
    authorizeMarketplaceCall(
      { ...transaction, logs: [] },
      call,
      expectedActor,
      {
        trace: {
          type: "CALL",
          from: expectedActor,
          to: call.address,
          input: call.data,
          value: "0x0",
        },
      },
    ),
    /authorized marketplace action/,
  );
});

test("GenLayer submitter lifecycle permits bounded retries but freezes terminals", () => {
  assert.equal(
    canTransitionGenLayerStatus("PRECHECK_FAILED", "PRECHECKING"),
    true,
  );
  assert.equal(canTransitionGenLayerStatus("SUBMITTED", "POLLING"), true);
  assert.equal(
    canTransitionGenLayerStatus("POLLING_EXHAUSTED", "POLLING"),
    true,
  );
  assert.equal(canTransitionGenLayerStatus("FINALIZED", "POLLING"), false);
  assert.equal(
    canTransitionGenLayerStatus("EXECUTION_FAILED", "PRECHECKING"),
    false,
  );
});

test("finalized metrics idempotency key rejects every semantic mutation", () => {
  const input: FinalizedCreatorMetricsSnapshot = {
    profileId: "profile-1",
    requestId: `0x${"1".repeat(64)}`,
    txHash: `0x${"2".repeat(64)}`,
    followersCount: 25_000,
    accountCreatedAt: 1_700_000_000_000,
    postsSampled: 18,
    medianEngagementCount: 450,
    engagementRateBps: 180,
    estimatedPayMinAmount: "165000000",
    estimatedPayMaxAmount: "300000000",
    riskLevel: "LOW",
    evidenceHash: `0x${"3".repeat(64)}`,
    capturedAt: 1_800_000_000_000,
    expiresAt: 1_800_086_400_000,
    nowMs: 1_800_000_001_000,
  };
  const row = {
    id: input.requestId,
    profileId: input.profileId,
    followersCount: input.followersCount,
    accountCreatedAt: input.accountCreatedAt,
    postsSampled: input.postsSampled,
    medianEngagementCount: input.medianEngagementCount,
    engagementRateBps: input.engagementRateBps,
    estimatedPayMinAmount: input.estimatedPayMinAmount,
    estimatedPayMaxAmount: input.estimatedPayMaxAmount,
    riskLevel: input.riskLevel,
    evidenceHash: input.evidenceHash,
    genlayerRequestId: input.requestId,
    genlayerTxHash: input.txHash,
    capturedAt: input.capturedAt,
    expiresAt: input.expiresAt,
    createdAt: input.nowMs - 500,
  } satisfies CreatorMetricsRow;

  assert.equal(exactMetricsSnapshot(row, input), true);
  assert.equal(
    exactMetricsSnapshot(row, { ...input, nowMs: input.nowMs + 10_000 }),
    true,
    "a later wall-clock retry must remain idempotent",
  );

  const mutations: Array<Partial<FinalizedCreatorMetricsSnapshot>> = [
    { profileId: "profile-2" },
    { requestId: `0x${"4".repeat(64)}` },
    { txHash: `0x${"5".repeat(64)}` },
    { followersCount: input.followersCount + 1 },
    { accountCreatedAt: input.accountCreatedAt + 1 },
    { postsSampled: input.postsSampled + 1 },
    { medianEngagementCount: input.medianEngagementCount + 1 },
    { engagementRateBps: input.engagementRateBps + 1 },
    { estimatedPayMinAmount: "165000001" },
    { estimatedPayMaxAmount: "300000001" },
    { riskLevel: "HIGH" },
    { evidenceHash: `0x${"6".repeat(64)}` },
    { capturedAt: input.capturedAt + 1 },
    { expiresAt: input.expiresAt + 1 },
  ];
  for (const mutation of mutations) {
    assert.equal(exactMetricsSnapshot(row, { ...input, ...mutation }), false);
  }

  assert.equal(
    exactMetricsSnapshot({ ...row, genlayerRequestId: null }, input),
    false,
  );
  assert.equal(
    exactMetricsSnapshot({ ...row, genlayerTxHash: null }, input),
    false,
  );
});

test("metrics refresh route accepts no caller-provided counts or resolver arguments", async () => {
  const source = await readFile(
    new URL(
      "../app/api/marketplace/creators/[wallet]/metrics/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /Object\.keys\(body\)\.length !== 0/);
  assert.match(source, /refreshMarketplaceCreatorMetrics/);
  assert.match(source, /getMarketplaceCreatorMetricsStatus/);
  assert.doesNotMatch(source, /body\.(?:followers|following|engagement|pay|handle|identity)/i);
});

test("0005 marketplace migration is journaled and includes all durable tables", async () => {
  const migration = await readFile(
    new URL(
      "../drizzle-postgres/0005_influencedx_marketplace.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const table of [
    "marketplace_campaigns",
    "marketplace_creator_profiles",
    "marketplace_creator_metrics_snapshots",
    "marketplace_applications",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
  }
  for (const schemaTable of [
    marketplaceCampaigns,
    marketplaceCreatorProfiles,
    marketplaceCreatorMetricsSnapshots,
    marketplaceApplications,
  ]) {
    const config = getTableConfig(schemaTable);
    const marker = `CREATE TABLE "${config.name}"`;
    const start = migration.indexOf(marker);
    const end = migration.indexOf(");--> statement-breakpoint", start);
    assert.ok(start >= 0 && end > start, `missing migration block for ${config.name}`);
    const block = migration.slice(start, end);
    for (const column of config.columns) {
      if (
        config.name === "marketplace_applications" &&
        PROGRESSION_EXTENSION_COLUMNS.has(column.name)
      ) {
        continue;
      }
      assert.match(
        block,
        new RegExp(`"${column.name}"`),
        `${config.name}.${column.name} missing from 0005`,
      );
    }
  }
  const journal = JSON.parse(
    await readFile(
      new URL("../drizzle-postgres/meta/_journal.json", import.meta.url),
      "utf8",
    ),
  ) as { entries: Array<{ tag: string }> };
  assert.ok(journal.entries.some((entry) => entry.tag === "0005_influencedx_marketplace"));
  assert.equal(journal.entries.at(-1)?.tag, "0008_studionet_cutover");
});

test("0007 adds a recoverable CAS lease without storing signer material", async () => {
  const migration = await readFile(
    new URL(
      "../drizzle-postgres/0007_campaign_progression_worker.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const column of PROGRESSION_EXTENSION_COLUMNS) {
    assert.match(migration, new RegExp(`"${column}"`));
  }
  assert.match(migration, /progression_due_idx/);
  assert.match(migration, /progression_lease_pair/);
  assert.match(migration, /progression_attempts_nonnegative/);
  assert.doesNotMatch(migration, /private_key|keystore|watcher_signature/i);
});

test("0008 defaults new GenLayer rows to StudioNet while retaining coupled Bradbury history", async () => {
  const migration = await readFile(
    new URL("../drizzle-postgres/0008_studionet_cutover.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /ALTER COLUMN network SET DEFAULT 'studionet'/);
  assert.match(
    migration,
    /ALTER COLUMN resolver SET DEFAULT '0x0913b5593ff16974e2fd616ca678a4986cb48600'/,
  );
  assert.match(
    migration,
    /network = 'studionet' AND resolver = '0x0913b5593ff16974e2fd616ca678a4986cb48600'/,
  );
  assert.match(
    migration,
    /network = 'testnet-bradbury' AND resolver = '0x017311b35dbb9802883bdae7fb0efd7bd77cb0b2'/,
  );
  assert.match(migration, /network_resolver_check/);
});

const PROGRESSION_EXTENSION_COLUMNS = new Set([
  "progression_fence_token",
  "progression_lease_expires_at",
  "progression_next_attempt_at",
  "progression_attempt_count",
  "progression_error_code",
  "progression_last_attempt_at",
]);
