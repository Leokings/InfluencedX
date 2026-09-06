import assert from "node:assert/strict";
import test from "node:test";
import { activationAttemptRecovery, activationOutboxKey, clearActivationAttempt, readActivationAttempt, runDurableActivation, submitActivationReceipt, type ActivationAttempt, type ActivationPreparation } from "../app/verify/activation-outbox.ts";
import { issueActivationReceiptCapability, readActivationReceiptCapability } from "../lib/activation-receipt-capability.ts";
import { readWalletSession, walletSessionCookieName } from "../lib/wallet-session.ts";
import { abi } from "genlayer-js";
import { assertTransactionMatchesPreparedCall, loadSubmittedMarketplaceTransaction, type MarketplaceGenLayerCall } from "../lib/marketplace-genlayer-rpc.ts";

const wallet = `0x${"12".repeat(20)}`;
const requestId = "11111111-1111-4111-8111-111111111111";
const preparedId = "22222222-2222-4222-8222-222222222222";
const txHash = `0x${"ab".repeat(32)}`;
const transaction = { network: "studionet", chainId: 61_999, contractAddress: wallet, functionName: "activate_identity_bundle", args: [], argTypes: [], value: "0" } as ActivationPreparation["transaction"];
const prepared = { preparedId, transaction, submissionToken: "receipt-only-test-token" };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  let held = false;
  const locks = { request: async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => {
    if (held) return callback(null);
    held = true;
    try { return await callback({}); } finally { held = false; }
  } } as unknown as Pick<LockManager, "request">;
  let current = true;
  let preparations = 0;
  let resumes = 0;
  let broadcasts = 0;
  const receipts: ActivationAttempt[] = [];
  const input: Parameters<typeof runDurableActivation>[0] = {
    wallet, requestId, storage, locks, isCurrent: () => current,
    prepare: async () => { preparations += 1; return prepared; },
    resume: async (id) => { assert.equal(id, preparedId); resumes += 1; return prepared; },
    broadcast: async (_prepared, callbacks) => { callbacks.beforeWalletRequest(); broadcasts += 1; await callbacks.onSubmitted(txHash); return txHash; },
    record: async (attempt) => { receipts.push(attempt); },
  };
  return { input, values, storage, receipts, disconnect: () => { current = false; }, reconnect: () => { current = true; }, counts: () => ({ preparations, resumes, broadcasts }) };
}

test("logout during preparation saves READY and reconnect resumes the exact original call", async () => {
  const f = fixture();
  const started = deferred(); const response = deferred<ActivationPreparation>();
  const pending = runDurableActivation({ ...f.input, prepare: async () => { started.resolve(); return response.promise; } });
  await started.promise; f.disconnect(); response.resolve(prepared);
  assert.equal(await pending, null);
  assert.equal(readActivationAttempt(wallet, requestId, f.storage)?.phase, "ready");
  assert.equal(f.counts().broadcasts, 0);
  f.reconnect();
  assert.deepEqual(await runDurableActivation(f.input), { preparedId, requestId, txHash });
  assert.deepEqual(f.counts(), { preparations: 0, resumes: 1, broadcasts: 1 });
});

test("a hash arriving after logout is durable and delivered to the server without the UI", async () => {
  const f = fixture(); const signing = deferred(); const reply = deferred();
  const pending = runDurableActivation({ ...f.input, broadcast: async (_prepared, callbacks) => {
    callbacks.beforeWalletRequest(); signing.resolve(); await reply.promise;
    await callbacks.onSubmitted(txHash); return txHash;
  } });
  await signing.promise; f.disconnect(); reply.resolve(); await pending;
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0].txHash, txHash);
  assert.deepEqual(activationAttemptRecovery(readActivationAttempt(wallet, requestId, f.storage)), { preparedId, requestId, txHash });
  f.reconnect(); await runDurableActivation(f.input);
  assert.deepEqual(f.counts(), { preparations: 1, resumes: 0, broadcasts: 0 }, "reopening must recover, not rebroadcast");
});

test("a pending wallet request cannot be resent after a reload", async () => {
  const f = fixture();
  await assert.rejects(runDurableActivation({ ...f.input, broadcast: async (_prepared, callbacks) => { callbacks.beforeWalletRequest(); throw new Error("wallet response lost"); } }), /response lost/);
  assert.equal(readActivationAttempt(wallet, requestId, f.storage)?.phase, "wallet");
  await assert.rejects(runDurableActivation(f.input), /do not resend/);
  assert.equal(f.counts().broadcasts, 0);
});

test("only an explicit wallet rejection makes the same intent READY again", async () => {
  const f = fixture();
  await assert.rejects(runDurableActivation({ ...f.input, broadcast: async (_prepared, callbacks) => { callbacks.beforeWalletRequest(); throw Object.assign(new Error("rejected"), { code: 4001 }); } }));
  assert.equal(readActivationAttempt(wallet, requestId, f.storage)?.phase, "ready");
  await runDurableActivation(f.input);
  assert.equal(f.counts().resumes, 1);
});

test("logout during SDK loading never opens a new wallet prompt", async () => {
  const f = fixture();
  await assert.rejects(runDurableActivation({ ...f.input, broadcast: async (_prepared, callbacks) => { f.disconnect(); callbacks.beforeWalletRequest(); throw new Error("must not send"); } }), /prepared verification is saved/);
  assert.equal(readActivationAttempt(wallet, requestId, f.storage)?.phase, "ready");
});

test("two tabs cannot prepare or broadcast the same verification concurrently", async () => {
  const f = fixture(); const started = deferred(); const response = deferred<ActivationPreparation>();
  const first = runDurableActivation({ ...f.input, prepare: async () => { started.resolve(); return response.promise; } });
  await started.promise;
  await assert.rejects(runDurableActivation(f.input), /another tab/);
  response.resolve(prepared); await first;
  assert.equal(f.counts().broadcasts, 1);
});

test("storage failure after submission cannot prevent the durable server receipt", async () => {
  const f = fixture();
  const storage = { ...f.storage, setItem(key: string, value: string) { if (value.includes('"phase":"submitted"')) throw new Error("quota"); f.storage.setItem(key, value); } };
  await assert.rejects(runDurableActivation({ ...f.input, storage }), /quota/);
  assert.equal(f.receipts.length, 1);
});

test("storage must be writable before reserving an activation", async () => {
  const f = fixture();
  await assert.rejects(runDurableActivation({ ...f.input, storage: { ...f.storage, setItem() { throw new Error("blocked"); } } }), /blocked/);
  assert.equal(f.counts().preparations, 0);
});

test("late cleanup and changed prepared IDs cannot overwrite another attempt", async () => {
  const f = fixture(); f.disconnect();
  f.storage.setItem(activationOutboxKey(wallet, requestId), JSON.stringify({ version: 1, wallet, requestId, preparedId, phase: "ready", submissionToken: prepared.submissionToken, txHash: null }));
  clearActivationAttempt(wallet, requestId, "33333333-3333-4333-8333-333333333333", f.storage);
  assert.ok(readActivationAttempt(wallet, requestId, f.storage));
  f.reconnect();
  await assert.rejects(runDurableActivation({ ...f.input, resume: async () => ({ ...prepared, preparedId: "33333333-3333-4333-8333-333333333333" }) }), /intent changed/);
});

test("receipt capability is exact-operation scoped, tamper-proof, and expires", () => {
  const nowMs = Date.parse("2026-09-06T10:00:00Z");
  const options = { nowMs, secret: "test-only-activation-capability-secret" };
  const binding = { preparedId, requestId, subject: "a".repeat(43), wallet, contractAddress: wallet };
  const token = issueActivationReceiptCapability(binding, options);
  assert.deepEqual(readActivationReceiptCapability(token, binding, options), binding);
  assert.throws(() => readActivationReceiptCapability(`${token}x`, binding, options), /Sign in again/);
  assert.throws(() => readActivationReceiptCapability(token, { ...binding, preparedId: "33333333-3333-4333-8333-333333333333" }, options));
  assert.throws(() => readActivationReceiptCapability(token, { ...binding, contractAddress: `0x${"34".repeat(20)}` }, options));
  assert.throws(() => readActivationReceiptCapability(token, binding, { ...options, nowMs: nowMs + 86_400_000 }));
  assert.throws(() => readActivationReceiptCapability(token, binding, { ...options, secret: "another-test-only-capability-secret" }));
  const [payload, mac] = token.split(".");
  const changed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); changed.wallet = `0x${"34".repeat(20)}`;
  assert.throws(() => readActivationReceiptCapability(`${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${mac}`, binding, options));
  const request = new Request("https://example.test/api/auth/wallet/session", { headers: { cookie: `${walletSessionCookieName(false)}=${token}` } });
  assert.equal(readWalletSession(request, { ...options, production: false }), null, "receipt capability must never authenticate a wallet session");
});

test("receipt replay omits credentials and marks delivery only after an exact server acknowledgement", async () => {
  const f = fixture(); await runDurableActivation(f.input);
  const attempt = readActivationAttempt(wallet, requestId, f.storage)!;
  const acknowledged = { accepted: true, preparedId, txHash };
  for (const body of [{}, { ...acknowledged, accepted: false }, { ...acknowledged, preparedId: requestId }, { ...acknowledged, txHash: `0x${"cd".repeat(32)}` }]) {
    await assert.rejects(submitActivationReceipt(attempt, { storage: f.storage, fetcher: async () => Response.json(body) }), /receipt is saved/);
    assert.notEqual(readActivationAttempt(wallet, requestId, f.storage)?.receiptRecorded, true);
  }
  await assert.rejects(submitActivationReceipt(attempt, { storage: f.storage, fetcher: async () => Response.json(acknowledged, { status: 503 }) }));
  await submitActivationReceipt(attempt, { storage: f.storage, fetcher: async (path, init) => {
    assert.equal(path, "/api/verification/activation/submitted");
    assert.equal(init?.credentials, "omit"); assert.equal(init?.keepalive, true);
    assert.deepEqual(JSON.parse(String(init?.body)), { preparedId, txHash, submissionToken: prepared.submissionToken });
    return Response.json(acknowledged);
  } });
  assert.equal(readActivationAttempt(wallet, requestId, f.storage)?.receiptRecorded, true);
});

test("malformed recovery data never becomes permission to prepare a fresh transaction", async () => {
  const f = fixture();
  for (const raw of ["bad json", "null", JSON.stringify({ ...prepared, version: 1, wallet, requestId, phase: "wallet", txHash })]) {
    f.storage.setItem(activationOutboxKey(wallet, requestId), raw);
    await assert.rejects(runDurableActivation(f.input), /invalid.*Do not resend/);
  }
  assert.equal(f.counts().preparations, 0);
  assert.equal(f.counts().broadcasts, 0);
});

test("a pending receipt must match the actual sender, contract, calldata and native value", async () => {
  const call: MarketplaceGenLayerCall = { ...transaction, contractAddress: wallet as `0x${string}`, args: [requestId], argTypes: ["string"] };
  const encoded = abi.transactions.serialize([abi.calldata.encode(abi.calldata.makeCalldataObject(call.functionName, [...call.args], undefined)), false]);
  const actual = await loadSubmittedMarketplaceTransaction(txHash, {
    getTransaction: async () => ({ status_name: "PENDING", from_address: wallet, to_address: wallet, tx_data: encoded.slice(2) }),
  } as never, async () => "0");
  assert.doesNotThrow(() => assertTransactionMatchesPreparedCall({ transaction: actual, call, actorWallet: wallet }));
  for (const change of [{ sender: `0x${"34".repeat(20)}` }, { recipient: `0x${"34".repeat(20)}` }, { functionName: "withdraw" }, { args: [preparedId] }, { args: null }, { valueAtto: "1" }]) {
    assert.throws(() => assertTransactionMatchesPreparedCall({ transaction: { ...actual, ...change }, call, actorWallet: wallet }));
  }
  await assert.rejects(loadSubmittedMarketplaceTransaction(txHash, { getTransaction: async () => null } as never, async () => "0"));
});
