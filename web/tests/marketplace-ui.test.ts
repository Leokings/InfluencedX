import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  fundingStatusLabel,
  genAtomsToDisplay,
  genInputToAtoms,
  STUDIONET_MARKETPLACE_ADDRESS,
  STUDIONET_MARKETPLACE_DEPLOYMENT_TX,
  studioNetExplorerLink,
} from "../app/marketplace/marketplace-types.ts";
import {
  assertMarketplaceTransactionConsensusFinality,
  assertMarketplaceTransactionFinality,
  assertMarketplaceWalletContext,
  hydrateArgs,
  isTerminalMarketplaceTransactionError,
  validatePlan,
} from "../app/marketplace/marketplace-transaction.ts";
import { farcasterCastUrlForHash } from "../app/verify/farcaster-cast-url.ts";
import { shouldRejectVerificationResponse } from "../app/verify/verification-api-client.ts";
import { parseBoundIdentityBundleRecovery, recoveryMatchesActiveBundle } from "../app/verify/verification-recovery.ts";
import {
  MarketplaceApiError,
  matchingMarketplaceReadyRetry,
  marketplaceErrorMessage,
  preparedMarketplaceRecovery,
} from "../app/marketplace/marketplace-api.ts";
import {
  classifyCreatorMetrics,
  MAX_CREATOR_METRICS_CONCURRENCY,
  normalizeCreatorMetricWallets,
} from "../app/marketplace/use-creator-metrics.ts";
import {
  DEFAULT_MAX_CAMPAIGN_DURATION_MS,
  DEFAULT_MAX_UNDETERMINED_RETRIES,
  DEFAULT_RETENTION_SECONDS,
  DEFAULT_SELECTION_WINDOW_MS,
  DEFAULT_SUBMISSION_WINDOW_MS,
  MIN_APPLICATION_WINDOW_MS,
  deriveDefaultCampaignSchedule,
  marketplaceDashboardDto,
  type MarketplaceMetricsDto,
} from "../lib/marketplace-types.ts";

test("formats native GEN only from canonical 18-decimal atomic strings", () => {
  assert.equal(genAtomsToDisplay("0"), "0");
  assert.equal(genAtomsToDisplay("1200000000000000000000"), "1,200");
  assert.equal(genAtomsToDisplay("1234567000000000000"), "1.234567");
  assert.equal(genAtomsToDisplay("not-money"), "—");
});

test("converts creator and campaign amounts to 18-decimal GEN atomics", () => {
  assert.equal(genInputToAtoms("1,200"), "1200000000000000000000");
  assert.equal(genInputToAtoms("0.000000000000000001"), "1");
  assert.throws(() => genInputToAtoms("1.0000000000000000001"), /no more than 18 decimal places/);
  assert.throws(() => genInputToAtoms("0"), /greater than zero/);
});

test("derives the exact frozen campaign schedule shown before creation", () => {
  const applicationCloseMs = Date.parse("2026-08-21T18:00:00.000Z");
  const schedule = deriveDefaultCampaignSchedule(applicationCloseMs);
  assert.equal(schedule.selectionDeadlineMs, applicationCloseMs + DEFAULT_SELECTION_WINDOW_MS);
  assert.equal(schedule.submissionDeadlineMs, applicationCloseMs + DEFAULT_SELECTION_WINDOW_MS + DEFAULT_SUBMISSION_WINDOW_MS);
  assert.equal(schedule.retentionSeconds, DEFAULT_RETENTION_SECONDS);
  assert.equal(schedule.maxUndeterminedRetries, DEFAULT_MAX_UNDETERMINED_RETRIES);
  assert.equal(MIN_APPLICATION_WINDOW_MS, 60 * 60 * 1_000);
  assert.equal(DEFAULT_MAX_CAMPAIGN_DURATION_MS, 90 * 24 * 60 * 60 * 1_000);
});

test("never presents absent GenLayer funding as confirmed", () => {
  assert.equal(fundingStatusLabel(undefined), "FUNDING UNAVAILABLE");
  assert.equal(fundingStatusLabel("unfunded"), "NOT YET FUNDED");
  assert.equal(fundingStatusLabel("funded"), "FUNDED ON GENLAYER");
});

test("accepts only an exact server-bound confirm-only marketplace recovery", () => {
  const preparedId = "11111111-1111-4111-8111-111111111111";
  const txHash = `0x${"12".repeat(32)}`;
  assert.deepEqual(
    preparedMarketplaceRecovery({
      preparedId,
      recovery: { preparedId, txHash },
    }),
    { preparedId, txHash },
  );
  assert.equal(preparedMarketplaceRecovery({ preparedId, recovery: null }), null);
  assert.throws(
    () => preparedMarketplaceRecovery({
      preparedId,
      recovery: {
        preparedId: "22222222-2222-4222-8222-222222222222",
        txHash,
      },
    }),
    /Invalid marketplace recovery response/,
  );
  assert.throws(
    () => preparedMarketplaceRecovery({
      preparedId,
      recovery: { preparedId, txHash, actorWallet: `0x${"34".repeat(20)}` },
    }),
    /Invalid marketplace recovery response/,
  );
});

test("a rejected ready transaction is reused only for the exact same evidence URL", () => {
  const actor = "0x1111111111111111111111111111111111111111";
  const firstBody = JSON.stringify({
    contentId: "https://farcaster.xyz/milechain/0x9625056e",
    contentSource: "FARCASTER",
    expectedHandle: "milechain",
  });
  const retry = { actor, requestBody: firstBody, preparedId: "prepared-1" };
  assert.equal(
    matchingMarketplaceReadyRetry(retry, actor, firstBody),
    retry,
  );
  assert.equal(
    matchingMarketplaceReadyRetry(
      retry,
      actor,
      JSON.stringify({
        contentId: "https://farcaster.xyz/milechain/0xdeadbeef",
        contentSource: "FARCASTER",
        expectedHandle: "milechain",
      }),
    ),
    null,
  );
});

test("maps GenLayer dashboard rows into the exact client DTO", () => {
  const result = marketplaceDashboardDto({
    brandCampaigns: [{
      localCampaignId: "local-campaign",
      campaignId: `0x${"11".repeat(32)}`,
      status: "OPEN",
      budgetAtto: "3000000000000000000",
      availableAtto: "2000000000000000000",
    }],
    creatorApplications: [{
      localApplicationId: "local-application",
      localCampaignId: "local-campaign",
      assignmentId: null,
      status: "PENDING_ONCHAIN",
      agreedRateAtto: null,
    }],
    claimableAtto: "1000000000000000000",
  });

  assert.deepEqual(result, {
    brandCampaigns: [{
      id: "local-campaign",
      campaignId: `0x${"11".repeat(32)}`,
      status: "open",
      budgetAtto: "3000000000000000000",
      availableAtto: "2000000000000000000",
    }],
    creatorApplications: [{
      id: "local-application",
      campaignId: "local-campaign",
      assignmentId: null,
      status: "pending_onchain",
      rateAtto: null,
    }],
    claimableAtto: "1000000000000000000",
  });
  assert.equal("localCampaignId" in result.brandCampaigns[0], false);
  assert.equal("localApplicationId" in result.creatorApplications[0], false);
});

test("uses the live StudioNet explorer route shapes", () => {
  const transactionHash = `0x${"12".repeat(32)}`;
  const address = `0x${"34".repeat(20)}`;
  assert.equal(studioNetExplorerLink("tx", transactionHash), `https://explorer-studio.genlayer.com/tx/${transactionHash}`);
  assert.equal(studioNetExplorerLink("address", address), `https://explorer-studio.genlayer.com/address/${address}`);
  assert.equal(STUDIONET_MARKETPLACE_ADDRESS, "0xb72FE7272A5aEdf3c6Ba893394EbeF818fd86Fbb");
  assert.equal(STUDIONET_MARKETPLACE_DEPLOYMENT_TX, "0x05ff78998a2b389c7e102f6f09b893dbd16d376f3c18f9748b2b8ef9de5e7998");
});

test("adds wallet recovery guidance only to wallet-session conflicts", () => {
  assert.equal(marketplaceErrorMessage(new MarketplaceApiError(409, "Deadline passed.", "INVALID_MARKETPLACE_STATE")), "Deadline passed.");
  assert.equal(marketplaceErrorMessage(new MarketplaceApiError(409, "Wallet mismatch.", "SESSION_WALLET_MISMATCH")), "Wallet changed. Sign out and reconnect.");
});

test("rejects a wrong active account and a non-StudioNet wallet chain", () => {
  const actor = "0x1111111111111111111111111111111111111111";
  assert.throws(
    () => assertMarketplaceWalletContext(["0x2222222222222222222222222222222222222222"], "0xf22f", actor),
    /active wallet account no longer matches/,
  );
  assert.throws(() => assertMarketplaceWalletContext([actor], "0x1", actor), /Switch.*StudioNet/);
  assert.doesNotThrow(() => assertMarketplaceWalletContext([actor.toUpperCase()], "0xF22F", actor));
});

test("accepts only StudioNet FINALIZED majority agreement with one successful leader return", () => {
  const finalized = {
    status_name: "FINALIZED",
    result_name: "MAJORITY_AGREE",
    consensus_data: {
      leader_receipt: [{ mode: "leader", execution_result: "SUCCESS", result: { status: "return" } }],
    },
  };
  assert.doesNotThrow(() => assertMarketplaceTransactionFinality(finalized));
  assert.doesNotThrow(() => assertMarketplaceTransactionFinality({
    status_name: "FINALIZED",
    result_name: "MAJORITY_AGREE",
    txExecutionResultName: "FINISHED_WITH_RETURN",
    consensus_data: {
      leader_receipt: [{ mode: "leader", execution_result: "SUCCESS", result: { status: "return" } }],
    },
  }));
  assert.throws(() => assertMarketplaceTransactionFinality({ ...finalized, status_name: "ACCEPTED" }), /validator finality/);
  assert.throws(() => assertMarketplaceTransactionFinality({ ...finalized, result_name: "MAJORITY_DISAGREE" }), /majority agreement/);
  assert.throws(() => assertMarketplaceTransactionFinality({ ...finalized, txExecutionResultName: "NOT_VOTED" }), /without a successful contract return/);
  assert.throws(() => assertMarketplaceTransactionFinality({ ...finalized, txExecutionResultName: "FINISHED_WITH_ERROR" }), /without a successful contract return/);
  assert.throws(() => assertMarketplaceTransactionFinality({ ...finalized, consensus_data: { leader_receipt: [{ mode: "leader", execution_result: "SUCCESS", result: { status: "rollback" } }] } }), /without a successful contract return/);
  assert.throws(() => assertMarketplaceTransactionFinality({ ...finalized, consensus_data: { leader_receipt: [{ mode: "validator", execution_result: "SUCCESS", result: { status: "return" } }] } }), /without a successful contract return/);
  assert.throws(() => assertMarketplaceTransactionFinality({ ...finalized, consensus_data: { leader_receipt: [
    { mode: "leader", execution_result: "SUCCESS", result: { status: "return" } },
    { mode: "leader", execution_result: "SUCCESS", result: { status: "return" } },
  ] } }), /without a successful contract return/);

  const rolledBack = {
    ...finalized,
    consensus_data: {
      leader_receipt: [{ mode: "leader", execution_result: "ERROR", result: { status: "rollback" } }],
    },
  };
  assert.doesNotThrow(() => assertMarketplaceTransactionConsensusFinality(rolledBack));
  assert.throws(() => assertMarketplaceTransactionFinality(rolledBack), /without a successful contract return/);
});

test("clears recovery only for exact terminal marketplace outcomes", () => {
  assert.equal(isTerminalMarketplaceTransactionError({ code: "GENLAYER_EXECUTION_FAILED" }), true);
  assert.equal(isTerminalMarketplaceTransactionError({ code: "GENLAYER_TRANSACTION_TERMINATED" }), true);
  assert.equal(isTerminalMarketplaceTransactionError({ code: "GENLAYER_FINALITY_PENDING" }), false);
  assert.equal(isTerminalMarketplaceTransactionError({ code: "REFUND_EARLY" }), false);
  assert.equal(isTerminalMarketplaceTransactionError({ code: 4_001 }), false);
  assert.equal(isTerminalMarketplaceTransactionError(new Error("failed")), false);
});

test("hydrates prepared u256 and address arguments into GenLayer calldata types", () => {
  class TestCalldataAddress {
    readonly bytes: Uint8Array;

    constructor(bytes: Uint8Array) {
      this.bytes = bytes;
    }
  }
  const address = `0x${"ab".repeat(20)}`;
  const hydrated = hydrateArgs(
    ["340282366920938463463374607431768211456", address, true, "proof"],
    ["u256", "address", "bool", "string"],
    TestCalldataAddress,
  );
  assert.equal(hydrated[0], 2n ** 128n);
  assert.ok(hydrated[1] instanceof TestCalldataAddress);
  assert.deepEqual(Array.from((hydrated[1] as TestCalldataAddress).bytes), Array(20).fill(0xab));
  assert.equal(hydrated[2], true);
  assert.equal(hydrated[3], "proof");
  assert.throws(
    () => hydrateArgs([`0x${"ab".repeat(19)}`], ["address"], TestCalldataAddress),
    /not a valid address/,
  );
  assert.throws(
    () => hydrateArgs([(2n ** 256n).toString()], ["uint256"], TestCalldataAddress),
    /exceeds uint256/,
  );
});

test("wallet signing pins the V2 contract, method schema, and GEN value", () => {
  const contract = "0x1111111111111111111111111111111111111111";
  const base = {
    network: "studionet" as const,
    chainId: 61_999 as const,
    contractAddress: contract,
    functionName: "apply_to_campaign",
    args: [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`, "1", `0x${"33".repeat(32)}`],
    argTypes: ["string", "string", "u256", "string"] as const,
    value: "0",
  };
  assert.doesNotThrow(() => validatePlan(base as never, contract, "apply_to_campaign", "0"));
  assert.throws(
    () => validatePlan(base as never, contract, "submit_evidence", "0"),
    /does not match the expected submit_evidence action/,
  );
  assert.throws(
    () => validatePlan(base as never, contract, "apply_to_campaign", "1"),
    /does not match the expected marketplace action/,
  );
  assert.throws(() => validatePlan({ ...base, contractAddress: "0x2222222222222222222222222222222222222222" } as never, contract), /unauthorized GenLayer contract/);
  assert.throws(() => validatePlan({ ...base, functionName: "set_treasury", args: [contract], argTypes: ["address"] } as never, contract), /not authorized/);
  assert.throws(() => validatePlan({ ...base, value: "1" } as never, contract), /must not transfer GEN/);

  const campaignArgs = Array.from({ length: 14 }, (_, index) => index >= 8 ? "1" : index === 7 ? true : "x");
  const campaignTypes = ["string", "string", "string", "string", "string", "string", "string", "bool", "u256", "u256", "u256", "u256", "u256", "u256"] as const;
  assert.doesNotThrow(() => validatePlan({ ...base, functionName: "create_campaign", args: campaignArgs, argTypes: campaignTypes, value: "1" } as never, contract));
  assert.throws(() => validatePlan({ ...base, functionName: "create_campaign", args: campaignArgs, argTypes: campaignTypes, value: "2" } as never, contract), /committed budget/);

  const bundleTypes = [
    "string", "string", "string", "string", "string", "u256", "u256", "u256",
    "string", "string", "u256", "string", "string", "u256", "u256", "u256",
  ] as const;
  const bundleArgs = bundleTypes.map((type) => type === "u256" ? "1" : "x");
  const bundle = { ...base, functionName: "activate_identity_bundle", args: bundleArgs, argTypes: bundleTypes };
  assert.doesNotThrow(() => validatePlan(bundle as never, contract, "activate_identity_bundle", "0"));
  const invalidBundleTypes = [...bundleTypes];
  invalidBundleTypes[0] = "u256";
  assert.throws(
    () => validatePlan({ ...bundle, argTypes: invalidBundleTypes } as never, contract, "activate_identity_bundle", "0"),
    /argument schema is not authorized/,
  );
  assert.throws(
    () => validatePlan({ ...bundle, value: "1" } as never, contract, "activate_identity_bundle", "0"),
    /expected marketplace action/,
  );
});

test("identity recovery keeps only the active unfinished bundle for this server request", () => {
  const recovery = { requestId: "request-a" };
  const active = {
    id: "request-a",
    status: "X_CHALLENGE_ISSUED",
    identityBundleReady: true,
    tweetText: "x proof",
    farcasterCastText: "farcaster proof",
    genlayerOutcome: null,
    genlayerRetryable: null,
  };
  assert.equal(recoveryMatchesActiveBundle(recovery, active), true);
  assert.equal(recoveryMatchesActiveBundle(recovery, { ...active, genlayerOutcome: "UNDETERMINED", genlayerRetryable: true }), true);
  assert.equal(recoveryMatchesActiveBundle(recovery, { ...active, id: "request-b" }), false);
  assert.equal(recoveryMatchesActiveBundle(recovery, { ...active, status: "EXPIRED" }), false);
  assert.equal(recoveryMatchesActiveBundle(recovery, { ...active, identityBundleReady: false, farcasterCastText: null }), false);
  assert.equal(recoveryMatchesActiveBundle(recovery, { ...active, genlayerOutcome: "VERIFIED" }), false);
  assert.equal(recoveryMatchesActiveBundle(recovery, { ...active, genlayerOutcome: "REJECTED" }), false);
  assert.equal(recoveryMatchesActiveBundle(recovery, { ...active, genlayerOutcome: "UNDETERMINED", genlayerRetryable: false }), false);
  assert.equal(recoveryMatchesActiveBundle(recovery, null), false);
});

test("identity recovery accepts only the exact server-bound tuple", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const preparedId = "22222222-2222-4222-8222-222222222222";
  const txHash = `0x${"AB".repeat(32)}`;
  assert.deepEqual(
    parseBoundIdentityBundleRecovery({ requestId, preparedId, txHash }, requestId),
    { requestId, preparedId, txHash: txHash.toLowerCase() },
  );
  assert.equal(parseBoundIdentityBundleRecovery({ requestId, preparedId, txHash }, "33333333-3333-4333-8333-333333333333"), null);
  assert.equal(parseBoundIdentityBundleRecovery({ requestId, preparedId, txHash, source: "X" }, requestId), null);
  assert.equal(parseBoundIdentityBundleRecovery({ requestId, preparedId, txHash: "0x12" }, requestId), null);
});

test("rehydrates a stored Farcaster proof as an official cast URL", () => {
  const hash = `0x${"AB".repeat(20)}`;
  assert.equal(
    farcasterCastUrlForHash(` ${hash} `),
    `https://farcaster.xyz/~/conversations/${hash.toLowerCase()}`,
  );
  assert.equal(farcasterCastUrlForHash("0x1234"), null);
  assert.equal(farcasterCastUrlForHash(null), null);
});

test("verification client keeps pending recovery when a 202 carries an API error", () => {
  assert.equal(shouldRejectVerificationResponse(202, {
    error: { code: "GENLAYER_FINALITY_PENDING", message: "Not finalized." },
  }), true);
  assert.equal(shouldRejectVerificationResponse(202, { accepted: true }), false);
  assert.equal(shouldRejectVerificationResponse(409, {}), true);
  assert.equal(shouldRejectVerificationResponse(200, { request: {} }), false);
});

test("deduplicates creator metric requests and caps the client fetch pool", () => {
  const first = "0x1111111111111111111111111111111111111111";
  const second = "0x2222222222222222222222222222222222222222";
  assert.deepEqual(normalizeCreatorMetricWallets([second, first.toUpperCase(), first, "not-a-wallet"]), [first, second]);
  assert.equal(MAX_CREATOR_METRICS_CONCURRENCY, 4);
});

test("shows a pay range only while its sanitized metrics snapshot is current", () => {
  const metrics = {
    id: "metrics-1",
    followersCount: "25000",
    accountCreatedAt: "2020-01-01T00:00:00.000Z",
    postsSampled: 20,
    medianEngagementCount: "850",
    engagementRateBps: 340,
    estimatedPayMinGen: "500000000000000000000",
    estimatedPayMaxGen: "900000000000000000000",
    riskLevel: "low",
    evidenceHash: `0x${"11".repeat(32)}`,
    capturedAt: "2026-08-11T10:00:00.000Z",
    expiresAt: "2026-08-11T12:00:00.000Z",
  } as unknown as MarketplaceMetricsDto;
  assert.equal(classifyCreatorMetrics(metrics, Date.parse("2026-08-11T11:00:00.000Z")).phase, "current");
  assert.equal(classifyCreatorMetrics(metrics, Date.parse("2026-08-11T12:00:00.000Z")).phase, "expired");
  assert.equal(classifyCreatorMetrics(null, Date.now()).phase, "unavailable");
});

test("campaign actions preserve prepared intent through wallet finality and server confirmation", async () => {
  const source = await readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8");
  assert.match(source, /preparedId/);
  assert.match(source, /saveRecovery\(actor, input\.key/);
  assert.match(source, /body: JSON\.stringify\(\{ preparedId: prepared\.preparedId, txHash \}\)/);
  const broadcast = source.indexOf("await broadcastMarketplaceTransaction");
  const confirmation = source.indexOf("await marketplaceRequest(confirmPath", broadcast);
  const clear = source.indexOf("clearRecovery(actor, input.key)", confirmation);
  const productReload = source.indexOf("await loadDetail()", confirmation);
  assert.ok(broadcast >= 0 && confirmation > broadcast, "server confirmation must follow wallet finality");
  assert.ok(clear > confirmation && productReload > confirmation, "a failed server confirmation must retain recovery and not update product state");
});

test("marketplace submissions durably bind hashes and preserve pending application recovery", async () => {
  const [detail, funding, api] = await Promise.all([
    readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignFunding.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/marketplace/marketplace-api.ts", import.meta.url), "utf8"),
  ]);
  assert.match(api, /\/api\/marketplace\/transactions\/\$\{encodeURIComponent\(preparedId\)\}\/submitted/);
  assert.match(detail, /onSubmitted: async \(hash\)/);
  assert.match(funding, /onSubmitted: async \(hash\)/);
  const actionSubmit = detail.indexOf("onSubmitted: async (hash)");
  const actionRecovery = detail.indexOf("saveRecovery(actor, input.key", actionSubmit);
  const actionBinding = detail.indexOf("await recordSubmittedMarketplaceTransaction", actionSubmit);
  assert.ok(actionRecovery > actionSubmit && actionBinding > actionRecovery);
  const existingRecovery = detail.indexOf("if (existing)");
  const existingBinding = detail.indexOf(
    "await recordSubmittedMarketplaceTransaction(existing.preparedId, existing.txHash)",
    existingRecovery,
  );
  const existingConfirmation = detail.indexOf(
    "await marketplaceRequest(existing.confirmPath",
    existingRecovery,
  );
  assert.ok(existingBinding > existingRecovery && existingConfirmation > existingBinding);
  const fundingSubmit = funding.indexOf("onSubmitted: async (hash)");
  const fundingRecovery = funding.indexOf("localStorage.setItem", fundingSubmit);
  const fundingBinding = funding.indexOf("await recordSubmittedMarketplaceTransaction", fundingSubmit);
  assert.ok(fundingRecovery > fundingSubmit && fundingBinding > fundingRecovery);
  assert.match(detail, /application\.status === "pending_onchain"/);
  assert.match(detail, /FINISH APPLICATION/);
  assert.match(detail, /ORIGINAL TRANSACTION REQUIRED/);
  assert.doesNotMatch(detail, /RESUME APPLICATION|apply\/resume/);
  assert.match(detail, /hasPendingRecovery=\{Boolean\(recoveries\.apply\)\}/);
  assert.match(detail, /viewerApplication \? detail\.viewerRecovery \?\? null : null/);
  assert.match(detail, /recoveryStorageKey\(campaignId, activeActor, "apply"\)/);
  assert.match(detail, /setRecoveries\(\(current\) => \(\{ \.\.\.current, apply: recovery \}\)\)/);
  assert.match(detail, /disabled=\{transactionLocked\}/);
  assert.match(detail, /transactionLocked = action\.key !== null \|\| fundingBusy \|\| settlementBusy/);
  assert.doesNotMatch(detail, /transactionLocked[\s\S]{0,120}Object\.keys\(recoveries\)/);
  assert.match(detail, /onBusyChange\(true\)/);
  assert.match(detail, /onBusyChange\(false\)/);
  assert.match(funding, /onBusyChange\(true\)/);
  assert.match(funding, /onBusyChange\(false\)/);
  assert.match(funding, /await recordSubmittedMarketplaceTransaction\(preparedId, txHash\)/);
  assert.match(detail, /const requestBody = JSON\.stringify\(input\.body \?\? \{\}\)/);
  assert.match(detail, /matchingMarketplaceReadyRetry\(readyRetry, actor, requestBody\)/);
  assert.match(detail, /readyRetries\.current\[input\.key\] = \{ actor, prepared, confirmPath, requestBody \}/);
  const actionRecoveryResponse = detail.indexOf("preparedMarketplaceRecovery(prepared)");
  const actionBroadcast = detail.indexOf("broadcastMarketplaceTransaction(prepared.transaction", actionRecoveryResponse);
  assert.ok(actionRecoveryResponse >= 0 && actionBroadcast > actionRecoveryResponse);
  const settlementStart = detail.indexOf("function SettlementControls");
  const settlementRecoveryResponse = detail.indexOf("preparedMarketplaceRecovery(prepared)", settlementStart);
  const settlementBroadcast = detail.indexOf("broadcastMarketplaceTransaction(prepared.transaction", settlementRecoveryResponse);
  assert.ok(settlementRecoveryResponse > settlementStart && settlementBroadcast > settlementRecoveryResponse);
  const fundingRecoveryResponse = funding.indexOf("preparedMarketplaceRecovery(prepared)");
  const fundingBroadcast = funding.indexOf("broadcastMarketplaceTransaction(prepared.transaction", fundingRecoveryResponse);
  assert.ok(fundingRecoveryResponse >= 0 && fundingBroadcast > fundingRecoveryResponse);
  assert.match(detail, /if \(!prepared\.transaction\)[\s\S]*prepared marketplace transaction is unavailable/i);
  assert.match(funding, /if \(!prepared\.transaction\)[\s\S]*prepared marketplace transaction is unavailable/i);
  assert.doesNotMatch(detail, /PRIOR TX FAILED — PREPARE A NEW ACTION/);
});

test("campaign funding persists both prepared ID and submitted hash without auto-rebroadcast", async () => {
  const source = await readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignFunding.tsx", import.meta.url), "utf8");
  assert.match(source, /const recovery = \{ preparedId: prepared\.preparedId, txHash: hash \}/);
  assert.match(source, /localStorage\.setItem\(recoveryKey, JSON\.stringify\(recovery\)\)/);
  assert.match(source, /if \(submitted\)[\s\S]*confirm\(submitted\.preparedId, submitted\.txHash\)[\s\S]*return/);
  assert.match(source, /RECONCILE SUBMITTED TRANSACTION/);
});

test("campaign recovery and private views are scoped to the exact authenticated wallet", async () => {
  const [detail, funding] = await Promise.all([
    readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignFunding.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(detail, /wallet\.authenticated[\s\S]*wallet\.sessionWallet === wallet\.address[\s\S]*wallet\.address\.toLowerCase\(\)/);
  assert.match(detail, /responseViewerApplication\?\.creatorWallet\.toLowerCase\(\) === activeActor/);
  assert.match(detail, /state\.detail\.viewerApplication\?\.creatorWallet\.toLowerCase\(\) === activeActor/);
  assert.match(detail, /activeActor === detail\.campaign\.brandWallet\.toLowerCase\(\)/);
  assert.match(detail, /const sessionKey = \[[\s\S]*wallet\.authenticated[\s\S]*wallet\.address[\s\S]*wallet\.sessionWallet/);
  assert.match(detail, /<CampaignDetailSession[\s\S]*key=\{sessionKey\}/);
  assert.match(detail, /useState<DetailState>\(\{ phase: "loading", detail: null, error: null \}\)/);
  assert.match(detail, /influencedx:studionet-action:v2:\$\{campaignId\}:\$\{actor\}:\$\{actionKey\}/);
  assert.match(detail, /influencedx:studionet-settlement:v2:\$\{campaignId\}:\$\{actor\}:\$\{kind\}/);
  assert.match(detail, /response\.settlement\.actorWallet\.toLowerCase\(\) !== actor/);
  assert.match(detail, /key=\{`funding:\$\{activeActor\}`\}/);
  assert.match(detail, /key=\{`settlement:\$\{activeActor\}`\}/);
  assert.match(funding, /influencedx:studionet-funding:v2:\$\{campaign\.id\}:\$\{actor\}/);
  assert.match(funding, /brand !== actor \|\| brand !== campaign\.brandWallet\.toLowerCase\(\)/);
  assert.doesNotMatch(detail, /sessionStorage\.setItem\([^\n]*JSON\.stringify\((?:recovery|submitted)\)/);
  assert.doesNotMatch(funding, /sessionStorage/);
});

test("campaign actions require an already authenticated actor before busy state can remount", async () => {
  const detail = await readFile(
    new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url),
    "utf8",
  );
  const executeStart = detail.indexOf("async function executePrepared");
  const executeEnd = detail.indexOf("async function apply", executeStart);
  const execute = detail.slice(executeStart, executeEnd);
  const actorGuard = execute.indexOf("if (!activeActor)");
  const busyStart = execute.indexOf("setAction({ key: input.key");
  assert.ok(actorGuard >= 0 && busyStart > actorGuard);
  assert.match(execute, /const actor = await wallet\.authenticate\(\)/);
  assert.match(execute, /if \(actor !== activeActor\)/);
  assert.match(detail, /const canApply = Boolean\(activeActor\)/);
  assert.match(detail, /\{!activeActor \? <WalletIntro wallet=\{wallet\} \/> : null\}/);
  assert.match(detail, /\{activeActor && canApply \? <ApplicationForm/);
  assert.match(detail, /transactionLocked = action\.key !== null \|\| fundingBusy \|\| settlementBusy/);
  assert.match(detail, /disabled=\{transactionLocked\}/);
});

test("marketplace handlers snapshot FormData before asynchronous wallet work", async () => {
  const [createSource, detailSource] = await Promise.all([
    readFile(new URL("../app/marketplace/create/CreateCampaignForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8"),
  ]);
  assert.ok(createSource.indexOf("new FormData(event.currentTarget)") < createSource.indexOf("await wallet.authenticate()"));
  const applyStart = detailSource.indexOf("async function apply(");
  assert.ok(detailSource.indexOf("new FormData(event.currentTarget)", applyStart) < detailSource.indexOf("await executePrepared", applyStart));
  const submitStart = detailSource.indexOf("async function submitEvidence(");
  assert.ok(detailSource.indexOf("new FormData(event.currentTarget)", submitStart) < detailSource.indexOf("await executePrepared", submitStart));
});

test("campaign creation previews and submits the same complete timing schedule", async () => {
  const source = await readFile(new URL("../app/marketplace/create/CreateCampaignForm.tsx", import.meta.url), "utf8");
  assert.match(source, /deriveDefaultCampaignSchedule\(deadline\.getTime\(\)\)/);
  assert.match(source, /deadline\.getTime\(\) < nowMs \+ MIN_APPLICATION_WINDOW_MS/);
  assert.match(source, /schedule\.submissionDeadlineMs > nowMs \+ DEFAULT_MAX_CAMPAIGN_DURATION_MS/);
  assert.match(source, /selectionDeadline: new Date\(schedule\.selectionDeadlineMs\)\.toISOString\(\)/);
  assert.match(source, /submissionDeadline: new Date\(schedule\.submissionDeadlineMs\)\.toISOString\(\)/);
  assert.match(source, /retentionSeconds: schedule\.retentionSeconds/);
  assert.match(source, /maxUndeterminedRetries: schedule\.maxUndeterminedRetries/);
  assert.match(source, /APPLICATIONS CLOSE/);
  assert.match(source, /SELECT BY \/ UNUSED FUNDS AVAILABLE/);
  assert.match(source, /WORK DUE/);
  assert.match(source, /H AFTER POST · \{DEFAULT_MAX_UNDETERMINED_RETRIES\} ATTEMPTS MAX/);
  assert.match(source, /CANCEL BEFORE APPLICATIONS CLOSE · NO RESERVED CREATOR FUNDS/);
  assert.match(source, /SELECTED CREATORS: UP TO 24H TO ACCEPT/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /min=\{deadlineBounds\?\.min\}/);
  assert.match(source, /max=\{deadlineBounds\?\.max\}/);
  const localValidation = source.indexOf("const budgetGen = genInputToAtoms");
  const authentication = source.indexOf("const brandWallet = await wallet.authenticate()", localValidation);
  assert.ok(localValidation >= 0 && authentication > localValidation, "local validation must finish before wallet authentication");
});

test("GenLayer settlement UI confirms contract state before displaying a claim or refund", async () => {
  const source = await readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8");
  assert.match(source, /GENLAYER BALANCES/);
  assert.match(source, /preparedId: prepared\.preparedId, txHash/);
  assert.match(source, /REFUND UNUSED GEN/);
  assert.match(source, /UNUSED BUDGET REFUND AVAILABLE/);
  assert.match(source, /unallocated !== "0" && view\.canRefundUnallocated/);
  const settlement = source.slice(source.indexOf("function SettlementControls"), source.indexOf("function EvidenceSubmissionForm"));
  assert.match(settlement, /const refundDeadlineReached = contractAtOrAfter\(settlement\?\.selectionDeadline, observedAt\)/);
  assert.match(settlement, /window\.setTimeout\(\(\) => void recheck\(\), 15_000\)/);
  assert.match(settlement, /\[load, refundDeadlineReached, settlementCanRefund, settlementRole, settlementUnallocated\]/);
  assert.doesNotMatch(settlement, /Date\.now|\[.*observedAt.*\]/);
  assert.match(source, /isTerminalMarketplaceTransactionError\(settlementError\)[\s\S]*localStorage\.removeItem\(recoveryKey\)/);
  assert.match(source, /Promise\.allSettled\(\[load\(\), onUpdated\(\)\]\)/);
  assert.match(source, /REQUEST GEN WITHDRAWAL/);
  assert.match(source, /EXECUTE GEN WITHDRAWAL/);
  assert.match(source, /EMITTED_UNCONFIRMED/);
  assert.match(source, /NOT YET PAID/);
  assert.match(source, /studionet-settlement/);
  assert.doesNotMatch(source, /set(?:Campaign|Application).*paid|set(?:Campaign|Application).*refunded/i);
  assert.match(source, /\["RESTORED_FAILED", "CONFIRMED"\]\.includes\(view\.withdrawalStatus\)/);
});

test("terminal transaction cleanup is actor-scoped and followed by authoritative reload", async () => {
  const [detail, funding, verification] = await Promise.all([
    readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignFunding.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/verify/VerifyFlow.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(detail, /isTerminalMarketplaceTransactionError\(error\)[\s\S]*clearRecovery\(activeActor, input\.key\)[\s\S]*await loadDetail\(\)/);
  assert.match(funding, /isTerminalMarketplaceTransactionError\(error\)[\s\S]*localStorage\.removeItem\(recoveryKey\)[\s\S]*setSubmitted\(null\)[\s\S]*await onFunded\(\)/);
  assert.match(verification, /isTerminalMarketplaceTransactionError\(activationError\)[\s\S]*clearRecovery\(\)[\s\S]*setRecovery\(null\)/);
});

test("UNDETERMINED exposes bounded retry and refund paths", async () => {
  const source = await readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8");
  assert.match(source, /application\.resolutionOutcome === "undetermined"/);
  assert.match(source, /RETRY RESOLUTION/);
  assert.match(source, /application\.undeterminedRefundEligibleAt/);
  assert.match(source, /timing\.canRefund \? <button[\s\S]*>REFUND<\/button>/);
  assert.match(source, /timing\.refundWaiting[\s\S]*REFUND UNLOCKS/);
  assert.match(source, /Retry unlocks/);
  assert.doesNotMatch(source, /No payout or refund was assigned/);
});

test("resolution and cancellation controls fail closed on authoritative eligibility", async () => {
  const source = await readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8");
  assert.match(source, /const canCancel = isBrand[\s\S]*&& state\.detail\.canCancel[\s\S]*&& contractBefore\(campaign\.deadline, observedAt\)/);
  assert.doesNotMatch(source, /const canCancel = isBrand && \["funding", "open"\]/);
  assert.match(source, /application\.resolutionEligibleAt/);
  assert.match(source, /application\.resolutionAttempts >= campaign\.maxUndeterminedRetries/);
  assert.match(source, /timing\.canResolve \? <button[\s\S]*REQUEST RESOLUTION/);
  assert.doesNotMatch(source, /if \(application\.requestId \|\| application\.genlayerTxHash\)/);
  assert.match(source, /contractBefore\(campaign\.deadline, observedAt\)/);
  assert.match(source, /const remaining = nextActionBoundary - actionClock/);
  assert.match(source, /const capped = remaining > 2_147_000_000/);
  assert.match(source, /const advanceTo = capped \? actionClock \+ 2_147_000_000 : nextActionBoundary/);
  assert.match(source, /\[actionClock, loadDetail, nextActionBoundary\]/);
});

test("campaign controls mirror the contract's exact-second deadline boundaries", async () => {
  const source = await readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8");
  assert.match(source, /function CampaignTimeline/);
  assert.match(source, /formatDate\(campaign\.selectionDeadline\)/);
  assert.match(source, /formatDate\(campaign\.submissionDeadline\)/);
  assert.match(source, /formatDurationSeconds\(campaign\.retentionSeconds\)/);
  assert.match(source, /ACCEPT BY/);
  assert.match(source, /function contractBefore[\s\S]*Math\.floor\(nowMs \/ 1_000\) < deadline/);
  assert.match(source, /function contractAtOrBefore[\s\S]*Math\.floor\(nowMs \/ 1_000\) <= deadline/);
  assert.match(source, /function contractAtOrAfter[\s\S]*Math\.floor\(nowMs \/ 1_000\) >= deadline/);
  assert.match(source, /contractBefore\(campaign\.selectionDeadline, observedAt\)/);
  assert.match(source, /contractAtOrBefore\(application\.acceptanceDeadline, observedAt\)/);
  assert.match(source, /contractAtOrBefore\(campaign\.submissionDeadline, observedAt\)/);
  assert.match(source, /contractAtOrAfter\(refundUnlocksAt, observedAt\)/);
  assert.match(source, /addBoundary\(detail\.campaign\.submissionDeadline, true\)/);
  assert.match(source, /addBoundary\(application\.acceptanceDeadline, true\)/);
  assert.doesNotMatch(source, /contract(?:Before|AtOrBefore|AtOrAfter)\([^\n]*Date\.now/);
});

test("closed campaign actions retain confirm-only recovery without broadcasting a new plan", async () => {
  const source = await readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8");
  const executeStart = source.indexOf("async function executePrepared");
  const executeEnd = source.indexOf("async function apply", executeStart);
  const execute = source.slice(executeStart, executeEnd);
  const localRecovery = execute.indexOf("if (existing)");
  const localOnlyGuard = execute.indexOf("if (input.recoveryOnly)");
  const submittedRecovery = execute.indexOf("const submitted = preparedMarketplaceRecovery(prepared)");
  const serverOnlyGuard = execute.indexOf("if (input.serverRecoveryOnly)", submittedRecovery);
  const transactionGuard = execute.indexOf("if (!prepared.transaction)", serverOnlyGuard);
  const broadcast = execute.indexOf("broadcastMarketplaceTransaction(prepared.transaction", transactionGuard);
  assert.ok(localRecovery >= 0 && localOnlyGuard > localRecovery, "actor-scoped local recovery must confirm before recovery-only failure");
  assert.ok(submittedRecovery >= 0 && serverOnlyGuard > submittedRecovery, "server recovery must be accepted before fail-closed recovery mode");
  assert.ok(transactionGuard > serverOnlyGuard && broadcast > transactionGuard, "confirm-only mode must stop before any transaction can broadcast");
  assert.match(execute, /const readyRetry = input\.serverRecoveryOnly\s*\? undefined/);
  assert.match(execute, /input\.serverRecoveryOnly \? \{ headers: \{ "x-marketplace-recovery-only": "1" \} \} : \{\}/);
  assert.match(execute, /if \(!input\.serverRecoveryOnly && !isExplicitEip1193UserRejection\(error\)\)/);

  assert.match(source, /const canCheckServerSelect = application\.status === "applied"[\s\S]*onSelect\(application, true\)/);
  assert.match(source, /const canCheckServerWithdraw = application\.status === "applied"[\s\S]*onWithdraw\(application, true\)/);
  assert.match(source, /const canCheckServerAccept = selected[\s\S]*onAccept\(application, true\)/);
  assert.match(source, /const canCheckServerSubmit = accepted[\s\S]*recoveryCheck onSubmit=\{onSubmit\}/);
  assert.match(source, /hasSubmitRecovery \? <button[\s\S]*onRecoverSubmission\(application\)/);
  assert.match(source, /const canCheckServerCancel = isBrand[\s\S]*&& !canCancel/);
  assert.match(source, /cancelCampaign\(true\)/);

  const settlementStart = source.indexOf("function SettlementControls");
  const settlementEnd = source.indexOf("function EvidenceSubmissionForm", settlementStart);
  const settlement = source.slice(settlementStart, settlementEnd);
  const settlementRecovery = settlement.indexOf("const submitted = preparedMarketplaceRecovery(prepared)");
  const settlementServerGuard = settlement.indexOf("if (serverRecoveryOnly)", settlementRecovery);
  const settlementTransaction = settlement.indexOf("if (!prepared.transaction)", settlementServerGuard);
  const settlementBroadcast = settlement.indexOf("broadcastMarketplaceTransaction(prepared.transaction", settlementTransaction);
  assert.ok(settlementRecovery >= 0 && settlementServerGuard > settlementRecovery);
  assert.ok(settlementTransaction > settlementServerGuard && settlementBroadcast > settlementTransaction);
  assert.match(settlement, /serverRecoveryOnly \? undefined : readyRetries\.current\[kind\]/);
  assert.match(settlement, /serverRecoveryOnly \? \{ headers: \{ "x-marketplace-recovery-only": "1" \} \} : \{\}/);
  assert.match(settlement, /isBrandActor && hasRefundRecovery/);
  assert.match(settlement, /canCheckServerRefund[\s\S]*execute\("refund-unallocated", true\)/);
});

test("server-derived action timers re-arm safely and all campaign actions share one lock", async () => {
  const source = await readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8");
  const clockStart = source.indexOf("const nextActionBoundary");
  const clockEnd = source.indexOf("async function executePrepared", clockStart);
  const clock = source.slice(clockStart, clockEnd);
  assert.match(clock, /const remaining = nextActionBoundary - actionClock/);
  assert.match(clock, /const delay = capped \? 2_147_000_000 : Math\.max\(0, remaining \+ 250\)/);
  assert.match(clock, /const advanceTo = capped \? actionClock \+ 2_147_000_000 : nextActionBoundary/);
  assert.match(clock, /setActionClock\(\(current\) => current === null \? null : Math\.max\(current, advanceTo\)\)/);
  assert.match(clock, /\[actionClock, loadDetail, nextActionBoundary\]/);
  assert.doesNotMatch(clock, /Date\.now|Math\.max\(15_000/);
  assert.match(source, /setActionClock\(null\);\s*void loadDetail\(\)/);
  assert.match(source, /const transactionLocked = action\.key !== null \|\| fundingBusy \|\| settlementBusy/);
  assert.ok((source.match(/disabled=\{transactionLocked\}/g) ?? []).length >= 10);
  assert.match(source, /<fieldset className="transaction-lock" disabled=\{transactionLocked\}>/);
});

test("campaign refreshes reject older server-clock snapshots without clearing ready plans", async () => {
  const source = await readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8");
  assert.match(source, /const latestObservedAt = useRef\(-1\)/);
  assert.match(source, /if \(responseObservedAt < latestObservedAt\.current\) return/);
  assert.match(source, /setState\(\(current\) => \{[\s\S]*responseObservedAt < currentObservedAt[\s\S]*return current/);
  const loadStart = source.indexOf("const loadDetail = useCallback");
  const executeStart = source.indexOf("async function executePrepared", loadStart);
  assert.doesNotMatch(source.slice(loadStart, executeStart), /delete readyRetries\.current/);
});

test("exact wallet-rejected cancel and resolution plans survive detail and deadline refresh", async () => {
  const source = await readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8");
  const loadStart = source.indexOf("const loadDetail = useCallback");
  const executeStart = source.indexOf("async function executePrepared", loadStart);
  const refreshPath = source.slice(loadStart, executeStart);
  assert.doesNotMatch(refreshPath, /delete readyRetries\.current/);
  assert.match(refreshPath, /nextCampaignActionBoundary\(state\.detail, actionClock\)/);
  assert.match(refreshPath, /window\.setTimeout\([\s\S]*void loadDetail\(\)/);
  assert.match(refreshPath, /document\.addEventListener\("visibilitychange", refreshVisibleState\)/);
  assert.match(refreshPath, /window\.addEventListener\("focus", refreshVisibleState\)/);

  const executeEnd = source.indexOf("async function apply", executeStart);
  const execute = source.slice(executeStart, executeEnd);
  assert.match(execute, /matchingMarketplaceReadyRetry\(readyRetry, actor, requestBody\)/);
  assert.match(execute, /if \(!input\.serverRecoveryOnly && !isExplicitEip1193UserRejection\(error\)\)[\s\S]*delete readyRetries\.current\[input\.key\]/);
  assert.doesNotMatch(execute, /revalidateOnRetry/);

  const cancelStart = source.indexOf("async function cancelCampaign");
  const cancelEnd = source.indexOf('if (state.phase === "loading"', cancelStart);
  const actionCalls = source.slice(source.indexOf("async function requestResolution"), cancelEnd);
  assert.doesNotMatch(actionCalls, /revalidateOnRetry|delete readyRetries\.current/);
});

test("resolution UI shows deterministic contract checks without a generated narrative", async () => {
  const source = await readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8");
  assert.match(source, /application\.resolutionChecks/);
  assert.match(source, /AUTHOR MATCH/);
  assert.match(source, /CONTENT ID MATCH/);
  assert.match(source, /DISCLOSURE PRESENT/);
  assert.match(source, /SEMANTIC PASS/);
  assert.doesNotMatch(source, /generated narrative/i);
  assert.doesNotMatch(source, /application\.(?:reasoning|narrative)/);
});

test("X and Farcaster verification prepare both proofs and submit one pinned bundle transaction", async () => {
  const source = await readFile(new URL("../app/verify/VerifyFlow.tsx", import.meta.url), "utf8");
  assert.match(source, /\/api\/verification\/identity-challenge/);
  assert.match(
    source,
    /requestBody\(\{\s*requestId: request\.id,\s*handle: normalizeXHandle\(handle\),\s*farcasterUsername: normalizeFarcasterUsername\(farcasterUsername\),\s*\}\)/,
  );
  assert.doesNotMatch(source, /name="farcasterFid"|parseFarcasterFid|farcasterFid:\s*parseFarcasterFid/);
  assert.match(source, /farcasterFid: result\.farcasterChallenge\.fid/);
  assert.match(source, /\/api\/verification\/activation/);
  assert.match(source, /requestId: request\.id, verificationPostUrl: normalizedVerificationPostUrl, farcasterCastUrl: normalizedFarcasterCastUrl/);
  assert.match(source, /FARCASTER CAST URL/);
  const castUrlField = source.match(/<label[^>]*>\s*<span>FARCASTER CAST URL<\/span>[\s\S]*?<\/label>/)?.[0];
  assert.ok(castUrlField);
  assert.match(castUrlField, /name="farcasterCastUrl"/);
  assert.match(castUrlField, /type="url"/);
  assert.doesNotMatch(castUrlField, /\bpattern=/);
  assert.doesNotMatch(source, /FARCASTER CAST HASH|INVALID_FARCASTER_CAST_HASH|name="castHash"|normalizeCastHash/);
  assert.match(source, /INVALID_FARCASTER_CAST_URL: "Paste the full Farcaster cast URL\."/);
  assert.match(source, /FARCASTER_CAST_LOOKUP_UNAVAILABLE: "Farcaster is temporarily unavailable\. Retry\."/);
  assert.match(source, /expectedFunctionName: "activate_identity_bundle"/);
  assert.match(source, /VERIFY BOTH · 1 TRANSACTION/);
  assert.match(source, /expired \|\| terminalOutcome \? "START AGAIN"/);
  assert.equal(source.match(/1 TRANSACTION/g)?.length, 1);
  assert.doesNotMatch(source, /Pinned to this wallet|ONE WALLET TRANSACTION|NO SOCIAL PASSWORDS/);
  assert.match(source, /\/api\/verification\/activation\/submitted/);
  assert.match(source, /onSubmitted: async \(hash\)/);
  assert.match(source, /genlayerOutcome === "UNDETERMINED"/);
  assert.match(source, /retryableUndetermined \? "RETRY BOTH →"/);
  assert.match(source, /broadcastMarketplaceTransaction/);
  assert.match(source, /preparedId: value\.preparedId, txHash: value\.txHash/);
  const activation = source.slice(
    source.indexOf("async function activateBundle"),
    source.indexOf("async function confirmActivation"),
  );
  const recoveryBranch = activation.indexOf("if (recovery)");
  const castUrlRead = activation.indexOf("farcasterCastUrl.trim()");
  assert.ok(recoveryBranch >= 0 && castUrlRead > recoveryBranch);
  assert.match(activation, /activationReadyRetryRef\.current/);
  assert.match(activation, /ready\.requestId === request\.id/);
  assert.match(activation, /ready\.wallet === normalizedWallet/);
  assert.match(activation, /ready\.verificationPostUrl === normalizedVerificationPostUrl/);
  assert.match(activation, /ready\.farcasterCastUrl === normalizedFarcasterCastUrl/);
  const reuseReady = activation.indexOf("reusableReady?.prepared ?? await api<PreparedActivation>");
  const readyStored = activation.indexOf("activationReadyRetryRef.current = {", reuseReady);
  const activationBroadcast = activation.indexOf("await broadcastMarketplaceTransaction", readyStored);
  assert.ok(reuseReady >= 0 && readyStored > reuseReady && activationBroadcast > readyStored);
  const submitted = activation.indexOf("onSubmitted: async (hash)", activationBroadcast);
  assert.ok(activation.indexOf("activationReadyRetryRef.current = null", submitted) > submitted);
  assert.match(activation, /readyMayBeRetried && isExplicitEip1193UserRejection\(activationError\)/);
  assert.doesNotMatch(source, /\/api\/verification\/(?:x-challenge|farcaster-challenge)/);
  assert.doesNotMatch(source, /expectedFunctionName: "activate_(?:creator|farcaster_creator)"/);
  assert.doesNotMatch(source, /\/api\/verification\/(intent|submit)/);
  assert.doesNotMatch(source, /BASE RELAY|BASE SEPOLIA/);

  const transactionSource = await readFile(new URL("../app/marketplace/marketplace-transaction.ts", import.meta.url), "utf8");
  assert.match(transactionSource, /await options\.onSubmitted\?\.\(hash\)/);
  assert.ok(transactionSource.indexOf("await options.onSubmitted?.(hash)") < transactionSource.indexOf("waitForTransactionReceipt"));
  assert.match(transactionSource, /plan\.functionName === "resolve_assignment"/);
  assert.match(transactionSource, /getTriggeredTransactionIds\(\{ hash: hash as never \}\)/);
  assert.match(transactionSource, /triggered\.length !== 2/);
  assert.match(transactionSource, /hash: triggered\[1\] as never/);
  assert.match(transactionSource, /assertMarketplaceTransactionFinality\(fallbackReceipt\)/);
  assert.doesNotMatch(transactionSource, /activate_creator|activate_farcaster_creator/);
});

test("V2 marketplace UI accepts public X and Farcaster evidence links", async () => {
  const [createSource, detailSource, directorySource, profileSource] = await Promise.all([
    readFile(new URL("../app/marketplace/create/CreateCampaignForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/marketplace/components/CampaignDirectory.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/marketplace/creators/[wallet]/CreatorProfile.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(createSource, /contentSource/);
  assert.match(createSource, /FARCASTER/);
  assert.match(directorySource, /campaignContentSource/);
  const evidenceStart = detailSource.indexOf("function EvidenceSubmissionForm");
  const evidenceEnd = detailSource.indexOf("function ResolutionControl", evidenceStart);
  const evidenceForm = detailSource.slice(evidenceStart, evidenceEnd);
  assert.match(evidenceForm, /FARCASTER CAST URL/);
  assert.match(evidenceForm, /X POST URL/);
  assert.match(evidenceForm, /type="url"/);
  assert.match(evidenceForm, /https:\/\/farcaster\.xyz\/username\/0x…/);
  assert.match(evidenceForm, /https:\/\/x\.com\/username\/status\/…/);
  assert.doesNotMatch(evidenceForm, /\bpattern=/);
  assert.doesNotMatch(evidenceForm, /CAST HASH|POST ID|20-byte|numeric ID/);
  assert.match(detailSource, /contentId/);
  assert.match(profileSource, /creator\.farcaster/);
  assert.match(profileSource, /FARCASTER/);
  assert.match(profileSource, /creator\.x/);
  assert.match(profileSource, /activationTxHash/);
  assert.doesNotMatch(profileSource, /baseProfileId|publicHandle|verificationPostHash|handleHash|xPostId/);
  assert.doesNotMatch(profileSource, /useCreatorMetrics|marketplace-metrics|estimatedPay/);
});

test("active marketplace and verification UI is StudioNet-native with no Base transaction path", async () => {
  const sources = await Promise.all([
    "../app/page.tsx",
    "../app/layout.tsx",
    "../app/privacy/page.tsx",
    "../app/terms/page.tsx",
    "../app/verify/VerifyFlow.tsx",
    "../app/marketplace/components/CampaignDirectory.tsx",
    "../app/marketplace/components/MarketplaceHeader.tsx",
    "../app/marketplace/create/CreateCampaignForm.tsx",
    "../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx",
    "../app/marketplace/campaigns/[campaignId]/CampaignFunding.tsx",
    "../app/marketplace/creators/[wallet]/CreatorProfile.tsx",
    "../app/marketplace/marketplace-types.ts",
    "../app/marketplace/use-marketplace-wallet.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const combined = sources.join("\n");
  assert.match(combined, /GENLAYER STUDIONET/);
  assert.match(combined, /TEST GEN/);
  assert.match(combined, /docs\.genlayer\.com\/developers\/networks#studionet/);
  assert.match(combined, /built-in 💧 faucet/);
  assert.doesNotMatch(combined, /\bBASE\b|\bUSDC\b|84532|basescan|\bescrow\b|\bwatcher\b|\brelay\b/i);
  assert.doesNotMatch(combined, /eth_sendTransaction|wallet_sendCalls|createWalletClient|encodeFunctionData/);
  assert.doesNotMatch(combined, /\/api\/verification\/(?:intent|submit)/);
  assert.doesNotMatch(combined, />Thread<|>Video<|X thread/i);
});
