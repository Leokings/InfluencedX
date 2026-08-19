import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = [
  await readFile(new URL("../migrations/0001_withdrawal_reconciler.sql", import.meta.url), "utf8"),
  await readFile(new URL("../migrations/0002_withdrawal_confirmer_role.sql", import.meta.url), "utf8"),
  await readFile(new URL("../migrations/0003_fresh_marketplace_address.sql", import.meta.url), "utf8"),
  await readFile(new URL("../migrations/0004_identity_bundle_marketplace_address.sql", import.meta.url), "utf8"),
].join("\n");
const identityBundleCutover = await readFile(
  new URL("../migrations/0004_identity_bundle_marketplace_address.sql", import.meta.url),
  "utf8",
);
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8")) as Record<string, unknown>;
const clientSource = await readFile(new URL("../lib/studionet-client.ts", import.meta.url), "utf8");
const serviceSource = await readFile(new URL("../lib/operation-service.ts", import.meta.url), "utf8");

test("database constraints bind the exact deployment, confirmer role, zero value, and permanent broadcast fence", () => {
  assert.match(migration, /chain_id = 61999/);
  assert.match(identityBundleCutover, /WHERE contract_address = '0x58d598b8323e9c1d041989dcce80e737109de347'/);
  assert.match(identityBundleCutover, /CHECK \(contract_address = '0xeaceba807a7a4dc370f3b5a8e45539596b8551b4'\)/);
  assert.match(identityBundleCutover, /RAISE EXCEPTION/);
  assert.match(migration, /withdrawal_confirmer/);
  assert.match(migration, /0xaafc5d9075a404d82b8ee1692f7ff802168c5dd8/);
  assert.match(migration, /influencedx-withdrawal-confirmer-signer-v1/);
  assert.match(migration, /influencedx_withdrawal_reconciliation_signer_ga_gate_name_check/);
  assert.match(migration, /function_name = 'confirm_withdrawal'/);
  assert.match(migration, /value_atto = '0'/);
  assert.match(migration, /phase = 'BROADCASTING' AND lease_expires_at IS NULL/);
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
