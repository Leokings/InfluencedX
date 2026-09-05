import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const historicalMigrations = await Promise.all([
  "0001_withdrawal_reconciler.sql",
  "0002_withdrawal_confirmer_role.sql",
  "0003_fresh_marketplace_address.sql",
  "0004_identity_bundle_marketplace_address.sql",
].map(async (name) => [name, await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8")] as const));
const identityBundleCutover = await readFile(
  new URL("../migrations/0004_identity_bundle_marketplace_address.sql", import.meta.url),
  "utf8",
);
const freshStudioNetCutover = await readFile(
  new URL("../migrations/0005_fresh_studionet_marketplace_address.sql", import.meta.url),
  "utf8",
);
const marketplaceV3Cutover = await readFile(
  new URL("../migrations/0006_marketplace_v3_cutover.sql", import.meta.url),
  "utf8",
);
const migration = [...historicalMigrations.map(([, source]) => source), freshStudioNetCutover, marketplaceV3Cutover].join("\n");
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8")) as Record<string, unknown>;
const clientSource = await readFile(new URL("../lib/studionet-client.ts", import.meta.url), "utf8");
const serviceSource = await readFile(new URL("../lib/operation-service.ts", import.meta.url), "utf8");
const migratorSource = await readFile(new URL("../scripts/migrate.ts", import.meta.url), "utf8");

test("database constraints bind the exact deployment, confirmer role, zero value, and permanent broadcast fence", () => {
  assert.match(migration, /chain_id = 61999/);
  assert.match(identityBundleCutover, /WHERE contract_address = '0x58d598b8323e9c1d041989dcce80e737109de347'/);
  assert.match(identityBundleCutover, /CHECK \(contract_address = '0xeaceba807a7a4dc370f3b5a8e45539596b8551b4'\)/);
  assert.match(identityBundleCutover, /RAISE EXCEPTION/);
  assert.match(freshStudioNetCutover, /WHERE contract_address <> '0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb'/);
  assert.match(freshStudioNetCutover, /RAISE EXCEPTION/);
  assert.match(
    freshStudioNetCutover,
    /CHECK \(contract_address = '0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb'\)/,
  );
  assert.match(marketplaceV3Cutover, /signer gate must be idle before the V3 cutover/);
  assert.match(marketplaceV3Cutover, /MARKETPLACE_V3_CUTOVER/);
  assert.match(marketplaceV3Cutover, /'0x492175c248168ddb9571cbf4c6a14296e3348181'/);
  assert.match(marketplaceV3Cutover, /contract_address IN/);
  assert.match(migration, /withdrawal_confirmer/);
  assert.match(migration, /0xaafc5d9075a404d82b8ee1692f7ff802168c5dd8/);
  assert.match(migration, /influencedx-withdrawal-confirmer-signer-v1/);
  assert.match(migration, /influencedx_withdrawal_reconciliation_signer_ga_gate_name_check/);
  assert.match(migration, /function_name = 'confirm_withdrawal'/);
  assert.match(migration, /value_atto = '0'/);
  assert.match(migration, /phase = 'BROADCASTING' AND lease_expires_at IS NULL/);
});

test("the migration runner serializes, checksums, and atomically records every migration", () => {
  assert.match(migratorSource, /influencedx_withdrawal_reconciler_migrations/);
  assert.match(migratorSource, /createHash\("sha256"\)/);
  assert.match(migratorSource, /pg_advisory_lock/);
  assert.match(migratorSource, /pg_advisory_unlock/);
  assert.match(migratorSource, /await client\.query\("BEGIN"\)/);
  assert.match(migratorSource, /await client\.query\("COMMIT"\)/);
  assert.match(migratorSource, /await client\.query\("ROLLBACK"\)/);
  assert.match(migratorSource, /Applied migration checksum mismatch/);
  assert.match(migratorSource, /not an exact prefix/);
  assert.match(migratorSource, /assertBootstrapSafe/);
  assert.match(migratorSource, /has_status_rows/);
  assert.match(migratorSource, /has_job_rows/);
  assert.match(migratorSource, /has_unsafe_gate/);
});

test("pre-ledger migration checksums are immutable", () => {
  const checksums = new Map([
    ["0001_withdrawal_reconciler.sql", "4746312b038eed8d99437334b16c9a7f7d3046b399ac86cffd855f2530eb1598"],
    ["0002_withdrawal_confirmer_role.sql", "5866b282023587013ae2afb7fa7772b80980f2b9baacae0d44705aec399b1f61"],
    ["0003_fresh_marketplace_address.sql", "bec24b7c16c7b29b22b78ead5d69365b1774b4d9ba0a5bc5ddd29e04e6c18d60"],
    ["0004_identity_bundle_marketplace_address.sql", "469ba18f8bee86fcf28d26b2ac7a8db1ec602f8074eabe06a8c5624a4997955e"],
  ]);
  for (const [name, source] of historicalMigrations) {
    const checksum = checksums.get(name);
    assert.ok(checksum);
    assert.equal(createHash("sha256").update(source).digest("hex"), checksum, name);
    assert.match(migratorSource, new RegExp(checksum));
  }
});

test("the queue route is an air-gapped push trigger on its independent topic", () => {
  const value = JSON.stringify(vercel);
  assert.match(value, /queue\/v2beta/);
  assert.match(value, /influencedx-genlayer-withdrawal-reconciliation-v1/);
  assert.doesNotMatch(value, /influencedx-genlayer-marketplace-ops-v1/);
});

test("the only write adapter is exact zero-value confirmation and there is no automated recovery path", () => {
  assert.match(clientSource, /functionName: CONFIRM_METHOD/);
  assert.match(clientSource, /value: 0n/);
  const forbidden = /restore_failed_withdrawal|recapitalize_failed_withdrawal|set_paused|set_protocol_fee_bps|set_treasury|set_withdrawal_confirmer|propose_owner|accept_owner|schedule_upgrade|cancel_upgrade|execute_upgrade/;
  assert.doesNotMatch(clientSource, forbidden);
  assert.doesNotMatch(serviceSource, forbidden);
});
