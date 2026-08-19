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
  assertMarketplaceTransactionFinality,
  assertMarketplaceWalletContext,
  hydrateArgs,
  validatePlan,
} from "../app/marketplace/marketplace-transaction.ts";
import { farcasterCastUrlForHash } from "../app/verify/farcaster-cast-url.ts";
import { shouldRejectVerificationResponse } from "../app/verify/verification-api-client.ts";
import { parseBoundIdentityBundleRecovery, recoveryMatchesActiveBundle } from "../app/verify/verification-recovery.ts";
import { MarketplaceApiError, marketplaceErrorMessage } from "../app/marketplace/marketplace-api.ts";
import {
  classifyCreatorMetrics,
  MAX_CREATOR_METRICS_CONCURRENCY,
  normalizeCreatorMetricWallets,
} from "../app/marketplace/use-creator-metrics.ts";
import type { MarketplaceMetricsDto } from "../lib/marketplace-types.ts";

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

test("never presents absent GenLayer funding as confirmed", () => {
  assert.equal(fundingStatusLabel(undefined), "FUNDING UNAVAILABLE");
  assert.equal(fundingStatusLabel("unfunded"), "NOT YET FUNDED");
  assert.equal(fundingStatusLabel("funded"), "FUNDED ON GENLAYER");
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
  assert.match(marketplaceErrorMessage(new MarketplaceApiError(409, "Wallet mismatch.", "SESSION_WALLET_MISMATCH")), /Sign out, then reconnect/);
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
  assert.match(source, /saveRecovery\(input\.key/);
  assert.match(source, /body: JSON\.stringify\(\{ preparedId: prepared\.preparedId, txHash \}\)/);
  const broadcast = source.indexOf("await broadcastMarketplaceTransaction");
  const confirmation = source.indexOf("await marketplaceRequest(confirmPath", broadcast);
  const clear = source.indexOf("clearRecovery(input.key)", confirmation);
  const productReload = source.indexOf("await loadDetail()", confirmation);
  assert.ok(broadcast >= 0 && confirmation > broadcast, "server confirmation must follow wallet finality");
  assert.ok(clear > confirmation && productReload > confirmation, "a failed server confirmation must retain recovery and not update product state");
});

test("campaign funding persists both prepared ID and submitted hash without auto-rebroadcast", async () => {
  const source = await readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignFunding.tsx", import.meta.url), "utf8");
  assert.match(source, /const recovery = \{ preparedId: prepared\.preparedId, txHash: hash \}/);
  assert.match(source, /sessionStorage\.setItem\(recoveryKey, JSON\.stringify\(recovery\)\)/);
  assert.match(source, /if \(submitted\)[\s\S]*confirm\(submitted\.preparedId, submitted\.txHash\)[\s\S]*return/);
  assert.match(source, /RECONCILE SUBMITTED TRANSACTION/);
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

test("GenLayer settlement UI confirms contract state before displaying a claim or refund", async () => {
  const source = await readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8");
  assert.match(source, /GENLAYER BALANCES/);
  assert.match(source, /preparedId: prepared\.preparedId, txHash/);
  assert.match(source, /REFUND UNUSED GEN/);
  assert.match(source, /REQUEST GEN WITHDRAWAL/);
  assert.match(source, /EXECUTE GEN WITHDRAWAL/);
  assert.match(source, /EMITTED_UNCONFIRMED/);
  assert.match(source, /NOT YET PAID/);
  assert.match(source, /studionet-settlement/);
  assert.doesNotMatch(source, /set(?:Campaign|Application).*paid|set(?:Campaign|Application).*refunded/i);
});

test("UNDETERMINED exposes bounded retry and refund paths", async () => {
  const source = await readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8");
  assert.match(source, /application\.resolutionOutcome === "undetermined"/);
  assert.match(source, /RETRY RESOLUTION/);
  assert.match(source, /REFUND AFTER RETRY CEILING/);
  assert.match(source, /No payout or refund was assigned/);
});

test("resolution UI shows deterministic contract checks without a generated narrative", async () => {
  const source = await readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8");
  assert.match(source, /application\.resolutionChecks/);
  assert.match(source, /AUTHOR MATCH/);
  assert.match(source, /CONTENT ID MATCH/);
  assert.match(source, /DISCLOSURE PRESENT/);
  assert.match(source, /SEMANTIC PASS/);
  assert.match(source, /no generated narrative is shown/i);
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
  assert.match(source, /requestId: request\.id, verificationPostUrl: postUrl\.trim\(\), farcasterCastUrl: normalizedFarcasterCastUrl/);
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
  assert.match(source, /Retry with the same two posts/);
  assert.match(source, /broadcastMarketplaceTransaction/);
  assert.match(source, /preparedId: value\.preparedId, txHash: value\.txHash/);
  const activation = source.slice(
    source.indexOf("async function activateBundle"),
    source.indexOf("async function confirmActivation"),
  );
  const recoveryBranch = activation.indexOf("if (recovery)");
  const castUrlRead = activation.indexOf("farcasterCastUrl.trim()");
  assert.ok(recoveryBranch >= 0 && castUrlRead > recoveryBranch);
  assert.doesNotMatch(source, /\/api\/verification\/(?:x-challenge|farcaster-challenge)/);
  assert.doesNotMatch(source, /expectedFunctionName: "activate_(?:creator|farcaster_creator)"/);
  assert.doesNotMatch(source, /\/api\/verification\/(intent|submit)/);
  assert.doesNotMatch(source, /BASE RELAY|BASE SEPOLIA/);

  const transactionSource = await readFile(new URL("../app/marketplace/marketplace-transaction.ts", import.meta.url), "utf8");
  assert.match(transactionSource, /await options\.onSubmitted\?\.\(hash\)/);
  assert.ok(transactionSource.indexOf("await options.onSubmitted?.(hash)") < transactionSource.indexOf("waitForTransactionReceipt"));
  assert.doesNotMatch(transactionSource, /activate_creator|activate_farcaster_creator/);
});

test("V2 marketplace UI binds campaigns and content IDs to X or Farcaster", async () => {
  const [createSource, detailSource, directorySource, profileSource] = await Promise.all([
    readFile(new URL("../app/marketplace/create/CreateCampaignForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/marketplace/campaigns/[campaignId]/CampaignDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/marketplace/components/CampaignDirectory.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/marketplace/creators/[wallet]/CreatorProfile.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(createSource, /contentSource/);
  assert.match(createSource, /FARCASTER/);
  assert.match(directorySource, /campaignContentSource/);
  assert.match(detailSource, /0x\[0-9a-fA-F\]\{40\}/);
  assert.match(detailSource, /\[0-9\]\{5,25\}/);
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
