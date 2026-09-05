import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../lib/config";
import {
  validateQueueMessage,
  validateReconciliationRequest,
} from "../lib/envelope";
import { MARKETPLACE_DEPLOYMENT_TX_HASH } from "../lib/constants";
import { configFixture, validEnv, WITHDRAWAL_CONFIRMER, WITHDRAWAL_ID } from "./helpers";

const loadTestConfig = (env = validEnv()) => loadConfig(env, () => WITHDRAWAL_CONFIRMER);

test("ingress accepts only schemaVersion and a lowercase withdrawal ID", () => {
  assert.deepEqual(validateReconciliationRequest({ schemaVersion: 1, withdrawalId: WITHDRAWAL_ID }, configFixture()), {
    schemaVersion: 1,
    withdrawalId: WITHDRAWAL_ID,
  });
  for (const value of [
    { schemaVersion: 1, withdrawalId: WITHDRAWAL_ID, amountAtto: "1" },
    { schemaVersion: 1, withdrawalId: WITHDRAWAL_ID, method: "restore_failed_withdrawal" },
    { schemaVersion: 2, withdrawalId: WITHDRAWAL_ID },
    { schemaVersion: 1, withdrawalId: WITHDRAWAL_ID.toUpperCase() },
    { schemaVersion: 1, withdrawalId: "0x12" },
  ]) assert.throws(() => validateReconciliationRequest(value, configFixture()));
});

test("queue messages cannot smuggle proof, method, value, or recipient", () => {
  assert.deepEqual(validateQueueMessage({ schemaVersion: 1, withdrawalId: WITHDRAWAL_ID }), {
    schemaVersion: 1,
    withdrawalId: WITHDRAWAL_ID,
  });
  for (const extra of ["proof", "method", "valueAtto", "recipient", "txHash"]) {
    assert.throws(() => validateQueueMessage({ schemaVersion: 1, withdrawalId: WITHDRAWAL_ID, [extra]: "attacker" }));
  }
});

test("configuration is disabled by default and every chain boundary is literal-pinned", () => {
  assert.equal(loadTestConfig().contractAddress, "0x492175c248168ddb9571cbf4c6a14296e3348181");
  assert.equal(loadTestConfig().rpcContractAddress, "0x492175c248168DDB9571CBF4c6A14296e3348181");
  assert.equal(
    MARKETPLACE_DEPLOYMENT_TX_HASH,
    "0x3e3b7e8a10ab46c5e19638c3efd6816d78911d10213188571cbd4393f6494da8",
  );
  assert.equal(loadTestConfig().contractWithdrawalConfirmer, WITHDRAWAL_CONFIRMER);
  for (const patch of [
    { INFLUENCEDX_WITHDRAWAL_RECONCILER_ENABLED: "false" },
    { INFLUENCEDX_GENLAYER_CHAIN_ID: "1" },
    { INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS: `0x${"99".repeat(20)}` },
    { INFLUENCEDX_GENLAYER_MARKETPLACE_WITHDRAWAL_CONFIRMER: `0x${"00".repeat(20)}` },
    { INFLUENCEDX_GENLAYER_MARKETPLACE_WITHDRAWAL_CONFIRMER: `0x${"88".repeat(20)}` },
    { GENLAYER_WITHDRAWAL_CONFIRMER_PRIVATE_KEY: `0x${"00".repeat(32)}` },
    { INFLUENCEDX_GENLAYER_MARKETPLACE_PROTOCOL: "INFLUENCEDX_MARKETPLACE_V1" },
    { INFLUENCEDX_GENLAYER_MARKETPLACE_SCHEMA_VERSION: "1" },
    { INFLUENCEDX_GENLAYER_RPC_URL: "https://attacker.invalid" },
  ]) assert.throws(() => loadTestConfig(validEnv(patch)));
});
