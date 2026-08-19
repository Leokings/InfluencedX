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
  const [prepareSource, confirmSource, actionSource] = await Promise.all([
    readFile(new URL("../app/api/marketplace/campaigns/[campaignId]/settlement/withdraw/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/marketplace/campaigns/[campaignId]/settlement/withdraw/confirm/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/marketplace-genlayer-actions.ts", import.meta.url), "utf8"),
  ]);
  assert.match(prepareSource, /requireMarketplaceSession\(request\)/);
  assert.match(prepareSource, /Object\.keys\(body\)\.length !== 0/);
  assert.match(confirmSource, /requireMarketplaceSession\(request\)/);
  assert.match(confirmSource, /confirmGenLayerWithdrawal/);
  assert.match(actionSource, /assertExactJsonKeys\(body, \["preparedId", "txHash"\]\)/);
  assert.match(actionSource, /assertTransactionMatchesPreparedCall\(\{ transaction: finalized, call, actorWallet: actor \}\)/);
  assert.match(actionSource, /parseWithdrawalState\(await readMarketplaceState\("get_withdrawal"/);
  assert.match(actionSource, /withdrawal\.status !== "PENDING"/);
  assert.match(actionSource, /withdrawal\.status !== "EMITTED_UNCONFIRMED"/);
  assert.doesNotMatch(actionSource, /status:\s*["'](?:paid|refunded)["']/i);
});
