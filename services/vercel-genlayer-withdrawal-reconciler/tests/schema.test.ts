import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../migrations/0001_withdrawal_reconciler.sql", import.meta.url), "utf8");
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8")) as Record<string, unknown>;
const clientSource = await readFile(new URL("../lib/studionet-client.ts", import.meta.url), "utf8");
const serviceSource = await readFile(new URL("../lib/operation-service.ts", import.meta.url), "utf8");

test("database constraints pin the exact deployment, owner, zero value, and permanent broadcast fence", () => {
  assert.match(migration, /chain_id = 61999/);
  assert.match(migration, /0x17eb37a3578e21662f4d654b245238df520663fa/);
  assert.match(migration, /0x797d3b25fb2cca0ff93f60df1910267f3822d655/);
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
  assert.doesNotMatch(clientSource, /restore_failed_withdrawal|recapitalize_failed_withdrawal/);
  assert.doesNotMatch(serviceSource, /restore_failed_withdrawal|recapitalize_failed_withdrawal/);
});
