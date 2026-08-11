import assert from "node:assert/strict";
import test from "node:test";
import {
  CampaignRelayClientProblem,
  createCampaignRelayClient,
  type CampaignRelayConfig,
} from "../lib/campaign-relay-client.ts";

const requestId = `0x${"aa".repeat(32)}` as const;
const txHash = `0x${"bb".repeat(32)}` as const;
const config: CampaignRelayConfig = Object.freeze({
  origin: "https://relay.example.test",
  oidcToken: "a.b.c",
  serviceToken: "s".repeat(40),
});

test("campaign relay client sends only requestId through both service-auth layers", async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  const client = createCampaignRelayClient(config, async (url, init) => {
    captured = { url: String(url), init };
    return Response.json({ requestId, status: "CONFIRMED", broadcast: true, txHash, outcome: "PASS" });
  });
  const result = await client.settle(requestId);
  assert.equal(result.txHash, txHash);
  assert.equal(captured!.url, "https://relay.example.test/api/v1/campaign-resolutions");
  const headers = new Headers(captured!.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer a.b.c");
  assert.equal(headers.get("x-vercel-trusted-oidc-idp-token"), "a.b.c");
  assert.equal(headers.get("x-influencedx-service-token"), config.serviceToken);
  assert.deepEqual(JSON.parse(String(captured!.init?.body)), { requestId });
});

test("campaign relay client accepts simulation-only output without claiming settlement", async () => {
  const client = createCampaignRelayClient(config, async () => Response.json({
    requestId,
    status: "SIMULATED",
    broadcast: false,
    txHash: null,
    outcome: "UNDETERMINED",
  }));
  const result = await client.settle(requestId);
  assert.equal(result.status, "SIMULATED");
  assert.equal(result.broadcast, false);
});

test("campaign relay client rejects spoofed IDs, false confirmation, extra fields, and oversized bodies", async () => {
  const bodies = [
    { requestId: `0x${"cc".repeat(32)}`, status: "CONFIRMED", broadcast: true, txHash, outcome: "PASS" },
    { requestId, status: "CONFIRMED", broadcast: false, txHash: null, outcome: "PASS" },
    { requestId, status: "SIMULATED", broadcast: false, txHash: null, outcome: "PASS", signatures: [] },
  ];
  for (const body of bodies) {
    const client = createCampaignRelayClient(config, async () => Response.json(body));
    await assert.rejects(client.settle(requestId), (error: unknown) => error instanceof CampaignRelayClientProblem && error.code === "RELAY_RESPONSE_INVALID");
  }
  const oversized = createCampaignRelayClient(config, async () => new Response("x".repeat(9_000), { status: 200, headers: { "content-type": "application/json" } }));
  await assert.rejects(oversized.settle(requestId), /invalid response/);
});
