import assert from "node:assert/strict";
import test from "node:test";
import { buildWatcherRequest, requestWatcherSignatures } from "../lib/watcher-client";
import {
  configFixture,
  contextFixture,
  signaturesFixture,
} from "./helpers";

test("coordinator sends only the exact binding through OIDC plus per-watcher service tokens", async () => {
  const config = configFixture();
  const signatures = await signaturesFixture();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const response = await requestWatcherSignatures({
    request: buildWatcherRequest(contextFixture(), config.escrow),
    config,
    oidcToken: "a.b.c",
    fetchImplementation: async (url, init) => {
      calls.push({ url: String(url), init });
      const index = config.watchers.findIndex((watcher) => String(url).startsWith(watcher.origin));
      return Response.json({ signature: signatures[index] });
    },
  });
  assert.equal(response.length, 3);
  assert.equal(calls.length, 3);
  calls.forEach((call, index) => {
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("authorization"), "Bearer a.b.c");
    assert.equal(headers.get("x-vercel-trusted-oidc-idp-token"), "a.b.c");
    assert.equal(headers.get("x-influencedx-service-token"), config.watchers[index]!.serviceToken);
    const body = JSON.parse(String(call.init?.body));
    assert.deepEqual(Object.keys(body).sort(), ["binding", "genlayerTxHash", "requestId", "schemaVersion"]);
  });
});

test("malformed, oversized, or signer-swapped watcher responses are discarded", async () => {
  const config = configFixture();
  const signatures = await signaturesFixture();
  const response = await requestWatcherSignatures({
    request: buildWatcherRequest(contextFixture(), config.escrow),
    config,
    oidcToken: "a.b.c",
    fetchImplementation: async (url) => {
      const index = config.watchers.findIndex((watcher) => String(url).startsWith(watcher.origin));
      if (index === 0) return Response.json({ signature: signatures[0] });
      if (index === 1) return Response.json({ signature: signatures[0] });
      return new Response("x".repeat(40_000), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(response.length, 1);
  assert.equal(response[0]!.signer, signatures[0]!.signer);
});
