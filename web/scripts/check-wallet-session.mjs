// Opt-in HTTP smoke test. Creates and ends empty verification runs; no
// social proofs, campaign writes, or blockchain transactions are performed.
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const origin = new URL(process.argv[2] ?? "http://localhost:3000").origin;
const account = privateKeyToAccount(generatePrivateKey());
const otherAccount = privateKeyToAccount(generatePrivateKey());
const cookies = new Map();
const responses = [];
let signatureCount = 0;

async function request(path, method = "GET", body, jar = cookies) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      accept: "application/json",
      origin,
      "sec-fetch-site": "same-origin",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(jar.size ? { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; ") } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    const key = pair.slice(0, separator);
    const cookieValue = pair.slice(separator + 1);
    if (/Max-Age=0(?:;|$)/i.test(value)) jar.delete(key);
    else jar.set(key, cookieValue);
  }
  const data = await response.json();
  responses.push({ path, method, status: response.status });
  return { status: response.status, data };
}

let activeRun;
let testError;
async function signIn(signer = account) {
  const challenge = await request("/api/auth/wallet/challenge", "POST", { wallet: signer.address });
  assert.ok([200, 201].includes(challenge.status));
  assert.equal(challenge.data.authenticated, false);
  const signature = await signer.signMessage({ message: challenge.data.message });
  signatureCount += 1;
  const authorized = await request("/api/auth/wallet/authorize", "POST", { wallet: signer.address, signature });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.data.authenticated, true);
}
try {
  const unsigned = await request("/api/verification/challenge", "POST", { wallet: account.address });
  assert.equal(unsigned.status, 201);
  activeRun = unsigned.data.request;
  assert.equal(activeRun.status, "WALLET_CHALLENGE_PENDING");
  const oldPendingCookies = new Map(cookies);
  await signIn();
  const created = await request("/api/verification/challenge", "POST", { wallet: account.address });
  assert.equal(created.status, 201);
  activeRun = created.data.request;
  assert.equal(activeRun.status, "WALLET_AUTHORIZED");
  assert.equal(created.data.walletChallenge, null);

  const restored = await request("/api/verification/status");
  assert.equal(restored.data.request.id, activeRun.id);
  assert.equal(restored.data.request.status, "WALLET_AUTHORIZED");
  const dashboard = await request("/api/marketplace/dashboard");
  assert.equal(dashboard.status, 200);

  const logout = await request("/api/auth/wallet/session", "DELETE");
  assert.equal(logout.status, 200);
  assert.equal(logout.data.authenticated, false);
  assert.equal(cookies.size, 0);
  assert.equal((await request("/api/auth/wallet/session")).data.authenticated, false);
  assert.equal((await request("/api/marketplace/dashboard")).status, 401);
  assert.equal((await request("/api/verification/status")).data.request, null);

  assert.equal((await request("/api/verification/status", "GET", undefined, oldPendingCookies)).data.request, null);
  assert.equal((await request("/api/verification/challenge", "POST", { wallet: account.address }, oldPendingCookies)).status, 401);
  assert.equal((await request("/api/verification/session", "DELETE", { requestId: activeRun.id, revision: activeRun.revision }, oldPendingCookies)).status, 401);

  await signIn(otherAccount);
  assert.equal((await request(`/api/verification/status?requestId=${activeRun.id}`)).data.request, null);
  assert.equal((await request("/api/verification/session", "DELETE", { requestId: activeRun.id, revision: activeRun.revision })).status, 404);
  assert.equal((await request("/api/auth/wallet/session", "DELETE")).status, 200);

  await signIn();
  const resumed = await request("/api/verification/status");
  assert.equal(resumed.data.request.id, activeRun.id);
  assert.equal(resumed.data.request.status, activeRun.status);
  assert.equal(resumed.data.request.revision, activeRun.revision);
  assert.equal((await request("/api/verification/challenge", "POST", { wallet: account.address })).data.request.id, activeRun.id);
  assert.equal((await request("/api/verification/session", "DELETE", { requestId: activeRun.id, revision: activeRun.revision + 1 })).status, 409);
} catch (error) {
  testError = error;
} finally {
  if (activeRun?.id) {
    try {
      const session = await request("/api/auth/wallet/session");
      if (!session.data.authenticated || session.data.wallet !== account.address.toLowerCase()) {
        await request("/api/auth/wallet/session", "DELETE");
        await signIn();
      }
      const cleanup = await request("/api/verification/session", "DELETE", { requestId: activeRun.id, revision: activeRun.revision });
      if (cleanup.status !== 200) testError ??= new Error(`Empty test run cleanup failed (${cleanup.status}).`);
    } catch (error) {
      testError ??= error;
    }
  }
}
if (testError) throw testError;
console.log(JSON.stringify({ result: "PASS", origin, signatureCount, blockchainTransactions: 0, responses }, null, 2));
