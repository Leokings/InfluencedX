// Opt-in HTTP smoke test. Creates and ends empty verification runs; no
// social proofs, campaign writes, or blockchain transactions are performed.
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const origin = new URL(process.argv[2] ?? "http://localhost:3000").origin;
const account = privateKeyToAccount(generatePrivateKey());
const cookies = new Map();
const responses = [];

async function request(path, method = "GET", body) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      accept: "application/json",
      origin,
      "sec-fetch-site": "same-origin",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookies.size ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    const key = pair.slice(0, separator);
    const cookieValue = pair.slice(separator + 1);
    if (/Max-Age=0(?:;|$)/i.test(value)) cookies.delete(key);
    else cookies.set(key, cookieValue);
  }
  const data = await response.json();
  responses.push({ path, method, status: response.status });
  return { status: response.status, data };
}

let activeRun;
let testError;
try {
  const challenge = await request("/api/auth/wallet/challenge", "POST", { wallet: account.address });
  assert.equal(challenge.status, 201);
  assert.equal(challenge.data.authenticated, false);
  const signature = await account.signMessage({ message: challenge.data.message });
  const authorized = await request("/api/auth/wallet/authorize", "POST", { wallet: account.address, signature });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.data.authenticated, true);

  const created = await request("/api/verification/challenge", "POST", { wallet: account.address });
  activeRun = created.data.request;
  assert.equal(created.status, 201);
  assert.equal(activeRun.status, "WALLET_AUTHORIZED");
  assert.equal(created.data.walletChallenge, null);

  const restored = await request("/api/verification/status");
  assert.equal(restored.data.request.id, activeRun.id);
  assert.equal(restored.data.request.status, "WALLET_AUTHORIZED");
  const dashboard = await request("/api/marketplace/dashboard");
  assert.equal(dashboard.status, 200);

  const guardedLogout = await request("/api/auth/wallet/session", "DELETE");
  assert.equal(guardedLogout.status, 409);
  assert.equal(guardedLogout.data.error.code, "ACTIVE_VERIFICATION_EXISTS");
  assert.equal((await request("/api/auth/wallet/session")).data.authenticated, true);

  const staleLogout = await request("/api/verification/session", "DELETE", { requestId: activeRun.id, revision: activeRun.revision + 1 });
  assert.equal(staleLogout.status, 409);
  assert.equal((await request("/api/auth/wallet/session")).data.authenticated, true);

  const logout = await request("/api/verification/session", "DELETE", { requestId: activeRun.id, revision: activeRun.revision });
  assert.equal(logout.status, 200);
  assert.equal(logout.data.ended, true);
  assert.equal(logout.data.authenticated, false);
  activeRun = null;
  assert.equal(cookies.size, 0);
  assert.equal((await request("/api/auth/wallet/session")).data.authenticated, false);
  assert.equal((await request("/api/marketplace/dashboard")).status, 401);
  const unsignedVerify = await request("/api/verification/challenge", "POST", { wallet: account.address });
  activeRun = unsignedVerify.data.request;
  assert.equal(unsignedVerify.status, 201);
  assert.equal(activeRun.status, "WALLET_CHALLENGE_PENDING");
  assert.ok(unsignedVerify.data.walletChallenge?.message);
} catch (error) {
  testError = error;
} finally {
  if (activeRun?.id) {
    try {
      const cleanup = await request("/api/verification/session", "DELETE", { requestId: activeRun.id, revision: activeRun.revision });
      if (cleanup.status !== 200) testError ??= new Error(`Empty test run cleanup failed (${cleanup.status}).`);
    } catch (error) {
      testError ??= error;
    }
  }
}
if (testError) throw testError;
console.log(JSON.stringify({ result: "PASS", origin, signatureCount: 1, blockchainTransactions: 0, responses }, null, 2));
