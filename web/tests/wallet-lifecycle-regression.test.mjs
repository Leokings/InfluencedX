import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { hasNativeVerificationActivationState } from "../lib/verification-native-service.ts";
import * as verificationApi from "../lib/verification-api.ts";
import * as walletSession from "../lib/wallet-session.ts";
import { issueActivationReceiptCapability, readActivationReceiptCapability } from "../lib/activation-receipt-capability.ts";

const deferred = () => { let resolve; const promise = new Promise((accept) => { resolve = accept; }); return { promise, resolve }; };
const wallet = `0x${"12".repeat(20)}`;

// Execute the production hook callbacks with deterministic state/ref storage.
// Only React scheduling, the wallet provider and HTTP transport are replaced.
function walletFixture(options = {}) {
  const slots = []; let cursor = 0;
  const prompts = []; const opened = [];
  const React = {
    createContext: () => ({}), createElement: () => null, useContext: () => null,
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial; return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useCallback: (value) => value, useEffect: () => {},
  };
  const provider = { request: async ({ method }) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [wallet];
    if (method === "eth_chainId") return "0xf22f";
    if (method === "wallet_revokePermissions") return options.revoke?.() ?? null;
    if (method === "personal_sign") {
      const response = deferred(); prompts.push(response); opened.shift()?.resolve(); return response.promise;
    }
    throw new Error(`Unexpected wallet method: ${method}`);
  } };
  const marketplaceRequest = async (path, init) => {
    if (path.endsWith("/challenge")) return { authenticated: false, wallet, message: "test sign-in" };
    if (path.endsWith("/authorize")) { init.signal.throwIfAborted(); return { authenticated: true, wallet }; }
    if (path.endsWith("/session") && init.method === "DELETE") return { authenticated: false, wallet: null };
    throw new Error("Unexpected HTTP request");
  };
  const exports = {};
  const original = readFileSync(new URL("../app/marketplace/use-marketplace-wallet.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(`${original}\nexport const reviewHook = useMarketplaceWalletState;`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, {
    exports, AbortController, TextEncoder, crypto: globalThis.crypto,
    window: { ethereum: provider, localStorage: { setItem() {} } },
    require(name) {
      if (name === "react") return React;
      if (name.includes("marketplace-api")) return { marketplaceRequest };
      if (name.includes("marketplace-types")) return { STUDIONET_CHAIN_ID_HEX: "0xf22f" };
      if (name.includes("activation-outbox")) return { flushActivationReceipts: async () => {} };
      throw new Error(name);
    },
  });
  return {
    render() { cursor = 0; return exports.reviewHook(); }, prompts,
    nextPrompt() { const event = deferred(); opened.push(event); return event.promise; },
  };
}

test("logout clears sign-in busy state without waiting for the wallet prompt", async () => {
  const f = walletFixture(); const opened = f.nextPrompt();
  const pending = f.render().authenticate().catch(() => undefined);
  await opened;
  assert.equal(f.render().authenticating, true);
  await f.render().signOut();
  const loggedOut = f.render();
  assert.equal(loggedOut.authenticating, false);
  assert.equal(loggedOut.connecting, false);
  assert.equal(loggedOut.disconnecting, false);
  assert.equal(loggedOut.authenticated, false);
  f.prompts[0].resolve("old-signature"); await pending;
  assert.equal(f.render().authenticated, false);
});

test("a late old signature cannot clear or authenticate the replacement sign-in", async () => {
  const f = walletFixture(); const firstOpened = f.nextPrompt();
  const first = f.render().authenticate().catch(() => undefined); await firstOpened;
  await f.render().signOut();
  const secondOpened = f.nextPrompt(); const second = f.render().authenticate(); await secondOpened;
  f.prompts[0].resolve("old-signature"); await first;
  assert.equal(f.render().authenticating, true);
  assert.equal(f.render().authenticated, false);
  f.prompts[1].resolve("new-signature"); await second;
  assert.equal(f.render().authenticating, false);
  assert.equal(f.render().authenticated, true);
});

test("logout and reconnect do not wait for a queued wallet permission-revocation prompt", async () => {
  const revocation = deferred();
  const f = walletFixture({ revoke: () => revocation.promise });
  const opened = f.nextPrompt(); const pending = f.render().authenticate().catch(() => undefined); await opened;
  await f.render().signOut();
  assert.equal(f.render().disconnecting, false);
  assert.equal(f.render().authenticating, false);
  const secondOpened = f.nextPrompt(); const second = f.render().authenticate(); await secondOpened;
  revocation.resolve(); f.prompts[0].resolve("stale"); await pending;
  assert.equal(f.render().authenticating, true);
  f.prompts[1].resolve("current"); await second;
  assert.equal(f.render().authenticated, true);
});

function expiryFunction(release) {
  const original = readFileSync(new URL("../lib/verification-native-service.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("service.ts", original, ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "markExpired");
  const compiled = ts.transpileModule(`${declaration.getText(source)}\nexports.markExpired = markExpired;`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, hasNativeVerificationActivationState, releaseExpiredFinalizedUndetermined: release, getDb() { throw new Error("Unexpected unchecked storage mutation"); } });
  return exports.markExpired;
}

test("expired inconclusive activation reaches the finality guard without a detach marker", async () => {
  const row = { status: "X_CHALLENGE_ISSUED", activationPreparedId: "prepared", activationTxHash: "hash", genlayerOutcome: "UNDETERMINED", sessionDetachedAt: null };
  let checked = 0;
  const expire = expiryFunction(async (input) => { assert.equal(input, row); checked += 1; return { ...row, status: "EXPIRED", activeOwnerUserId: null, activeWallet: null }; });
  const result = await expire(row, Date.now());
  assert.equal(checked, 1);
  assert.equal(result.status, "EXPIRED");
  assert.equal(result.activeWallet, null);
});

test("unknown or unfinalized activation still cannot expire without finality proof", async () => {
  const row = { status: "X_CHALLENGE_ISSUED", activationPreparedId: "prepared", activationTxHash: null, sessionDetachedAt: null };
  const expire = expiryFunction(async () => null);
  assert.equal(await expire(row, Date.now()), row);
});

const receiptOptions = { secret: "route-regression-only-secret-at-least-32-bytes", nowMs: Date.parse("2026-09-06T10:00:00Z"), production: false };
const receiptBinding = { preparedId: "22222222-2222-4222-8222-222222222222", requestId: "11111111-1111-4111-8111-111111111111", subject: "a".repeat(43), wallet, contractAddress: wallet };
const receiptHash = `0x${"ab".repeat(32)}`;

function receiptRouteFixture(route) {
  const bound = []; const resumed = [];
  const exports = {};
  const original = readFileSync(new URL(`../app/api/verification/activation/${route}/route.ts`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(original, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, { exports, Response, require(name) {
    if (name.endsWith("verification-api")) return verificationApi;
    if (name.endsWith("wallet-session")) return { ...walletSession, readWalletSession: (request) => walletSession.readWalletSession(request, receiptOptions) };
    if (name.endsWith("activation-receipt-capability")) return { readActivationReceiptCapability: (token, expected) => readActivationReceiptCapability(token, expected, receiptOptions) };
    if (name.endsWith("marketplace-genlayer-rpc")) return { marketplaceContractAddress: () => wallet };
    if (name.endsWith("verification-rate-limit")) return { enforceVerificationRateLimit: async () => {} };
    if (name.endsWith("marketplace-genlayer-activation")) return {
      bindGenLayerIdentityBundleActivationSubmission: async (input) => { bound.push(input); return { accepted: true, preparedId: input.preparedId, txHash: input.txHash }; },
      resumeGenLayerIdentityBundlePreparation: async (input) => { resumed.push(input); return { preparedId: input.preparedId }; },
    };
    throw new Error(name);
  } });
  return { bound, resumed, post: (body, headers = {}) => exports.POST(new Request(`http://localhost:3000/api/verification/activation/${route}`, {
    method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  })) };
}

test("the receipt endpoint works signed out but never sets cookies or accepts a broader payload", async () => {
  const f = receiptRouteFixture("submitted");
  const token = issueActivationReceiptCapability(receiptBinding, receiptOptions);
  const body = { preparedId: receiptBinding.preparedId, txHash: receiptHash, submissionToken: token };
  assert.equal((await f.post({ preparedId: body.preparedId, txHash: body.txHash })).status, 401);
  assert.equal((await f.post({ ...body, preparedId: receiptBinding.requestId })).status, 401);
  assert.equal((await f.post({ ...body, wallet })).status, 400);
  assert.equal((await f.post(body, { origin: "https://attacker.test" })).status, 403);
  assert.equal(f.bound.length, 0);
  const response = await f.post(body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(await response.json(), { accepted: true, preparedId: body.preparedId, txHash: body.txHash });
  assert.equal(f.bound[0].receiptRequestId, receiptBinding.requestId);
  assert.equal(f.bound[0].session.subject, receiptBinding.subject);
  assert.equal(f.bound[0].session.wallet, wallet);
});

test("a receipt capability cannot resume a prepared call; wallet authentication remains required", async () => {
  const f = receiptRouteFixture("prepared");
  const token = issueActivationReceiptCapability(receiptBinding, receiptOptions);
  const body = { preparedId: receiptBinding.preparedId, requestId: receiptBinding.requestId };
  assert.equal((await f.post(body)).status, 401);
  assert.equal((await f.post(body, { cookie: `${walletSession.walletSessionCookieName(false)}=${token}` })).status, 401);
  assert.equal((await f.post({ ...body, submissionToken: token })).status, 400);
  assert.equal(f.resumed.length, 0);
  const session = walletSession.authenticateWalletSession(walletSession.createPendingWalletSession(receiptOptions), wallet, receiptOptions);
  const cookie = walletSession.attachWalletSessionCookie(new Response(), session, receiptOptions).headers.get("set-cookie").split(";", 1)[0];
  assert.equal((await f.post(body, { cookie })).status, 200);
  assert.equal(f.resumed[0].session.wallet, wallet);
  assert.equal(f.resumed[0].requestId, body.requestId);
  assert.equal(f.resumed[0].preparedId, body.preparedId);
});
