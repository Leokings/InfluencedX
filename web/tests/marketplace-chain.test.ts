import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  parseAbiParameters,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assignmentAgreementHash,
  campaignTermsHash,
  canonicalMarketplaceJson,
} from "../lib/marketplace-commitments.ts";
import {
  BASE_SEPOLIA_CHAIN_ID,
  INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT,
  buildCampaignResolutionTypedData,
  deriveCampaignResolutionRequestId,
  extractAssignmentAccepted,
  extractCampaignCreated,
  extractCreatorSelected,
  extractEvidenceSubmitted,
  extractResolutionRequested,
  extractUnallocatedCredited,
  extractWithdrawal,
  marketplaceEscrowAbi,
  nativeUsdcAbi,
  parseUsdcAmount,
  prepareAssignmentAcceptance,
  prepareCampaignFunding,
  prepareCampaignResolutionRelay,
  prepareCreatorSelection,
  prepareEvidenceSubmission,
  prepareEscrowWithdrawal,
  prepareResolutionRequest,
  prepareUnallocatedBudgetCredit,
} from "../lib/marketplace-chain.ts";

const brand = getAddress("0x1111111111111111111111111111111111111111");
const creator = getAddress("0x2222222222222222222222222222222222222222");
const terms = {
  title: "Base launch campaign",
  deliverables: ["One original X post", "Keep public for 7 days"],
  requireAdDisclosure: true,
};
const termsHash = campaignTermsHash(terms);
const identityHash = `0x${"33".repeat(32)}` as Hex;

function concreteTopics(
  topics: readonly (Hex | readonly Hex[] | null)[],
): readonly Hex[] {
  return topics.map((topic) => {
    if (typeof topic !== "string") throw new Error("Expected a concrete event topic.");
    return topic;
  });
}

function agreementInput() {
  return {
    chainId: BASE_SEPOLIA_CHAIN_ID,
    escrowCampaignId: 17n,
    campaignRecordId: "campaign_01JTEST",
    campaignRevision: 4n,
    applicationRecordId: "application_01JTEST",
    applicationRevision: 2n,
    termsHash,
    brandWallet: brand,
    creatorWallet: creator,
    identityHash,
    payoutAtoms: 125_500_000n,
  };
}

test("marketplace commitments are canonical, domain-separated, and reject ambiguous JSON", () => {
  const left = { z: [3, { b: 2, a: 1 }], a: "same" };
  const right = { a: "same", z: [3, { a: 1, b: 2 }] };
  assert.equal(canonicalMarketplaceJson(left), canonicalMarketplaceJson(right));
  assert.equal(campaignTermsHash(left), campaignTermsHash(right));
  assert.notEqual(campaignTermsHash(left), assignmentAgreementHash(left));
  assert.throws(() => canonicalMarketplaceJson({ rate: 0.1 }), /safe integer/);
  assert.throws(() => canonicalMarketplaceJson({ missing: undefined }), /non-JSON/);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => canonicalMarketplaceJson(circular), /circular/);
});

test("campaign funding pins native Base Sepolia USDC and approves only the exact budget", () => {
  const plan = prepareCampaignFunding({
    chainId: BASE_SEPOLIA_CHAIN_ID,
    brand,
    termsDocument: terms,
    budgetUsdc: "125.50",
    applicationDeadline: 1_800_000_100n,
    selectionDeadline: 1_800_000_200n,
    submissionDeadline: 1_800_000_300n,
    retentionSeconds: 86_400n,
    nowSeconds: 1_800_000_000n,
  });
  assert.equal(plan.budgetAtoms, 125_500_000n);
  assert.equal(plan.approvalCall.address, INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.usdc);
  assert.equal(plan.createCampaignCall.address, INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow);

  const approval = decodeFunctionData({ abi: nativeUsdcAbi, data: plan.approvalCall.data });
  assert.equal(approval.functionName, "approve");
  assert.deepEqual(approval.args, [
    INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
    125_500_000n,
  ]);
  const create = decodeFunctionData({ abi: marketplaceEscrowAbi, data: plan.createCampaignCall.data });
  assert.equal(create.functionName, "createCampaign");
  assert.deepEqual(create.args, [
    plan.termsHash,
    125_500_000n,
    1_800_000_100n,
    1_800_000_200n,
    1_800_000_300n,
    86_400n,
  ]);
});

test("USDC and campaign validation rejects wrong precision, wrong chain, zero, and bad deadlines", () => {
  assert.equal(parseUsdcAmount("0.000001"), 1n);
  assert.throws(() => parseUsdcAmount("1.0000001"), /at most 6/);
  assert.throws(() => parseUsdcAmount("1e3"), /at most 6/);
  const valid = {
    chainId: BASE_SEPOLIA_CHAIN_ID,
    brand,
    termsDocument: terms,
    budgetUsdc: "1",
    applicationDeadline: 101,
    selectionDeadline: 102,
    submissionDeadline: 103,
    retentionSeconds: 1,
    nowSeconds: 100,
  };
  assert.throws(() => prepareCampaignFunding({ ...valid, chainId: 8453 }), /Base Sepolia/);
  assert.throws(() => prepareCampaignFunding({ ...valid, budgetUsdc: "0" }), /greater than zero/);
  assert.throws(
    () => prepareCampaignFunding({ ...valid, selectionDeadline: 101 }),
    /strictly ordered/,
  );
});

test("selection, acceptance, and evidence calls bind the persisted records deterministically", () => {
  const selection = prepareCreatorSelection(agreementInput());
  assert.equal(selection.agreementHash, assignmentAgreementHash(selection.agreement));
  const decodedSelection = decodeFunctionData({
    abi: marketplaceEscrowAbi,
    data: selection.call.data,
  });
  assert.equal(decodedSelection.functionName, "selectCreator");
  assert.deepEqual(decodedSelection.args, [
    17n,
    creator,
    identityHash,
    selection.agreementHash,
    125_500_000n,
  ]);

  const acceptance = prepareAssignmentAcceptance({
    chainId: BASE_SEPOLIA_CHAIN_ID,
    assignmentId: 9,
  });
  assert.equal(
    decodeFunctionData({ abi: marketplaceEscrowAbi, data: acceptance.data }).functionName,
    "acceptAssignment",
  );

  const evidence = prepareEvidenceSubmission({
    chainId: BASE_SEPOLIA_CHAIN_ID,
    assignmentId: 9,
    agreementHash: selection.agreementHash,
    creatorWallet: creator,
    expectedHandle: "@Creator_Name",
    xPostId: "2109876543210987654",
  });
  assert.equal(evidence.submission.expectedHandle, "creator_name");
  assert.match(evidence.postIdHash, /^0x[0-9a-f]{64}$/);
  assert.match(evidence.submissionHash, /^0x[0-9a-f]{64}$/);
  const decodedEvidence = decodeFunctionData({
    abi: marketplaceEscrowAbi,
    data: evidence.call.data,
  });
  assert.deepEqual(decodedEvidence.args, [9n, evidence.postIdHash, evidence.submissionHash]);
});

test("resolution request IDs match the exact deployed escrow formula", () => {
  const selection = prepareCreatorSelection(agreementInput());
  const submissionHash = `0x${"44".repeat(32)}` as Hex;
  const requestId = deriveCampaignResolutionRequestId({
    chainId: BASE_SEPOLIA_CHAIN_ID,
    assignmentId: 9,
    resolutionRound: 2,
    agreementHash: selection.agreementHash,
    submissionHash,
  });
  const manual = keccak256(encodeAbiParameters(
    parseAbiParameters(
      "uint256 chainId, address escrow, uint256 assignmentId, uint32 resolutionRound, bytes32 agreementHash, bytes32 submissionHash",
    ),
    [
      84_532n,
      INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
      9n,
      2,
      selection.agreementHash,
      submissionHash,
    ],
  ));
  assert.equal(requestId, manual);
  const request = prepareResolutionRequest({ chainId: BASE_SEPOLIA_CHAIN_ID, assignmentId: 9 });
  assert.equal(
    decodeFunctionData({ abi: marketplaceEscrowAbi, data: request.data }).functionName,
    "requestResolution",
  );
});

test("campaign settlement preparation validates watcher quorum and orders signatures for Solidity", async () => {
  const watcherA = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const watcherB = privateKeyToAccount(`0x${"22".repeat(32)}`);
  const typedData = buildCampaignResolutionTypedData({
    chainId: BASE_SEPOLIA_CHAIN_ID,
    requestId: `0x${"55".repeat(32)}`,
    assignmentId: 9,
    outcome: 1,
    evidenceHash: `0x${"66".repeat(32)}`,
    genlayerTxHash: `0x${"77".repeat(32)}`,
    resolvedAt: 1_800_000_000,
    relayDeadline: 1_800_000_600,
    nowSeconds: 1_800_000_100,
  });
  const [signatureA, signatureB] = await Promise.all([
    watcherA.signTypedData(typedData),
    watcherB.signTypedData(typedData),
  ]);
  const relay = await prepareCampaignResolutionRelay({
    typedData,
    signatures: [signatureB, signatureA],
    authorizedWatchers: [watcherA.address, watcherB.address],
    threshold: 2,
  });
  const expectedFirst = [watcherA.address, watcherB.address]
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()))[0];
  const signatureForFirst = expectedFirst === watcherA.address ? signatureA : signatureB;
  assert.equal(relay.sortedSignatures[0], signatureForFirst);
  assert.equal(relay.call.functionName, "submitCampaignResolution");
  await assert.rejects(
    prepareCampaignResolutionRelay({
      typedData,
      signatures: [signatureA],
      authorizedWatchers: [watcherA.address, watcherB.address],
      threshold: 2,
    }),
    /quorum/,
  );
});

test("receipt decoders reject client-supplied IDs and extract only authentic escrow events", () => {
  const budget = 125_500_000n;
  const campaignTopics = encodeEventTopics({
    abi: marketplaceEscrowAbi,
    eventName: "CampaignCreated",
    args: { campaignId: 17n, brand, termsHash },
  });
  const campaignLog = {
    address: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
    topics: concreteTopics(campaignTopics),
    data: encodeAbiParameters(parseAbiParameters("uint256 deposited"), [budget]),
  };
  assert.equal(extractCampaignCreated({
    receiptStatus: "success",
    logs: [campaignLog],
    expectedBrand: brand,
    expectedTermsHash: termsHash,
    expectedDeposited: budget,
  }).campaignId, 17n);
  assert.throws(() => extractCampaignCreated({
    receiptStatus: "success",
    logs: [campaignLog],
    expectedBrand: creator,
    expectedTermsHash: termsHash,
    expectedDeposited: budget,
  }), /does not match/);

  const selectionTopics = encodeEventTopics({
    abi: marketplaceEscrowAbi,
    eventName: "CreatorSelected",
    args: { assignmentId: 9n, campaignId: 17n, creator },
  });
  const selectionLog = {
    address: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
    topics: concreteTopics(selectionTopics),
    data: encodeAbiParameters(parseAbiParameters("uint256 payout"), [budget]),
  };
  assert.equal(extractCreatorSelected({
    receiptStatus: "success",
    logs: [selectionLog],
    expectedCampaignId: 17n,
    expectedCreator: creator,
    expectedPayout: budget,
  }).assignmentId, 9n);

  const agreementHash = prepareCreatorSelection(agreementInput()).agreementHash;
  const acceptanceTopics = encodeEventTopics({
    abi: marketplaceEscrowAbi,
    eventName: "AssignmentAccepted",
    args: { assignmentId: 9n, agreementHash },
  });
  const acceptanceLog = {
    address: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
    topics: concreteTopics(acceptanceTopics),
    data: "0x" as Hex,
  };
  assert.equal(extractAssignmentAccepted({
    receiptStatus: "success",
    logs: [acceptanceLog],
    expectedAssignmentId: 9n,
    expectedAgreementHash: agreementHash,
  }).agreementHash, agreementHash);
  assert.throws(() => extractAssignmentAccepted({
    receiptStatus: "success",
    logs: [acceptanceLog],
    expectedAssignmentId: 10n,
    expectedAgreementHash: agreementHash,
  }), /does not match/);

  const postIdHash = `0x${"71".repeat(32)}` as Hex;
  const submissionHash = `0x${"72".repeat(32)}` as Hex;
  const evidenceTopics = encodeEventTopics({
    abi: marketplaceEscrowAbi,
    eventName: "EvidenceSubmitted",
    args: { assignmentId: 9n, postIdHash, submissionHash },
  });
  const evidenceLog = {
    address: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
    topics: concreteTopics(evidenceTopics),
    data: "0x" as Hex,
  };
  assert.equal(extractEvidenceSubmitted({
    receiptStatus: "success",
    logs: [evidenceLog],
    expectedAssignmentId: 9n,
    expectedPostIdHash: postIdHash,
    expectedSubmissionHash: submissionHash,
  }).submissionHash, submissionHash);

  const requestId = `0x${"73".repeat(32)}` as Hex;
  const resolutionTopics = encodeEventTopics({
    abi: marketplaceEscrowAbi,
    eventName: "ResolutionRequested",
    args: { assignmentId: 9n, requestId, round: 2 },
  });
  const resolutionLog = {
    address: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
    topics: concreteTopics(resolutionTopics),
    data: encodeAbiParameters(
      parseAbiParameters("bytes32 agreementHash, bytes32 submissionHash"),
      [agreementHash, submissionHash],
    ),
  };
  assert.equal(extractResolutionRequested({
    receiptStatus: "success",
    logs: [resolutionLog],
    expectedAssignmentId: 9n,
    expectedRequestId: requestId,
    expectedRound: 2,
    expectedAgreementHash: agreementHash,
    expectedSubmissionHash: submissionHash,
  }).requestId, requestId);
});

test("escrow recovery calls remain pinned to the audited Base Sepolia escrow", () => {
  const credit = prepareUnallocatedBudgetCredit({
    chainId: BASE_SEPOLIA_CHAIN_ID,
    campaignId: 17n,
  });
  const decodedCredit = decodeFunctionData({
    abi: marketplaceEscrowAbi,
    data: credit.data,
  });
  assert.equal(credit.address, INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow);
  assert.equal(decodedCredit.functionName, "creditUnallocatedBudget");
  assert.deepEqual(decodedCredit.args, [17n]);

  const withdrawal = prepareEscrowWithdrawal({ chainId: BASE_SEPOLIA_CHAIN_ID });
  const decodedWithdrawal = decodeFunctionData({
    abi: marketplaceEscrowAbi,
    data: withdrawal.data,
  });
  assert.equal(withdrawal.address, INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow);
  assert.equal(decodedWithdrawal.functionName, "withdraw");
  assert.equal(decodedWithdrawal.args, undefined);
  assert.throws(
    () => prepareUnallocatedBudgetCredit({ chainId: 8_453, campaignId: 17n }),
    /Base Sepolia/,
  );
});

test("unused-budget and withdrawal receipts require one exact authenticated escrow event", () => {
  const amount = 42_000_000n;
  const creditTopics = encodeEventTopics({
    abi: marketplaceEscrowAbi,
    eventName: "UnallocatedCredited",
    args: { campaignId: 17n, brand },
  });
  const creditLog = {
    address: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
    topics: concreteTopics(creditTopics),
    data: encodeAbiParameters(parseAbiParameters("uint256 amount"), [amount]),
  };
  const credited = extractUnallocatedCredited({
    receiptStatus: "success",
    logs: [creditLog],
    expectedCampaignId: 17n,
    expectedBrand: brand,
  });
  assert.equal(credited.amount, amount);
  assert.throws(() => extractUnallocatedCredited({
    receiptStatus: "success",
    logs: [creditLog],
    expectedCampaignId: 18n,
    expectedBrand: brand,
  }), /does not match/);
  assert.throws(() => extractUnallocatedCredited({
    receiptStatus: "success",
    logs: [creditLog],
    expectedCampaignId: 17n,
    expectedBrand: creator,
  }), /does not match/);
  assert.throws(() => extractUnallocatedCredited({
    receiptStatus: "success",
    logs: [creditLog, creditLog],
    expectedCampaignId: 17n,
    expectedBrand: brand,
  }), /exactly one/);

  const withdrawalTopics = encodeEventTopics({
    abi: marketplaceEscrowAbi,
    eventName: "Withdrawal",
    args: { account: creator },
  });
  const withdrawalLog = {
    address: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
    topics: concreteTopics(withdrawalTopics),
    data: encodeAbiParameters(parseAbiParameters("uint256 amount"), [amount]),
  };
  assert.equal(extractWithdrawal({
    receiptStatus: "success",
    logs: [withdrawalLog],
    expectedAccount: creator,
  }).amount, amount);
  assert.throws(() => extractWithdrawal({
    receiptStatus: "success",
    logs: [withdrawalLog],
    expectedAccount: brand,
  }), /does not match/);
  assert.throws(() => extractWithdrawal({
    receiptStatus: "reverted",
    logs: [withdrawalLog],
    expectedAccount: creator,
  }), /not successful/);
});

test("the adapter exposes only the audited Base Sepolia deployment", () => {
  assert.equal(INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.chainId, 84_532);
  assert.equal(
    INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.usdc,
    getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  );
  assert.equal(
    INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
    getAddress("0x7e9b6b757d1ef12509889826b2f2a42906661927"),
  );
});
