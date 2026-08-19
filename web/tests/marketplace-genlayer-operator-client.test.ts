import assert from "node:assert/strict";
import test from "node:test";

import {
  GenLayerOperatorClientProblem,
  createGenLayerOperatorClient,
} from "../lib/marketplace-genlayer-operator-client.ts";

const assignmentId = `0x${"11".repeat(32)}`;
const requestId = `0x${"22".repeat(32)}`;
const operationId = `0x${"33".repeat(32)}`;
const contract = `0x${"44".repeat(20)}`;
const txHash = `0x${"55".repeat(32)}`;

test("operator client submits only deterministic IDs with both service auth layers", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const client = createGenLayerOperatorClient(
    {
      origin: "https://operator.example",
      oidcToken: "header.payload.signature",
      serviceToken: "ab".repeat(32),
    },
    (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return jsonResponse({ replayed: false, operation: projection() }, 202);
    }) as typeof fetch,
  );
  const result = await client.submit({
    schemaVersion: 1,
    action: "resolve_assignment",
    assignmentId,
    requestId,
  });
  assert.equal(result.operation.operationId, operationId);
  assert.ok(captured);
  const request = captured as { url: string; init: RequestInit };
  assert.equal(request.url, "https://operator.example/v1/operations");
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get("authorization"), "Bearer header.payload.signature");
  assert.equal(headers.get("x-influencedx-service-token"), "ab".repeat(32));
  assert.deepEqual(JSON.parse(String(request.init.body)), {
    schemaVersion: 1,
    action: "resolve_assignment",
    assignmentId,
    requestId,
  });
});

test("operator client rejects extra request fields and malformed terminal projections", async () => {
  const client = createGenLayerOperatorClient(
    {
      origin: "https://operator.example",
      oidcToken: "header.payload.signature",
      serviceToken: "ab".repeat(32),
    },
    (async () =>
      jsonResponse({
        operation: { ...projection(), status: "FINALIZED", txHash: null },
      })) as typeof fetch,
  );
  await assert.rejects(
    client.submit({
      schemaVersion: 1,
      action: "expire_assignment",
      assignmentId,
      extra: "attacker",
    } as never),
    GenLayerOperatorClientProblem,
  );
  await assert.rejects(client.get(operationId), GenLayerOperatorClientProblem);
});

test("operator client accepts finalized status only with exact transaction binding", async () => {
  const client = createGenLayerOperatorClient(
    {
      origin: "https://operator.example",
      oidcToken: "header.payload.signature",
      serviceToken: "ab".repeat(32),
    },
    (async () => jsonResponse({ operation: projection() })) as typeof fetch,
  );
  const result = await client.get(operationId);
  assert.equal(result.status, "FINALIZED");
  assert.equal(result.txHash, txHash);
});

function projection() {
  const now = "2026-08-19T12:00:00.000Z";
  return {
    operationId,
    network: "studionet",
    chainId: 61_999,
    contractAddress: contract,
    action: "resolve_assignment",
    functionName: "resolve_assignment",
    valueAtto: "0",
    preStateFingerprint: `0x${"66".repeat(32)}`,
    postStateFingerprint: `0x${"77".repeat(32)}`,
    status: "FINALIZED",
    lifecycleStatus: "FINALIZED",
    executionResult: "SUCCESS",
    txHash,
    queueMessageId: "queue-message",
    enqueueAttempts: 1,
    deliveryCount: 1,
    pollAttempts: 1,
    errorCode: null,
    broadcastStartedAt: now,
    submittedAt: now,
    lastPolledAt: now,
    finalizedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
