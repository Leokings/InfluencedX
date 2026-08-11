import { randomUUID } from "node:crypto";
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC_ADDRESS,
  type CampaignDetailResponse,
  type CampaignListResponse,
  type MarketplaceApplicationDto,
  type MarketplaceCampaignDto,
  type MarketplaceCreatorProfileDto,
  type MarketplaceMetricsDto,
} from "./marketplace-types.ts";
import {
  assertOptionalActorWallet,
  formatUsdcAmount,
  isoTime,
  parseUsdcAmount,
  requireFutureDeadline,
  requireStringList,
  requireText,
  requireUuid,
  usdcAtomsToDecimal,
} from "./marketplace-core.ts";
import {
  acceptApplicationAtomically,
  applicationCounts,
  confirmApplicationSelectionAtomically,
  confirmApplicationSubmissionAtomically,
  confirmApplicationResolutionRequestAtomically,
  confirmCampaignFundingAtomically,
  expireProfileIfNeeded,
  findApplication,
  findCampaign,
  findCreatorApplication,
  findPublicCreatorProfileByWallet,
  insertApplicationIfOpen,
  insertCampaign,
  latestMetricsForProfile,
  listApplicationsForCampaign,
  listCampaignRows,
  marketplaceSummary,
  prepareApplicationSubmissionAtomically,
  selectApplicationAtomically,
  upsertVerifiedCreatorProfile,
  type ApplicationRow,
  type CampaignRow,
  type CreatorMetricsRow,
  type CreatorProfileRow,
} from "./marketplace-repository.ts";
import { ApiProblem } from "./verification-api.ts";
import {
  marketplaceCampaignStatuses,
  type MarketplaceCampaignStatus,
} from "@/db/postgres-schema";
import type { AuthenticatedWalletSession } from "./wallet-session.ts";
import { campaignTermsHash } from "./marketplace-commitments.ts";
import {
  extractAssignmentAccepted,
  extractCampaignCreated,
  extractCreatorSelected,
  extractEvidenceSubmitted,
  extractResolutionRequested,
  INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT,
  prepareAssignmentAcceptance,
  prepareCampaignFunding,
  prepareCreatorSelection,
  prepareEvidenceSubmission,
  prepareResolutionRequest,
  deriveCampaignResolutionRequestId,
  type PreparedMarketplaceCall,
} from "./marketplace-chain.ts";
import {
  assertExactMarketplaceCall,
  loadConfirmedMarketplaceTransaction,
  requireTransactionHash,
  type ConfirmedMarketplaceTransaction,
} from "./marketplace-receipts.ts";
import type { MarketplaceTransactionDto } from "./marketplace-types.ts";

export async function createMarketplaceCampaign(input: {
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
  nowMs?: number;
}): Promise<MarketplaceCampaignDto> {
  const nowMs = input.nowMs ?? Date.now();
  assertOptionalActorWallet(input.body, "brandWallet", input.session.wallet);
  const walletLabel = `${input.session.wallet.slice(0, 6)}…${input.session.wallet.slice(-4)}`;
  const brandName =
    input.body.brandName === undefined
      ? walletLabel
      : requireText(input.body.brandName, "brandName", 2, 80);
  const id = randomUUID();
  const title = requireText(input.body.title, "title", 4, 120);
  const description = requireText(
    input.body.description,
    "description",
    20,
    5_000,
  );
  const category = requireText(input.body.category, "category", 2, 48);
  const format = requireText(input.body.format, "format", 2, 48);
  const deliverables = requireStringList(
    input.body.deliverables,
    "deliverables",
    { minItems: 1, maxItems: 12, maxItemLength: 280 },
  );
  const requiredPhrases = requireStringList(
    input.body.requiredPhrases ?? [],
    "requiredPhrases",
    { minItems: 0, maxItems: 20, maxItemLength: 160 },
  );
  const forbiddenPhrases = requireStringList(
    input.body.forbiddenPhrases ?? [],
    "forbiddenPhrases",
    { minItems: 0, maxItems: 20, maxItemLength: 160 },
  );
  const requireAdDisclosure = optionalBoolean(
    input.body.requireAdDisclosure,
    "requireAdDisclosure",
    true,
  );
  const semanticBrief =
    input.body.semanticBrief === undefined
      ? description
      : requireText(input.body.semanticBrief, "semanticBrief", 1, 2_000);
  const budgetAmount = parseUsdcAmount(input.body.budgetUsdc, "budgetUsdc");
  const deadlineAt = requireFutureDeadline(input.body.deadline, nowMs);
  const selectionDeadlineAt = optionalOrderedDeadline(
    input.body.selectionDeadline,
    "selectionDeadline",
    deadlineAt,
    deadlineAt + 7 * 24 * 60 * 60 * 1_000,
  );
  const submissionDeadlineAt = optionalOrderedDeadline(
    input.body.submissionDeadline,
    "submissionDeadline",
    selectionDeadlineAt,
    selectionDeadlineAt + 14 * 24 * 60 * 60 * 1_000,
  );
  const retentionSeconds = optionalRetentionSeconds(
    input.body.retentionSeconds,
  );
  const termsDocument = {
    schemaVersion: 1,
    network: "base-sepolia",
    chainId: BASE_SEPOLIA_CHAIN_ID,
    campaignRecordId: id,
    brandWallet: input.session.wallet,
    tokenAddress: BASE_SEPOLIA_USDC_ADDRESS,
    budgetAtoms: budgetAmount,
    title,
    description,
    category,
    format,
    deliverables,
    requiredPhrases,
    forbiddenPhrases,
    requireAdDisclosure,
    semanticBrief,
    applicationDeadline: String(Math.floor(deadlineAt / 1_000)),
    selectionDeadline: String(Math.floor(selectionDeadlineAt / 1_000)),
    submissionDeadline: String(Math.floor(submissionDeadlineAt / 1_000)),
    retentionSeconds: String(retentionSeconds),
  } satisfies Record<string, unknown>;
  const row = await insertCampaign({
    id,
    brandWallet: input.session.wallet,
    brandName,
    title,
    description,
    category,
    format,
    deliverables,
    requiredPhrases,
    forbiddenPhrases,
    requireAdDisclosure,
    semanticBrief,
    termsDocument,
    termsHash: campaignTermsHash(termsDocument),
    budgetAmount,
    tokenAddress: BASE_SEPOLIA_USDC_ADDRESS,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    deadlineAt,
    selectionDeadlineAt,
    submissionDeadlineAt,
    retentionSeconds,
    nowMs,
  });
  return campaignDto(row, 0);
}

export async function confirmMarketplaceCampaignFunding(input: {
  campaignId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
  nowMs?: number;
  confirmedTransaction?: ConfirmedMarketplaceTransaction;
}): Promise<{ campaign: MarketplaceCampaignDto }> {
  const nowMs = input.nowMs ?? Date.now();
  const campaignId = requireUuid(input.campaignId, "campaignId");
  assertOptionalActorWallet(input.body, "brandWallet", input.session.wallet);
  const txHash = requireTransactionHash(input.body.txHash);
  const campaign = await findCampaign(campaignId);
  if (!campaign) throw notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  if (campaign.brandWallet !== input.session.wallet) {
    throw new ApiProblem(
      403,
      "CAMPAIGN_OWNER_REQUIRED",
      "Only the campaign owner can confirm funding.",
    );
  }
  if (campaign.fundingStatus === "FUNDED") {
    if (campaign.fundingTxHash !== txHash) {
      throw new ApiProblem(
        409,
        "CAMPAIGN_ALREADY_FUNDED",
        "This campaign is already bound to another funding transaction.",
      );
    }
    const count = (await applicationCounts([campaignId])).get(campaignId) ?? 0;
    return { campaign: campaignDto(campaign, count) };
  }
  if (campaign.status !== "FUNDING") {
    throw new ApiProblem(
      409,
      "INVALID_MARKETPLACE_STATE",
      "This campaign cannot accept a funding receipt.",
    );
  }

  const plan = prepareCampaignFunding({
    chainId: campaign.chainId,
    brand: campaign.brandWallet,
    termsDocument: campaign.termsDocument,
    budgetUsdc: usdcAtomsToDecimal(campaign.budgetAmount),
    applicationDeadline: Math.floor(campaign.deadlineAt / 1_000),
    selectionDeadline: Math.floor(campaign.selectionDeadlineAt / 1_000),
    submissionDeadline: Math.floor(campaign.submissionDeadlineAt / 1_000),
    retentionSeconds: campaign.retentionSeconds,
    nowSeconds: Math.floor(campaign.createdAt / 1_000),
  });
  if (plan.termsHash.toLowerCase() !== campaign.termsHash) {
    throw new Error("The persisted campaign terms commitment is inconsistent.");
  }
  const transaction =
    input.confirmedTransaction ??
    (await loadConfirmedMarketplaceTransaction(txHash));
  assertExactMarketplaceCall(
    transaction,
    plan.createCampaignCall,
    campaign.brandWallet,
  );
  let event: ReturnType<typeof extractCampaignCreated>;
  try {
    event = extractCampaignCreated({
      receiptStatus: transaction.receiptStatus,
      logs: transaction.logs,
      expectedBrand: campaign.brandWallet,
      expectedTermsHash: campaign.termsHash,
      expectedDeposited: campaign.budgetAmount,
    });
  } catch {
    throw new ApiProblem(
      409,
      "INVALID_FUNDING_RECEIPT",
      "The transaction does not contain the expected campaign funding event.",
    );
  }
  const transitioned = await confirmCampaignFundingAtomically({
    campaignId,
    brandWallet: campaign.brandWallet,
    expectedRevision: campaign.revision,
    escrowContract: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow.toLowerCase(),
    escrowCampaignId: event.campaignId.toString(),
    fundingTxHash: txHash,
    nowMs,
  });
  if (!transitioned) throw transitionConflict();
  const [fresh, counts] = await Promise.all([
    findCampaign(campaignId),
    applicationCounts([campaignId]),
  ]);
  if (!fresh) throw new Error("The funded campaign could not be reloaded.");
  return {
    campaign: campaignDto(fresh, counts.get(campaignId) ?? 0),
  };
}

export async function listMarketplaceCampaigns(input: {
  requestUrl: string;
  viewerWallet?: string | null;
}): Promise<CampaignListResponse> {
  const url = new URL(input.requestUrl);
  const statusValue = optionalFilter(url.searchParams.get("status"), "status", 20);
  const category = optionalFilter(url.searchParams.get("category"), "category", 48);
  const format = optionalFilter(url.searchParams.get("format"), "format", 48);
  const limit = parseLimit(url.searchParams.get("limit"));
  let status: MarketplaceCampaignStatus | undefined;
  if (statusValue) {
    const normalized = statusValue.toUpperCase() as MarketplaceCampaignStatus;
    if (!marketplaceCampaignStatuses.includes(normalized)) {
      throw new ApiProblem(400, "INVALID_REQUEST", "status is invalid.");
    }
    status = normalized;
  }

  const [rows, summary] = await Promise.all([
    listCampaignRows({
      viewerWallet: input.viewerWallet,
      status,
      category: category ?? undefined,
      format: format ?? undefined,
      limit,
    }),
    marketplaceSummary(),
  ]);
  const counts = await applicationCounts(rows.map((row) => row.id));
  return {
    campaigns: rows.map((row) => campaignDto(row, counts.get(row.id) ?? 0)),
    summary: {
      openCampaigns: summary.openCampaigns,
      lockedUsdc: formatUsdcAmount(summary.lockedAmount),
    },
  };
}

export async function getMarketplaceCampaignDetail(input: {
  campaignId: string;
  viewerWallet?: string | null;
}): Promise<CampaignDetailResponse> {
  const campaignId = requireUuid(input.campaignId, "campaignId");
  const campaign = await findCampaign(campaignId);
  if (!campaign) throw notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  const isBrand = input.viewerWallet === campaign.brandWallet;
  if (
    !isBrand &&
    (campaign.status === "DRAFT" || campaign.status === "FUNDING")
  ) {
    throw notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  }

  const allApplications = isBrand
    ? await listApplicationsForCampaign(campaignId)
    : [];
  const viewerApplication =
    !isBrand && input.viewerWallet
      ? await findCreatorApplication(campaignId, input.viewerWallet)
      : null;
  const applicationCount = isBrand
    ? allApplications.length
    : (await applicationCounts([campaignId])).get(campaignId) ?? 0;
  return {
    campaign: campaignDto(campaign, applicationCount),
    applications: allApplications.map(applicationDto),
    viewerApplication: viewerApplication
      ? applicationDto(viewerApplication)
      : null,
  };
}

export async function applyToMarketplaceCampaign(input: {
  campaignId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
  nowMs?: number;
}): Promise<{
  application: MarketplaceApplicationDto;
  campaign: MarketplaceCampaignDto;
}> {
  const nowMs = input.nowMs ?? Date.now();
  const campaignId = requireUuid(input.campaignId, "campaignId");
  assertOptionalActorWallet(input.body, "creatorWallet", input.session.wallet);
  const campaign = await findCampaign(campaignId);
  if (!campaign) throw notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  if (
    campaign.status !== "OPEN" ||
    campaign.fundingStatus !== "FUNDED" ||
    campaign.deadlineAt <= nowMs
  ) {
    throw new ApiProblem(
      409,
      "CAMPAIGN_NOT_OPEN",
      "This campaign is not open for applications.",
    );
  }
  if (campaign.brandWallet === input.session.wallet) {
    throw new ApiProblem(
      409,
      "BRAND_CANNOT_APPLY",
      "The campaign owner cannot apply as its creator.",
    );
  }
  const requestedAmount = parseUsdcAmount(
    input.body.requestedRateUsdc,
    "requestedRateUsdc",
  );
  if (BigInt(requestedAmount) > BigInt(campaign.budgetAmount)) {
    throw new ApiProblem(
      400,
      "RATE_EXCEEDS_BUDGET",
      "requestedRateUsdc cannot exceed the campaign budget.",
    );
  }
  const profile = await upsertVerifiedCreatorProfile({
    wallet: input.session.wallet,
    nowMs,
  });
  if (!profile) {
    throw new ApiProblem(
      403,
      "CREATOR_VERIFICATION_REQUIRED",
      "Verify this wallet's X account on Base Sepolia before applying.",
    );
  }
  const application = await insertApplicationIfOpen({
    campaignId,
    profile,
    requestedAmount,
    pitch: requireText(input.body.pitch, "pitch", 10, 2_000),
    nowMs,
  });
  if (!application) {
    const existing = await findCreatorApplication(campaignId, input.session.wallet);
    if (existing) {
      throw new ApiProblem(
        409,
        "ALREADY_APPLIED",
        "This creator already applied to the campaign.",
      );
    }
    throw new ApiProblem(
      409,
      "CAMPAIGN_CHANGED",
      "The campaign changed while the application was being submitted.",
    );
  }
  const count = (await applicationCounts([campaignId])).get(campaignId) ?? 0;
  return {
    application: applicationDto(application),
    campaign: campaignDto(campaign, count),
  };
}

export async function selectMarketplaceApplication(input: {
  campaignId: string;
  applicationId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
  nowMs?: number;
}): Promise<{
  application: MarketplaceApplicationDto;
  campaign: MarketplaceCampaignDto;
  transaction: MarketplaceTransactionDto;
}> {
  const nowMs = input.nowMs ?? Date.now();
  const campaignId = requireUuid(input.campaignId, "campaignId");
  const applicationId = requireUuid(input.applicationId, "applicationId");
  assertOptionalActorWallet(input.body, "brandWallet", input.session.wallet);
  const [campaign, application] = await Promise.all([
    findCampaign(campaignId),
    findApplication(campaignId, applicationId),
  ]);
  if (!campaign) throw notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  if (campaign.brandWallet !== input.session.wallet) {
    throw new ApiProblem(
      403,
      "CAMPAIGN_OWNER_REQUIRED",
      "Only the campaign owner can select a creator.",
    );
  }
  if (!application) {
    throw notFound("APPLICATION_NOT_FOUND", "Application not found.");
  }
  const isNewSelection =
    campaign.status === "OPEN" && application.status === "APPLIED";
  const isPendingSelection =
    campaign.status === "MATCHED" &&
    application.status === "SELECTED" &&
    !application.selectionTxHash &&
    !application.escrowAssignmentId;
  if (!isNewSelection && !isPendingSelection) {
    throw new ApiProblem(
      409,
      "INVALID_MARKETPLACE_STATE",
      "This application can no longer be selected.",
    );
  }
  if (
    !campaign.escrowCampaignId ||
    campaign.escrowContract !==
      INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow.toLowerCase() ||
    !application.identityHash
  ) {
    throw new Error("The funded campaign or creator commitment is incomplete.");
  }
  const selection = prepareCreatorSelection({
    chainId: campaign.chainId,
    escrowCampaignId: campaign.escrowCampaignId,
    campaignRecordId: campaign.id,
    campaignRevision: isNewSelection
      ? campaign.revision
      : campaign.revision - 1,
    applicationRecordId: application.id,
    applicationRevision: isNewSelection
      ? application.revision
      : application.revision - 1,
    termsHash: campaign.termsHash,
    brandWallet: campaign.brandWallet,
    creatorWallet: application.creatorWallet,
    identityHash: application.identityHash,
    payoutAtoms: application.requestedAmount,
  });

  if (isNewSelection) {
    const transitioned = await selectApplicationAtomically({
      campaignId,
      applicationId,
      brandWallet: input.session.wallet,
      expectedCampaignRevision: campaign.revision,
      expectedApplicationRevision: application.revision,
      identityHash: application.identityHash,
      agreementHash: selection.agreementHash,
      nowMs,
    });
    if (!transitioned) throw transitionConflict();
  } else if (application.agreementHash !== selection.agreementHash) {
    throw new Error("The pending selection commitment is inconsistent.");
  }
  return {
    ...(await freshTransition(campaignId, applicationId)),
    transaction: transactionDto(selection.call),
  };
}

export async function confirmMarketplaceApplicationSelection(input: {
  campaignId: string;
  applicationId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
  nowMs?: number;
  confirmedTransaction?: ConfirmedMarketplaceTransaction;
}): Promise<{
  application: MarketplaceApplicationDto;
  campaign: MarketplaceCampaignDto;
}> {
  const nowMs = input.nowMs ?? Date.now();
  const campaignId = requireUuid(input.campaignId, "campaignId");
  const applicationId = requireUuid(input.applicationId, "applicationId");
  assertOptionalActorWallet(input.body, "brandWallet", input.session.wallet);
  const txHash = requireTransactionHash(input.body.txHash);
  const [campaign, application] = await Promise.all([
    findCampaign(campaignId),
    findApplication(campaignId, applicationId),
  ]);
  if (!campaign) throw notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  if (!application) {
    throw notFound("APPLICATION_NOT_FOUND", "Application not found.");
  }
  if (campaign.brandWallet !== input.session.wallet) {
    throw new ApiProblem(
      403,
      "CAMPAIGN_OWNER_REQUIRED",
      "Only the campaign owner can confirm creator selection.",
    );
  }
  if (application.selectionTxHash) {
    if (application.selectionTxHash !== txHash) {
      throw new ApiProblem(
        409,
        "SELECTION_ALREADY_CONFIRMED",
        "This selection is already bound to another transaction.",
      );
    }
    return freshTransition(campaignId, applicationId);
  }
  if (
    campaign.status !== "MATCHED" ||
    application.status !== "SELECTED" ||
    !campaign.escrowCampaignId ||
    !application.identityHash ||
    !application.agreementHash ||
    campaign.revision < 1 ||
    application.revision < 1
  ) {
    throw new ApiProblem(
      409,
      "INVALID_MARKETPLACE_STATE",
      "This creator selection cannot be confirmed.",
    );
  }
  const selection = prepareCreatorSelection({
    chainId: campaign.chainId,
    escrowCampaignId: campaign.escrowCampaignId,
    campaignRecordId: campaign.id,
    campaignRevision: campaign.revision - 1,
    applicationRecordId: application.id,
    applicationRevision: application.revision - 1,
    termsHash: campaign.termsHash,
    brandWallet: campaign.brandWallet,
    creatorWallet: application.creatorWallet,
    identityHash: application.identityHash,
    payoutAtoms: application.requestedAmount,
  });
  if (selection.agreementHash !== application.agreementHash) {
    throw new Error("The selected application agreement commitment is inconsistent.");
  }
  const transaction =
    input.confirmedTransaction ??
    (await loadConfirmedMarketplaceTransaction(txHash));
  assertExactMarketplaceCall(transaction, selection.call, campaign.brandWallet);
  let event: ReturnType<typeof extractCreatorSelected>;
  try {
    event = extractCreatorSelected({
      receiptStatus: transaction.receiptStatus,
      logs: transaction.logs,
      expectedCampaignId: campaign.escrowCampaignId,
      expectedCreator: application.creatorWallet,
      expectedPayout: application.requestedAmount,
    });
  } catch {
    throw new ApiProblem(
      409,
      "INVALID_SELECTION_RECEIPT",
      "The transaction does not contain the expected creator selection event.",
    );
  }
  const transitioned = await confirmApplicationSelectionAtomically({
    campaignId,
    applicationId,
    brandWallet: campaign.brandWallet,
    expectedCampaignRevision: campaign.revision,
    expectedApplicationRevision: application.revision,
    agreementHash: application.agreementHash,
    escrowAssignmentId: event.assignmentId.toString(),
    selectionTxHash: txHash,
    nowMs,
  });
  if (!transitioned) throw transitionConflict();
  return freshTransition(campaignId, applicationId);
}

export async function acceptMarketplaceApplication(input: {
  campaignId: string;
  applicationId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
  nowMs?: number;
}): Promise<{
  application: MarketplaceApplicationDto;
  campaign: MarketplaceCampaignDto;
  transaction: MarketplaceTransactionDto;
}> {
  const campaignId = requireUuid(input.campaignId, "campaignId");
  const applicationId = requireUuid(input.applicationId, "applicationId");
  assertOptionalActorWallet(input.body, "creatorWallet", input.session.wallet);
  const [campaign, application] = await Promise.all([
    findCampaign(campaignId),
    findApplication(campaignId, applicationId),
  ]);
  if (!campaign) throw notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  if (!application) {
    throw notFound("APPLICATION_NOT_FOUND", "Application not found.");
  }
  if (application.creatorWallet !== input.session.wallet) {
    throw new ApiProblem(
      403,
      "APPLICATION_CREATOR_REQUIRED",
      "Only the selected creator can accept this campaign.",
    );
  }
  if (
    campaign.status !== "MATCHED" ||
    application.status !== "SELECTED" ||
    !application.escrowAssignmentId ||
    !application.agreementHash ||
    !application.selectionTxHash
  ) {
    throw new ApiProblem(
      409,
      "INVALID_MARKETPLACE_STATE",
      "This selection can no longer be accepted.",
    );
  }
  const call = prepareAssignmentAcceptance({
    chainId: campaign.chainId,
    assignmentId: application.escrowAssignmentId,
  });
  return {
    ...(await freshTransition(campaignId, applicationId)),
    transaction: transactionDto(call),
  };
}

export async function confirmMarketplaceApplicationAcceptance(input: {
  campaignId: string;
  applicationId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
  nowMs?: number;
  confirmedTransaction?: ConfirmedMarketplaceTransaction;
}): Promise<{
  application: MarketplaceApplicationDto;
  campaign: MarketplaceCampaignDto;
}> {
  const nowMs = input.nowMs ?? Date.now();
  const campaignId = requireUuid(input.campaignId, "campaignId");
  const applicationId = requireUuid(input.applicationId, "applicationId");
  assertOptionalActorWallet(input.body, "creatorWallet", input.session.wallet);
  const txHash = requireTransactionHash(input.body.txHash);
  const [campaign, application] = await Promise.all([
    findCampaign(campaignId),
    findApplication(campaignId, applicationId),
  ]);
  if (!campaign) throw notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  if (!application) {
    throw notFound("APPLICATION_NOT_FOUND", "Application not found.");
  }
  if (application.creatorWallet !== input.session.wallet) {
    throw new ApiProblem(
      403,
      "APPLICATION_CREATOR_REQUIRED",
      "Only the selected creator can confirm acceptance.",
    );
  }
  if (application.acceptanceTxHash) {
    if (application.acceptanceTxHash !== txHash) {
      throw new ApiProblem(
        409,
        "ACCEPTANCE_ALREADY_CONFIRMED",
        "This acceptance is already bound to another transaction.",
      );
    }
    return freshTransition(campaignId, applicationId);
  }
  if (
    campaign.status !== "MATCHED" ||
    application.status !== "SELECTED" ||
    !application.escrowAssignmentId ||
    !application.agreementHash ||
    !application.selectionTxHash
  ) {
    throw new ApiProblem(
      409,
      "INVALID_MARKETPLACE_STATE",
      "This assignment acceptance cannot be confirmed.",
    );
  }
  const call = prepareAssignmentAcceptance({
    chainId: campaign.chainId,
    assignmentId: application.escrowAssignmentId,
  });
  const transaction =
    input.confirmedTransaction ??
    (await loadConfirmedMarketplaceTransaction(txHash));
  assertExactMarketplaceCall(transaction, call, application.creatorWallet);
  try {
    extractAssignmentAccepted({
      receiptStatus: transaction.receiptStatus,
      logs: transaction.logs,
      expectedAssignmentId: application.escrowAssignmentId,
      expectedAgreementHash: application.agreementHash,
    });
  } catch {
    throw new ApiProblem(
      409,
      "INVALID_ACCEPTANCE_RECEIPT",
      "The transaction does not contain the expected assignment acceptance event.",
    );
  }
  const transitioned = await acceptApplicationAtomically({
    campaignId,
    applicationId,
    creatorWallet: application.creatorWallet,
    expectedCampaignRevision: campaign.revision,
    expectedApplicationRevision: application.revision,
    escrowAssignmentId: application.escrowAssignmentId,
    agreementHash: application.agreementHash,
    acceptanceTxHash: txHash,
    nowMs,
  });
  if (!transitioned) throw transitionConflict();
  return freshTransition(campaignId, applicationId);
}

export async function prepareMarketplaceEvidenceSubmission(input: {
  campaignId: string;
  applicationId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
  nowMs?: number;
}): Promise<{
  application: MarketplaceApplicationDto;
  campaign: MarketplaceCampaignDto;
  transaction: MarketplaceTransactionDto;
}> {
  const nowMs = input.nowMs ?? Date.now();
  const campaignId = requireUuid(input.campaignId, "campaignId");
  const applicationId = requireUuid(input.applicationId, "applicationId");
  assertOptionalActorWallet(input.body, "creatorWallet", input.session.wallet);
  const [campaign, application] = await Promise.all([
    findCampaign(campaignId),
    findApplication(campaignId, applicationId),
  ]);
  if (!campaign) throw notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  if (!application) {
    throw notFound("APPLICATION_NOT_FOUND", "Application not found.");
  }
  if (application.creatorWallet !== input.session.wallet) {
    throw new ApiProblem(
      403,
      "APPLICATION_CREATOR_REQUIRED",
      "Only the accepted creator can submit campaign evidence.",
    );
  }
  if (
    campaign.status !== "ACTIVE" ||
    campaign.submissionDeadlineAt < nowMs ||
    application.status !== "ACCEPTED" ||
    !application.acceptanceTxHash ||
    !application.escrowAssignmentId ||
    !application.agreementHash ||
    !application.creatorHandle
  ) {
    throw new ApiProblem(
      409,
      "INVALID_MARKETPLACE_STATE",
      "This assignment is not ready for evidence submission.",
    );
  }
  const xPostId = requireXPostId(input.body, application.creatorHandle);
  const prepared = prepareEvidenceSubmission({
    chainId: campaign.chainId,
    assignmentId: application.escrowAssignmentId,
    agreementHash: application.agreementHash,
    creatorWallet: application.creatorWallet,
    expectedHandle: application.creatorHandle,
    xPostId,
  });
  if (application.submissionHash || application.postIdHash || application.xPostId) {
    if (
      application.submissionHash !== prepared.submissionHash ||
      application.postIdHash !== prepared.postIdHash ||
      application.xPostId !== xPostId
    ) {
      throw new ApiProblem(
        409,
        "SUBMISSION_ALREADY_PREPARED",
        "This assignment is already bound to another X post.",
      );
    }
  } else {
    const preparedPersisted = await prepareApplicationSubmissionAtomically({
      campaignId,
      applicationId,
      creatorWallet: application.creatorWallet,
      expectedRevision: application.revision,
      xPostId,
      postIdHash: prepared.postIdHash,
      submissionHash: prepared.submissionHash,
      nowMs,
    });
    if (!preparedPersisted) throw transitionConflict();
  }
  return {
    ...(await freshTransition(campaignId, applicationId)),
    transaction: transactionDto(prepared.call),
  };
}

export async function confirmMarketplaceEvidenceSubmission(input: {
  campaignId: string;
  applicationId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
  nowMs?: number;
  confirmedTransaction?: ConfirmedMarketplaceTransaction;
}): Promise<{
  application: MarketplaceApplicationDto;
  campaign: MarketplaceCampaignDto;
}> {
  const nowMs = input.nowMs ?? Date.now();
  const campaignId = requireUuid(input.campaignId, "campaignId");
  const applicationId = requireUuid(input.applicationId, "applicationId");
  assertOptionalActorWallet(input.body, "creatorWallet", input.session.wallet);
  const txHash = requireTransactionHash(input.body.txHash);
  const [campaign, application] = await Promise.all([
    findCampaign(campaignId),
    findApplication(campaignId, applicationId),
  ]);
  if (!campaign) throw notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  if (!application) {
    throw notFound("APPLICATION_NOT_FOUND", "Application not found.");
  }
  if (application.creatorWallet !== input.session.wallet) {
    throw new ApiProblem(
      403,
      "APPLICATION_CREATOR_REQUIRED",
      "Only the accepted creator can confirm evidence submission.",
    );
  }
  if (application.submissionTxHash) {
    if (application.submissionTxHash !== txHash) {
      throw new ApiProblem(
        409,
        "SUBMISSION_ALREADY_CONFIRMED",
        "This submission is already bound to another transaction.",
      );
    }
    return freshTransition(campaignId, applicationId);
  }
  if (
    campaign.status !== "ACTIVE" ||
    application.status !== "ACCEPTED" ||
    !application.escrowAssignmentId ||
    !application.agreementHash ||
    !application.creatorHandle ||
    !application.xPostId ||
    !application.postIdHash ||
    !application.submissionHash
  ) {
    throw new ApiProblem(
      409,
      "INVALID_MARKETPLACE_STATE",
      "This evidence submission cannot be confirmed.",
    );
  }
  const prepared = prepareEvidenceSubmission({
    chainId: campaign.chainId,
    assignmentId: application.escrowAssignmentId,
    agreementHash: application.agreementHash,
    creatorWallet: application.creatorWallet,
    expectedHandle: application.creatorHandle,
    xPostId: application.xPostId,
  });
  if (
    prepared.postIdHash !== application.postIdHash ||
    prepared.submissionHash !== application.submissionHash
  ) {
    throw new Error("The persisted evidence commitment is inconsistent.");
  }
  const transaction =
    input.confirmedTransaction ??
    (await loadConfirmedMarketplaceTransaction(txHash));
  assertExactMarketplaceCall(transaction, prepared.call, application.creatorWallet);
  try {
    extractEvidenceSubmitted({
      receiptStatus: transaction.receiptStatus,
      logs: transaction.logs,
      expectedAssignmentId: application.escrowAssignmentId,
      expectedPostIdHash: application.postIdHash,
      expectedSubmissionHash: application.submissionHash,
    });
  } catch {
    throw new ApiProblem(
      409,
      "INVALID_SUBMISSION_RECEIPT",
      "The transaction does not contain the expected evidence submission event.",
    );
  }
  const transitioned = await confirmApplicationSubmissionAtomically({
    campaignId,
    applicationId,
    creatorWallet: application.creatorWallet,
    expectedCampaignRevision: campaign.revision,
    expectedApplicationRevision: application.revision,
    submissionHash: application.submissionHash,
    postIdHash: application.postIdHash,
    submissionTxHash: txHash,
    nowMs,
  });
  if (!transitioned) throw transitionConflict();
  return freshTransition(campaignId, applicationId);
}

export async function prepareMarketplaceResolutionRequest(input: {
  campaignId: string;
  applicationId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
  nowMs?: number;
}): Promise<{
  application: MarketplaceApplicationDto;
  campaign: MarketplaceCampaignDto;
  transaction: MarketplaceTransactionDto;
}> {
  const nowMs = input.nowMs ?? Date.now();
  const { campaign, application } = await requireResolutionActor(input);
  if (
    campaign.status !== "SUBMITTED" ||
    !application.submittedAt ||
    nowMs < application.submittedAt + campaign.retentionSeconds * 1_000 ||
    !application.escrowAssignmentId ||
    application.requestId
  ) {
    throw new ApiProblem(
      409,
      "RESOLUTION_NOT_READY",
      "The submission is not ready for GenLayer resolution.",
    );
  }
  const call = prepareResolutionRequest({
    chainId: campaign.chainId,
    assignmentId: application.escrowAssignmentId,
  });
  return {
    ...(await freshTransition(campaign.id, application.id)),
    transaction: transactionDto(call),
  };
}

export async function confirmMarketplaceResolutionRequest(input: {
  campaignId: string;
  applicationId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
  nowMs?: number;
  confirmedTransaction?: ConfirmedMarketplaceTransaction;
}): Promise<{
  application: MarketplaceApplicationDto;
  campaign: MarketplaceCampaignDto;
}> {
  const nowMs = input.nowMs ?? Date.now();
  const txHash = requireTransactionHash(input.body.txHash);
  const { campaign, application } = await requireResolutionActor(input);
  if (application.resolutionRequestTxHash) {
    if (application.resolutionRequestTxHash !== txHash) {
      throw new ApiProblem(
        409,
        "RESOLUTION_ALREADY_REQUESTED",
        "Resolution is already bound to another transaction.",
      );
    }
    return freshTransition(campaign.id, application.id);
  }
  if (
    campaign.status !== "SUBMITTED" ||
    !application.escrowAssignmentId ||
    !application.agreementHash ||
    !application.submissionHash ||
    !application.submissionTxHash ||
    !application.submittedAt ||
    nowMs < application.submittedAt + campaign.retentionSeconds * 1_000
  ) {
    throw new ApiProblem(
      409,
      "RESOLUTION_NOT_READY",
      "The submission is not ready for GenLayer resolution.",
    );
  }
  const nextRound = application.resolutionRound + 1;
  const expectedRequestId = deriveCampaignResolutionRequestId({
    chainId: campaign.chainId,
    assignmentId: application.escrowAssignmentId,
    resolutionRound: nextRound,
    agreementHash: application.agreementHash,
    submissionHash: application.submissionHash,
  });
  const call = prepareResolutionRequest({
    chainId: campaign.chainId,
    assignmentId: application.escrowAssignmentId,
  });
  const transaction =
    input.confirmedTransaction ??
    (await loadConfirmedMarketplaceTransaction(txHash));
  assertExactMarketplaceCall(transaction, call, input.session.wallet);
  try {
    extractResolutionRequested({
      receiptStatus: transaction.receiptStatus,
      logs: transaction.logs,
      expectedAssignmentId: application.escrowAssignmentId,
      expectedRequestId,
      expectedRound: nextRound,
      expectedAgreementHash: application.agreementHash,
      expectedSubmissionHash: application.submissionHash,
    });
  } catch {
    throw new ApiProblem(
      409,
      "INVALID_RESOLUTION_RECEIPT",
      "The transaction does not contain the expected resolution request event.",
    );
  }
  const transitioned = await confirmApplicationResolutionRequestAtomically({
    campaignId: campaign.id,
    applicationId: application.id,
    expectedCampaignRevision: campaign.revision,
    expectedApplicationRevision: application.revision,
    requestId: expectedRequestId,
    resolutionRound: nextRound,
    resolutionRequestTxHash: txHash,
    nowMs,
  });
  if (!transitioned) throw transitionConflict();
  return freshTransition(campaign.id, application.id);
}

export async function getPublicMarketplaceCreatorProfile(input: {
  wallet: string;
  nowMs?: number;
}): Promise<MarketplaceCreatorProfileDto> {
  const normalized = input.wallet.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new ApiProblem(400, "INVALID_REQUEST", "wallet is invalid.");
  }
  let found = await findPublicCreatorProfileByWallet(normalized);
  if (!found) {
    found = await upsertVerifiedCreatorProfile({
      wallet: normalized,
      nowMs: input.nowMs ?? Date.now(),
    });
  }
  if (!found) throw notFound("CREATOR_NOT_FOUND", "Creator profile not found.");
  const profile = await expireProfileIfNeeded(found, input.nowMs ?? Date.now());
  if (!profile.active) {
    throw notFound("CREATOR_NOT_FOUND", "Creator profile not found.");
  }
  const metrics = await latestMetricsForProfile(
    profile,
    input.nowMs ?? Date.now(),
  );
  return creatorProfileDto(profile, metrics);
}

export function campaignDto(
  row: CampaignRow,
  applicationCount: number,
): MarketplaceCampaignDto {
  return {
    id: row.id,
    brandWallet: row.brandWallet,
    brandName: row.brandName,
    title: row.title,
    description: row.description,
    category: row.category,
    format: row.format,
    deliverables: [...row.deliverables],
    requiredPhrases: [...row.requiredPhrases],
    forbiddenPhrases: [...row.forbiddenPhrases],
    requireAdDisclosure: row.requireAdDisclosure,
    semanticBrief: row.semanticBrief,
    termsDocument: { ...row.termsDocument },
    termsHash: row.termsHash,
    budgetUsdc: formatUsdcAmount(row.budgetAmount),
    tokenAddress: row.tokenAddress,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    deadline: new Date(row.deadlineAt).toISOString(),
    selectionDeadline: new Date(row.selectionDeadlineAt).toISOString(),
    submissionDeadline: new Date(row.submissionDeadlineAt).toISOString(),
    retentionSeconds: String(row.retentionSeconds),
    status: row.status.toLowerCase() as MarketplaceCampaignDto["status"],
    fundingStatus:
      row.fundingStatus.toLowerCase() as MarketplaceCampaignDto["fundingStatus"],
    escrowContract: row.escrowContract,
    escrowCampaignId: row.escrowCampaignId,
    fundingTxHash: row.fundingTxHash,
    fundedAt: isoTime(row.fundedAt),
    applicationCount,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export function applicationDto(row: ApplicationRow): MarketplaceApplicationDto {
  return {
    id: row.id,
    campaignId: row.campaignId,
    creatorWallet: row.creatorWallet,
    creatorProfileId: row.creatorProfileId,
    creatorHandle: row.creatorHandle,
    creatorHandleHash: row.creatorHandleHash,
    requestedRateUsdc: formatUsdcAmount(row.requestedAmount),
    pitch: row.pitch,
    status: row.status.toLowerCase() as MarketplaceApplicationDto["status"],
    selectedAt: isoTime(row.selectedAt),
    acceptedAt: isoTime(row.acceptedAt),
    escrowAssignmentId: row.escrowAssignmentId,
    identityHash: row.identityHash,
    agreementHash: row.agreementHash,
    selectionTxHash: row.selectionTxHash,
    acceptanceTxHash: row.acceptanceTxHash,
    postIdHash: row.postIdHash,
    xPostId: row.xPostId,
    submissionHash: row.submissionHash,
    submissionTxHash: row.submissionTxHash,
    submittedAt: isoTime(row.submittedAt),
    requestId: row.requestId,
    resolutionRound: row.resolutionRound,
    resolutionRequestTxHash: row.resolutionRequestTxHash,
    resolutionRequestedAt: isoTime(row.resolutionRequestedAt),
    resolutionOutcome: row.resolutionOutcome
      ? (row.resolutionOutcome.toLowerCase() as MarketplaceApplicationDto["resolutionOutcome"])
      : null,
    resolutionEvidenceHash: row.resolutionEvidenceHash,
    resolutionTxHash: row.resolutionTxHash,
    claimTxHash: row.claimTxHash,
    genlayerSubmitterStatus: row.genlayerSubmitterStatus,
    genlayerTxHash: row.genlayerTxHash,
    genlayerResultOutcome: row.genlayerResultOutcome
      ? (row.genlayerResultOutcome.toLowerCase() as MarketplaceApplicationDto["genlayerResultOutcome"])
      : null,
    genlayerLifecycleStatus: row.genlayerLifecycleStatus,
    genlayerExecutionResult: row.genlayerExecutionResult,
    genlayerErrorCode: row.genlayerErrorCode,
    genlayerSubmittedAt: isoTime(row.genlayerSubmittedAt),
    genlayerFinalizedAt: isoTime(row.genlayerFinalizedAt),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function creatorProfileDto(
  profile: CreatorProfileRow,
  metrics: CreatorMetricsRow | null,
): MarketplaceCreatorProfileDto {
  return {
    id: profile.id,
    ownerWallet: profile.ownerWallet,
    baseProfileId: profile.baseProfileId,
    identityHash: profile.identityHash,
    handleHash: profile.handleHash,
    verificationPostHash: profile.verificationPostHash,
    verificationTxHash: profile.verificationTxHash,
    publicHandle: profile.publicHandle,
    displayName: profile.displayName,
    bio: profile.bio,
    categories: [...profile.categories],
    visibility: profile.visibility.toLowerCase() as MarketplaceCreatorProfileDto["visibility"],
    active: profile.active,
    credentialExpiresAt: new Date(profile.credentialExpiresAt).toISOString(),
    verifiedAt: new Date(profile.verifiedAt).toISOString(),
    metrics: metrics ? metricsDto(metrics) : null,
    createdAt: new Date(profile.createdAt).toISOString(),
    updatedAt: new Date(profile.updatedAt).toISOString(),
  };
}

function metricsDto(row: CreatorMetricsRow): MarketplaceMetricsDto {
  return {
    id: row.id,
    followersCount: String(row.followersCount),
    accountCreatedAt: new Date(row.accountCreatedAt).toISOString(),
    postsSampled: row.postsSampled,
    medianEngagementCount: String(row.medianEngagementCount),
    engagementRateBps: row.engagementRateBps,
    estimatedPayMinUsdc: formatUsdcAmount(row.estimatedPayMinAmount),
    estimatedPayMaxUsdc: formatUsdcAmount(row.estimatedPayMaxAmount),
    riskLevel: row.riskLevel.toLowerCase() as MarketplaceMetricsDto["riskLevel"],
    evidenceHash: row.evidenceHash,
    capturedAt: new Date(row.capturedAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
  };
}

function transactionDto(
  call: PreparedMarketplaceCall,
): MarketplaceTransactionDto {
  return {
    chainId: BASE_SEPOLIA_CHAIN_ID,
    to: call.address,
    data: call.data,
    value: "0",
  };
}

async function requireResolutionActor(input: {
  campaignId: string;
  applicationId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
}): Promise<{ campaign: CampaignRow; application: ApplicationRow }> {
  const campaignId = requireUuid(input.campaignId, "campaignId");
  const applicationId = requireUuid(input.applicationId, "applicationId");
  assertOptionalActorWallet(input.body, "brandWallet", input.session.wallet);
  assertOptionalActorWallet(input.body, "creatorWallet", input.session.wallet);
  const [campaign, application] = await Promise.all([
    findCampaign(campaignId),
    findApplication(campaignId, applicationId),
  ]);
  if (!campaign) throw notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  if (!application) {
    throw notFound("APPLICATION_NOT_FOUND", "Application not found.");
  }
  if (
    input.session.wallet !== campaign.brandWallet &&
    input.session.wallet !== application.creatorWallet
  ) {
    throw new ApiProblem(
      403,
      "CAMPAIGN_PARTICIPANT_REQUIRED",
      "Only the campaign brand or accepted creator can request resolution.",
    );
  }
  return { campaign, application };
}

function requireXPostId(
  body: Record<string, unknown>,
  expectedHandle: string,
): string {
  const normalizedExpectedHandle = expectedHandle
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(normalizedExpectedHandle)) {
    throw new Error("The verified creator handle is invalid.");
  }
  if (body.expectedHandle !== undefined) {
    const declared = requireText(
      body.expectedHandle,
      "expectedHandle",
      1,
      16,
    )
      .replace(/^@/, "")
      .toLowerCase();
    if (declared !== normalizedExpectedHandle) {
      throw new ApiProblem(
        409,
        "CREATOR_HANDLE_MISMATCH",
        "expectedHandle does not match the verified creator profile.",
      );
    }
  }

  let fromUrl: string | null = null;
  if (body.postUrl !== undefined) {
    const value = requireText(body.postUrl, "postUrl", 10, 512);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ApiProblem(400, "INVALID_REQUEST", "postUrl is invalid.");
    }
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const match = /^\/([A-Za-z0-9_]{1,15})\/status\/([1-9][0-9]{5,24})\/?$/.exec(
      url.pathname,
    );
    if (
      url.protocol !== "https:" ||
      !["x.com", "twitter.com"].includes(hostname) ||
      url.search ||
      url.hash ||
      !match
    ) {
      throw new ApiProblem(
        400,
        "INVALID_REQUEST",
        "postUrl must be a canonical public X status URL.",
      );
    }
    if (match[1].toLowerCase() !== normalizedExpectedHandle) {
      throw new ApiProblem(
        409,
        "CREATOR_HANDLE_MISMATCH",
        "The X post URL does not belong to the verified creator handle.",
      );
    }
    fromUrl = match[2];
  }
  const direct = body.xPostId;
  if (direct !== undefined && (typeof direct !== "string" || !/^[1-9][0-9]{5,24}$/.test(direct))) {
    throw new ApiProblem(400, "INVALID_REQUEST", "xPostId is invalid.");
  }
  if (direct && fromUrl && direct !== fromUrl) {
    throw new ApiProblem(
      409,
      "X_POST_ID_MISMATCH",
      "xPostId does not match postUrl.",
    );
  }
  const result = (direct as string | undefined) ?? fromUrl;
  if (!result) {
    throw new ApiProblem(
      400,
      "INVALID_REQUEST",
      "Send xPostId or a canonical postUrl.",
    );
  }
  return result;
}

async function freshTransition(
  campaignId: string,
  applicationId: string,
): Promise<{
  application: MarketplaceApplicationDto;
  campaign: MarketplaceCampaignDto;
}> {
  const [campaign, application, counts] = await Promise.all([
    findCampaign(campaignId),
    findApplication(campaignId, applicationId),
    applicationCounts([campaignId]),
  ]);
  if (!campaign || !application) {
    throw new Error("A committed marketplace transition could not be reloaded.");
  }
  return {
    campaign: campaignDto(campaign, counts.get(campaignId) ?? 0),
    application: applicationDto(application),
  };
}

function optionalFilter(
  value: string | null,
  field: string,
  maxLength: number,
): string | null {
  if (value === null || !value.trim()) return null;
  return requireText(value, field, 1, maxLength);
}

function parseLimit(value: string | null): number {
  if (value === null || value === "") return 24;
  if (!/^[1-9][0-9]?$/.test(value)) {
    throw new ApiProblem(400, "INVALID_REQUEST", "limit is invalid.");
  }
  const limit = Number(value);
  if (limit > 50) {
    throw new ApiProblem(400, "INVALID_REQUEST", "limit cannot exceed 50.");
  }
  return limit;
}

function optionalOrderedDeadline(
  value: unknown,
  field: string,
  afterMs: number,
  fallbackMs: number,
): number {
  if (value === undefined) return fallbackMs;
  if (typeof value !== "string" || value.length > 64) {
    throw new ApiProblem(
      400,
      "INVALID_REQUEST",
      `${field} must be an ISO-8601 timestamp.`,
    );
  }
  const parsed = Date.parse(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= afterMs ||
    parsed > afterMs + 365 * 24 * 60 * 60 * 1_000
  ) {
    throw new ApiProblem(
      400,
      "INVALID_REQUEST",
      `${field} must be after the preceding deadline and within one year.`,
    );
  }
  return parsed;
}

function optionalRetentionSeconds(value: unknown): number {
  if (value === undefined) return 30 * 24 * 60 * 60;
  const normalized = typeof value === "string" && /^[0-9]+$/.test(value)
    ? Number(value)
    : value;
  if (
    typeof normalized !== "number" ||
    !Number.isSafeInteger(normalized) ||
    normalized < 24 * 60 * 60 ||
    normalized > 365 * 24 * 60 * 60
  ) {
    throw new ApiProblem(
      400,
      "INVALID_REQUEST",
      "retentionSeconds must be between one day and one year.",
    );
  }
  return normalized;
}

function optionalBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new ApiProblem(400, "INVALID_REQUEST", `${field} must be boolean.`);
  }
  return value;
}

function transitionConflict(): ApiProblem {
  return new ApiProblem(
    409,
    "MARKETPLACE_TRANSITION_CONFLICT",
    "The campaign changed concurrently. Refresh and try again.",
  );
}

function notFound(code: string, message: string): ApiProblem {
  return new ApiProblem(404, code, message);
}
