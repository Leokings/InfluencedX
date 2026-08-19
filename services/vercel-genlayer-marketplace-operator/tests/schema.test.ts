import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../migrations/0001_marketplace_operator.sql", import.meta.url), "utf8");
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8")) as Record<string, unknown>;
const clientSource = await readFile(new URL("../lib/studionet-client.ts", import.meta.url), "utf8");

test("database constraints pin StudioNet, zero value, the allowlist, and singleton fencing", () => {
  assert.match(migration, /chain_id = 61999/);
  assert.match(migration, /network = 'studionet'/);
  assert.match(migration, /value_atto = '0'/);
  assert.match(migration, /resolve_assignment', 'expire_assignment', 'finalize_campaign'/);
  assert.match(migration, /influencedx-marketplace-operator-signer-v1/);
  assert.match(migration, /phase = 'BROADCASTING' AND lease_expires_at IS NULL/);
});

test("the queue consumer is an air-gapped push trigger on the new topic", () => {
  const serialized = JSON.stringify(vercel);
  assert.match(serialized, /queue\/v2beta/);
  assert.match(serialized, /influencedx-genlayer-marketplace-ops-v1/);
  assert.doesNotMatch(serialized, /influencedx-studionet-submissions-v1/);
});

test("the only write adapter hard-codes zero native value and the configured address", () => {
  assert.match(clientSource, /address: config\.contractAddress/);
  assert.match(clientSource, /value: 0n/);
  assert.doesNotMatch(clientSource, /request_withdrawal|confirm_withdrawal|restore_failed_withdrawal/);
});
