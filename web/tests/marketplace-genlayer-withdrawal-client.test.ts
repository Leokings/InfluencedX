import assert from "node:assert/strict";
import test from "node:test";

import {
  WithdrawalReconcilerClientProblem,
  createWithdrawalReconcilerClient,
} from "../lib/marketplace-genlayer-withdrawal-client.ts";

const withdrawalId = `0x${"11".repeat(32)}`;
const contractAddress = "0x492175c248168ddb9571cbf4c6a14296e3348181";
const withdrawalConfirmer = "0xaafc5d9075a404d82b8ee1692f7ff802168c5dd8";
const now = "2026-08-19T12:00:00.000Z";

function projection(overrides: Record<string, unknown> = {}) {
  return {
    withdrawalId,
    network: "studionet",
    chainId: 61_999,
    contractAddress,
    withdrawalConfirmer,
    functionName: "confirm_withdrawal",
    valueAtto: "0",
    status: "QUEUED",
    evidenceHash: null,
    transferParentTxHash: null,
    transferChildTxHash: null,
    confirmationTxHash: null,
    lifecycleStatus: null,
    executionResult: null,
    queueMessageId: null,
    enqueueAttempts: 1,
    deliveryCount: 0,
    discoveryAttempts: 0,
    pollAttempts: 0,
    errorCode: null,
    broadcastStartedAt: null,
    submittedAt: null,
    lastCheckedAt: null,
    finalizedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("withdrawal client submits only the immutable ID through both service auth layers", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const client = createWithdrawalReconcilerClient(
    { origin: "https://withdrawals.example.test", oidcToken: "a.b.c", serviceToken: "ab".repeat(32) },
    async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Response.json({ replayed: false, reconciliation: projection() }, { status: 202 });
    },
  );
  const result = await client.submit(withdrawalId);
  assert.equal(result.reconciliation.status, "QUEUED");
  assert.equal(capturedUrl, "https://withdrawals.example.test/v1/withdrawals/reconciliations");
  assert.equal(capturedInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), { schemaVersion: 1, withdrawalId });
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer a.b.c");
  assert.equal(headers["x-vercel-trusted-oidc-idp-token"], "a.b.c");
  assert.equal(headers["x-influencedx-withdrawal-service-token"], "ab".repeat(32));
  assert.doesNotMatch(String(capturedInit?.body), /amount|recipient|method|transaction|evidence/i);
});

test("withdrawal client accepts FINALIZED only with exact delivery evidence", async () => {
  const finalized = projection({
    status: "FINALIZED",
    evidenceHash: `0x${"22".repeat(32)}`,
    transferParentTxHash: `0x${"33".repeat(32)}`,
    transferChildTxHash: `0x${"44".repeat(32)}`,
    confirmationTxHash: `0x${"55".repeat(32)}`,
    lifecycleStatus: "FINALIZED",
    executionResult: "SUCCESS",
    finalizedAt: now,
  });
  const client = createWithdrawalReconcilerClient(
    { origin: "https://withdrawals.example.test", oidcToken: "a.b.c", serviceToken: "ab".repeat(32) },
    async () => Response.json({ reconciliation: finalized }),
  );
  assert.equal((await client.get(withdrawalId)).status, "FINALIZED");

  const invalidClient = createWithdrawalReconcilerClient(
    { origin: "https://withdrawals.example.test", oidcToken: "a.b.c", serviceToken: "ab".repeat(32) },
    async () => Response.json({ reconciliation: projection({ status: "FINALIZED" }) }),
  );
  await assert.rejects(
    () => invalidClient.get(withdrawalId),
    (error: unknown) => error instanceof WithdrawalReconcilerClientProblem &&
      error.code === "WITHDRAWAL_RECONCILER_RESPONSE_INVALID",
  );
});

test("withdrawal client rejects a changed deployment or extra response fields", async () => {
  for (const changed of [
    projection({ contractAddress: `0x${"66".repeat(20)}` }),
    projection({ extra: true }),
    projection({ withdrawalId: `0x${"77".repeat(32)}` }),
  ]) {
    const client = createWithdrawalReconcilerClient(
      { origin: "https://withdrawals.example.test", oidcToken: "a.b.c", serviceToken: "ab".repeat(32) },
      async () => Response.json({ replayed: true, reconciliation: changed }),
    );
    await assert.rejects(() => client.submit(withdrawalId));
  }
});
