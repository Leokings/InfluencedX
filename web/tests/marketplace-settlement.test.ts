import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertUnallocatedCreditPostState,
  assertWithdrawalPostState,
} from "../lib/marketplace-settlement-validation.ts";

const chainCampaign = Object.freeze({
  brand: "0x1111111111111111111111111111111111111111" as const,
  termsHash: `0x${"22".repeat(32)}` as `0x${string}`,
  deposited: 100n,
  allocated: 30n,
  disbursed: 40n,
  unallocatedWithdrawn: 30n,
  applicationDeadline: 100n,
  selectionDeadline: 200n,
  submissionDeadline: 300n,
  retentionSeconds: 10n,
});

test("withdrawal confirmation requires zero claimable balance at the receipt block", () => {
  assert.doesNotThrow(() => assertWithdrawalPostState(0n));
  assert.throws(
    () => assertWithdrawalPostState(1n),
    (error: unknown) => error instanceof Error &&
      "code" in error &&
      error.code === "WITHDRAWAL_POST_STATE_MISMATCH",
  );
  assert.throws(() => assertWithdrawalPostState("0"), /zero claimable/);
});

test("unused-budget confirmation binds the event amount to exhausted campaign accounting", () => {
  assert.doesNotThrow(() => assertUnallocatedCreditPostState({
    campaign: chainCampaign,
    creditedAmount: 30n,
  }));
  assert.throws(() => assertUnallocatedCreditPostState({
    campaign: { ...chainCampaign, unallocatedWithdrawn: 20n },
    creditedAmount: 20n,
  }), /post-transaction escrow state/);
  assert.throws(() => assertUnallocatedCreditPostState({
    campaign: chainCampaign,
    creditedAmount: 31n,
  }), /post-transaction escrow state/);
  assert.throws(() => assertUnallocatedCreditPostState({
    campaign: chainCampaign,
    creditedAmount: 0n,
  }), /post-transaction escrow state/);
  assert.throws(() => assertUnallocatedCreditPostState({
    campaign: { ...chainCampaign, allocated: 101n },
    creditedAmount: 1n,
  }), /accounting is invalid/);
});

test("settlement routes require wallet sessions, exact bodies, and receipt-backed confirmation", async () => {
  const [prepareSource, confirmSource, serviceSource] = await Promise.all([
    readFile(new URL("../app/api/marketplace/campaigns/[campaignId]/settlement/withdraw/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/marketplace/campaigns/[campaignId]/settlement/withdraw/confirm/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/marketplace-settlement.ts", import.meta.url), "utf8"),
  ]);
  assert.match(prepareSource, /requireMarketplaceSession\(request\)/);
  assert.match(prepareSource, /Object\.keys\(body\)\.length !== 0/);
  assert.match(confirmSource, /Object\.keys\(body\)\.length !== 1/);
  assert.match(confirmSource, /"txHash" in body/);
  assert.match(serviceSource, /assertExactMarketplaceCall\(transaction, call, context\.actor\)/);
  assert.match(serviceSource, /blockNumber: transaction\.blockNumber/);
  assert.match(serviceSource, /assertWithdrawalPostState\(claimableAfter\)/);
  assert.doesNotMatch(serviceSource, /status:\s*["'](?:paid|refunded)["']/i);
});
