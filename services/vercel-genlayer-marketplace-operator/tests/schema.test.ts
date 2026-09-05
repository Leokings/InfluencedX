import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const baseMigration = await readFile(new URL("../migrations/0001_marketplace_operator.sql", import.meta.url), "utf8");
const identityBundleCutover = await readFile(
  new URL("../migrations/0002_identity_bundle_marketplace_address.sql", import.meta.url),
  "utf8",
);
const freshStudioNetCutover = await readFile(
  new URL("../migrations/0003_fresh_studionet_marketplace_address.sql", import.meta.url),
  "utf8",
);
const marketplaceV3Cutover = await readFile(
  new URL("../migrations/0004_marketplace_v3_cutover.sql", import.meta.url),
  "utf8",
);
const migration = `${baseMigration}\n${identityBundleCutover}\n${freshStudioNetCutover}\n${marketplaceV3Cutover}`;
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8")) as Record<string, unknown>;
const clientSource = await readFile(new URL("../lib/studionet-client.ts", import.meta.url), "utf8");
const migratorSource = await readFile(new URL("../scripts/migrate.ts", import.meta.url), "utf8");

test("database constraints pin StudioNet, zero value, the allowlist, and singleton fencing", () => {
  assert.match(migration, /chain_id = 61999/);
  assert.match(migration, /network = 'studionet'/);
  assert.match(migration, /value_atto = '0'/);
  assert.match(migration, /resolve_assignment', 'expire_assignment', 'finalize_campaign'/);
  assert.match(migration, /influencedx-marketplace-operator-signer-v1/);
  assert.match(migration, /phase = 'BROADCASTING' AND lease_expires_at IS NULL/);
  assert.match(identityBundleCutover, /WHERE contract_address <> '0xeaceba807a7a4dc370f3b5a8e45539596b8551b4'/);
  assert.match(identityBundleCutover, /RAISE EXCEPTION/);
  assert.match(
    identityBundleCutover,
    /DROP CONSTRAINT IF EXISTS influencedx_marketplace_operator_status_contract_address_check/,
  );
  assert.match(identityBundleCutover, /CHECK \(contract_address = '0xeaceba807a7a4dc370f3b5a8e45539596b8551b4'\)/);
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
});

test("the migration runner serializes, checksums, and atomically records every migration", () => {
  assert.match(migratorSource, /influencedx_marketplace_operator_migrations/);
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
  const expected = [
    ["0001_marketplace_operator.sql", baseMigration, "7824a507bf026fa3c7d3ff78ba8276c273f921b7e4abac9bafbf7307ac6d2a09"],
    ["0002_identity_bundle_marketplace_address.sql", identityBundleCutover, "6fa8ced69e21c4303bafec518f7d58b5242b12d634a5d3293112717fa08320c8"],
  ] as const;
  for (const [name, source, checksum] of expected) {
    assert.equal(createHash("sha256").update(source).digest("hex"), checksum, name);
    assert.match(migratorSource, new RegExp(checksum));
  }
});

test("the queue consumer is an air-gapped push trigger on the new topic", () => {
  const serialized = JSON.stringify(vercel);
  assert.match(serialized, /queue\/v2beta/);
  assert.match(serialized, /influencedx-genlayer-marketplace-ops-v1/);
  assert.doesNotMatch(serialized, /influencedx-studionet-submissions-v1/);
});

test("the only write adapter hard-codes zero native value and the checksum RPC address", () => {
  assert.match(clientSource, /address: config\.rpcContractAddress/);
  assert.match(clientSource, /value: 0n/);
  assert.doesNotMatch(clientSource, /request_withdrawal|confirm_withdrawal|restore_failed_withdrawal/);
});
