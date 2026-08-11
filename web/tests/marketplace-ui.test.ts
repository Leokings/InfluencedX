import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  fundingStatusLabel,
  usdcAtomsToDisplay,
  usdcInputToAtoms,
} from "../app/marketplace/marketplace-types.ts";
import {
  MarketplaceApiError,
  marketplaceErrorMessage,
} from "../app/marketplace/marketplace-api.ts";
import {
  classifyCreatorMetrics,
  MAX_CREATOR_METRICS_CONCURRENCY,
  normalizeCreatorMetricWallets,
} from "../app/marketplace/use-creator-metrics.ts";
import type { MarketplaceMetricsDto } from "../lib/marketplace-types.ts";

test("formats test USDC only from canonical base-unit strings", () => {
  assert.equal(usdcAtomsToDisplay("0"), "0");
  assert.equal(usdcAtomsToDisplay("1200000000"), "1,200");
  assert.equal(usdcAtomsToDisplay("1234567"), "1.234567");
  assert.equal(usdcAtomsToDisplay("not-money"), "—");
});

test("converts creator and campaign amounts to six-decimal USDC atomics", () => {
  assert.equal(usdcInputToAtoms("1,200"), "1200000000");
  assert.equal(usdcInputToAtoms("0.000001"), "1");
  assert.throws(() => usdcInputToAtoms("1.0000001"), /no more than 6 decimal places/);
  assert.throws(() => usdcInputToAtoms("0"), /greater than zero/);
});

test("never presents absent funding data as confirmed", () => {
  assert.equal(fundingStatusLabel(undefined), "FUNDING UNAVAILABLE");
  assert.equal(fundingStatusLabel("unfunded"), "NOT YET FUNDED");
  assert.equal(fundingStatusLabel("funded"), "FUNDED ON BASE");
});

test("adds wallet recovery guidance only to wallet-session conflicts", () => {
  assert.equal(
    marketplaceErrorMessage(new MarketplaceApiError(409, "Deadline passed.", "INVALID_MARKETPLACE_STATE")),
    "Deadline passed.",
  );
  assert.match(
    marketplaceErrorMessage(new MarketplaceApiError(409, "Wallet mismatch.", "SESSION_WALLET_MISMATCH")),
    /Sign out, then reconnect/,
  );
});

test("deduplicates creator metric requests and caps the client fetch pool", () => {
  const first = "0x1111111111111111111111111111111111111111";
  const second = "0x2222222222222222222222222222222222222222";
  assert.deepEqual(
    normalizeCreatorMetricWallets([second, first.toUpperCase(), first, "not-a-wallet"]),
    [first, second],
  );
  assert.equal(MAX_CREATOR_METRICS_CONCURRENCY, 4);
});

test("shows a pay range only while its sanitized metrics snapshot is current", () => {
  const metrics: MarketplaceMetricsDto = {
    id: "metrics-1",
    followersCount: "25000",
    accountCreatedAt: "2020-01-01T00:00:00.000Z",
    postsSampled: 20,
    medianEngagementCount: "850",
    engagementRateBps: 340,
    estimatedPayMinUsdc: "500000000",
    estimatedPayMaxUsdc: "900000000",
    riskLevel: "low",
    evidenceHash: `0x${"11".repeat(32)}`,
    capturedAt: "2026-08-11T10:00:00.000Z",
    expiresAt: "2026-08-11T12:00:00.000Z",
  };

  assert.equal(
    classifyCreatorMetrics(metrics, Date.parse("2026-08-11T11:00:00.000Z")).phase,
    "current",
  );
  assert.equal(
    classifyCreatorMetrics(metrics, Date.parse("2026-08-11T12:00:00.000Z")).phase,
    "expired",
  );
  assert.equal(classifyCreatorMetrics(null, Date.now()).phase, "unavailable");
});

test("application UI labels estimates as guidance and reads only public creator metrics", async () => {
  const [detailSource, metricsSource] = await Promise.all([
    readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/marketplace/use-creator-metrics.ts", import.meta.url), "utf8"),
  ]);

  assert.match(detailSource, /ESTIMATED RANGE, CREATOR SETS FINAL RATE/);
  assert.match(detailSource, /NO CURRENT EVIDENCE-BACKED RANGE/);
  assert.match(detailSource, /ESTIMATE EXPIRED/);
  assert.match(metricsSource, /\/api\/marketplace\/creators\//);
  assert.match(
    detailSource,
    /application\.genlayerSubmitterStatus === "FINALIZED"[\s\S]*application\.resolutionTxHash/,
  );
  assert.doesNotMatch(detailSource, /84\.2K|estimatedPayMinUsdc:\s*["']\d/);
});

test("creator profile exposes authenticated idempotent metrics refresh and polling", async () => {
  const source = await readFile(
    new URL(
      "../app/marketplace/creators/[wallet]/CreatorProfile.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /useMarketplaceWallet/);
  assert.match(source, /REFRESH METRICS/);
  assert.match(source, /method: "POST", body: "\{\}"/);
  assert.match(source, /pollMetrics/);
  assert.match(source, /GENLAYER_SUBMISSION_OUTCOME_UNKNOWN/);
  assert.doesNotMatch(source, /followers:\s*\d|engagementRateBps:\s*\d/);
});

test("failed creator selection is recoverable without an automatic duplicate broadcast", async () => {
  const [detailSource, transactionSource] = await Promise.all([
    readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/marketplace/marketplace-transaction.ts", import.meta.url), "utf8"),
  ]);
  assert.match(detailSource, /onSubmitted:\s*\(hash\)/);
  assert.match(detailSource, /\/select\/confirm/);
  assert.match(detailSource, /CONFIRM EXISTING TX/);
  assert.match(detailSource, /PRIOR TX FAILED — BROADCAST NEW/);
  assert.match(detailSource, /Reconcile before retrying/i);
  assert.doesNotMatch(detailSource, /localStorage|sessionStorage/);
  assert.match(transactionSource, /eth_accounts/);
  assert.match(transactionSource, /active wallet account no longer matches/);
  assert.ok(
    transactionSource.indexOf("publicClient.call") < transactionSource.indexOf("sendTransaction"),
    "the exact call must be simulated before wallet broadcast",
  );
  assert.ok(
    transactionSource.indexOf("waitForTransactionReceipt") < transactionSource.indexOf("getTransaction"),
    "receipt and mined transaction must both be bound before success",
  );
});

test("escrow recovery UI waits for server receipt and post-state confirmation", async () => {
  const source = await readFile(
    new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /BASE ESCROW RECOVERY/);
  assert.match(source, /\$\{basePath\}\/\$\{kind\}/);
  assert.match(source, /\$\{basePath\}\/\$\{kind\}\/confirm/);
  assert.match(source, /if \(!confirmed\.confirmation\)/);
  assert.match(source, /setSettlement\(confirmed\.settlement\)/);
  assert.match(source, /CREDIT UNUSED BALANCE/);
  assert.match(source, /WITHDRAW CLAIMABLE/);
  assert.doesNotMatch(source, /set(?:Campaign|Application).*paid|set(?:Campaign|Application).*refunded/i);
});

test("UNDETERMINED is retryable only after the server reopens the campaign", async () => {
  const source = await readFile(
    new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url),
    "utf8",
  );
  const requestBranch = source.indexOf("application.requestId && application.resolutionRequestTxHash");
  const undeterminedBranch = source.indexOf('application.resolutionOutcome === "undetermined"');
  const genericFinalBranch = source.indexOf("application.resolutionOutcome && application.resolutionTxHash", undeterminedBranch + 1);
  assert.ok(requestBranch >= 0 && requestBranch < undeterminedBranch);
  assert.ok(undeterminedBranch >= 0 && undeterminedBranch < genericFinalBranch);
  assert.match(source, /const ready = campaign\.status === "submitted"/);
  assert.match(source, /REQUEST NEXT ROUND/);
  assert.match(source, /No payout or refund was assigned/);
});
