import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../lib/config";
import {
  assertEnvelopeIntegrity,
  validateOperationRequest,
  validateQueueMessage,
} from "../lib/envelope";
import { MARKETPLACE_DEPLOYMENT_TX_HASH } from "../lib/constants";
import { PoisonMessageError } from "../lib/problem";
import {
  ASSIGNMENT_ID,
  CAMPAIGN_ID,
  configFixture,
  REQUEST_ID,
  resolveEnvelope,
  validEnv,
} from "./helpers";

test("only the three exact zero-value method shapes are accepted", () => {
  const config = configFixture();
  const cases = [
    { schemaVersion: 1, action: "resolve_assignment", assignmentId: ASSIGNMENT_ID, requestId: REQUEST_ID },
    { schemaVersion: 1, action: "expire_assignment", assignmentId: ASSIGNMENT_ID },
    { schemaVersion: 1, action: "finalize_campaign", campaignId: CAMPAIGN_ID },
  ];
  for (const value of cases) {
    const envelope = validateOperationRequest(value, config);
    assert.equal(envelope.valueAtto, "0");
    assert.equal(envelope.contractAddress, config.contractAddress);
    assertEnvelopeIntegrity(envelope);
  }
});

test("callers cannot inject a target, method, value, or arbitrary arguments", () => {
  const base = {
    schemaVersion: 1,
    action: "resolve_assignment",
    assignmentId: ASSIGNMENT_ID,
    requestId: REQUEST_ID,
  };
  for (const patch of [
    { target: `0x${"99".repeat(20)}` },
    { method: "request_withdrawal" },
    { value: "1" },
    { args: [ASSIGNMENT_ID] },
  ]) {
    assert.throws(() => validateOperationRequest({ ...base, ...patch }, configFixture()));
  }
  assert.throws(() => validateOperationRequest({ ...base, action: "request_withdrawal" }, configFixture()));
});

test("queue poison is rejected before any durable lookup", () => {
  for (const value of [
    null,
    {},
    { schemaVersion: 2, operationId: resolveEnvelope().operationId },
    { schemaVersion: 1, operationId: resolveEnvelope().operationId, target: "attacker" },
    { schemaVersion: 1, operationId: `0x${"AA".repeat(32)}` },
  ]) {
    assert.throws(() => validateQueueMessage(value), PoisonMessageError);
  }
});

test("operator configuration is disabled by default and pins the V2 checksum RPC address", () => {
  assert.throws(() => loadConfig(validEnv({ INFLUENCEDX_MARKETPLACE_OPERATOR_ENABLED: "false" })));
  const config = loadConfig(validEnv());
  assert.equal(config.chainId, 61_999);
  assert.equal(config.contractAddress, configFixture().contractAddress);
  assert.equal(config.contractAddress, "0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb");
  assert.equal(config.rpcContractAddress, "0xb72FE7272A5aEdf3c6Ba893394EbeF818fd86Fbb");
  assert.equal(
    MARKETPLACE_DEPLOYMENT_TX_HASH,
    "0x05ff78998a2b389c7e102f6f09b893dbd16d376f3c18f9748b2b8ef9de5e7998",
  );
  assert.throws(() => loadConfig(validEnv({ INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS: `0x${"0".repeat(40)}` })));
});
