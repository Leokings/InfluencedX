import assert from "node:assert/strict";
import test from "node:test";

import { PINNED_BRADBURY_RESOLVER } from "../lib/constants";
import { loadConfig } from "../lib/config";
import { validateOwnershipEnvelope, validateQueueMessage } from "../lib/envelope";
import { PoisonMessageError } from "../lib/problem";
import { makeEnvelope, NOW_EPOCH, validEnv } from "./helpers";

test("configuration pins testnet, resolver, key, database, and exact caller identity", () => {
  const config = loadConfig(validEnv());
  assert.equal(config.network, "testnet-bradbury");
  assert.equal(config.resolver, PINNED_BRADBURY_RESOLVER);
  assert.equal(config.caller.projectId, "prj_4W0EuXNi5nFD46ArUAbvk2YnTacu");
  for (const patch of [
    { XPROOF_SUBMITTER_ENABLED: "false" },
    { XPROOF_GENLAYER_NETWORK: "mainnet" },
    { XPROOF_GENLAYER_RESOLVER: `0x${"22".repeat(20)}` },
    { GENLAYER_SUBMITTER_PRIVATE_KEY: "" },
    { DATABASE_URL: "https://not-postgres.example" },
    { XPROOF_CALLER_ENVIRONMENT: "development" },
    { XPROOF_CALLER_ENVIRONMENT: "preview", VERCEL_ENV: "production" },
  ]) {
    assert.throws(() => loadConfig(validEnv(patch)), (error: unknown) => (error as { code?: string }).code === "SUBMITTER_CONFIGURATION_INVALID");
  }
});

test("ownership envelope is exact, canonical, time-bounded, and request-bound", async () => {
  const envelope = makeEnvelope();
  assert.deepEqual(await validateOwnershipEnvelope(envelope, { nowEpoch: NOW_EPOCH }), envelope);
  await assert.rejects(validateOwnershipEnvelope({ ...envelope, arbitraryCall: "drain" }, { nowEpoch: NOW_EPOCH }));
  await assert.rejects(validateOwnershipEnvelope({ ...envelope, requestId: `0x${"ff".repeat(32)}` }, { nowEpoch: NOW_EPOCH }));
  await assert.rejects(validateOwnershipEnvelope({ ...envelope, expiresAtEpoch: NOW_EPOCH - 1 }, { nowEpoch: NOW_EPOCH }));
});

test("queue messages reject extra, missing, or malformed fields as poison", () => {
  const requestId = makeEnvelope().requestId;
  assert.deepEqual(validateQueueMessage({ schemaVersion: 1, requestId }), { schemaVersion: 1, requestId });
  for (const value of [
    { schemaVersion: 1, requestId, extra: true },
    { schemaVersion: 2, requestId },
    { schemaVersion: 1 },
  ]) {
    assert.throws(() => validateQueueMessage(value), PoisonMessageError);
  }
});
