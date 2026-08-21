import type { AuthenticatedWalletSession } from "./wallet-session.ts";
import {
  assertOptionalActorWallet,
  buildCampaignContractBrief,
  isoTime,
  requireFutureDeadline,
  requireStringList,
  requireText,
  requireUuid,
} from "./marketplace-core.ts";
import {
  campaignSnapshotHash,
  campaignTerms,
  createCampaignClientNonce,
  deriveCampaignId,
  deriveCampaignTermsHash,
  normalizeContentSource,
  normalizeMarketplaceAddress,
  parseCampaignState,
  type GenLayerCampaignState,
} from "./marketplace-genlayer-core.ts";
import {
  bindGenLayerTransactionHash,
  findBoundGenLayerApplicationRecovery,
  findGenLayerCampaignDraft,
  findGenLayerCampaignProjectionByLocalId,
  findGenLayerAssignmentProjectionByApplicationId,
  findGenLayerPreparedTransaction,
  insertGenLayerCampaignDraft,
  listGenLayerCampaignDraftRows,
  listGenLayerPrivateApplicationsForCampaign,
  prepareGenLayerMarketplaceTransaction,
  recordGenLayerTransactionStatus,
  setGenLayerCampaignDraftStatus,
  updateGenLayerProjectionCursor,
  upsertGenLayerCampaignProjection,
  type GenLayerCampaignDraft,
  type GenLayerCampaignProjection,
  type GenLayerPrivateApplication,
} from "./marketplace-genlayer-repository.ts";
import type { MarketplaceApplicationDto } from "./marketplace-types.ts";
import {
  MARKETPLACE_GENLAYER_CHAIN_ID,
  MARKETPLACE_GENLAYER_NETWORK,
  MARKETPLACE_NATIVE_DECIMALS,
  MARKETPLACE_NATIVE_SYMBOL,
  MarketplaceGenLayerFinalityError,
  assertTransactionMatchesPreparedCall,
  canonicalHash,
  loadFinalizedMarketplaceTransaction,
  marketplaceContractAddress,
  readMarketplaceState,
  type MarketplaceGenLayerCall,
} from "./marketplace-genlayer-rpc.ts";
import { ApiProblem, assertExactJsonKeys } from "./verification-api.ts";

const CONTRACT_MAX_CAMPAIGN_SECONDS = 90 * 24 * 60 * 60;
const DEFAULT_SELECTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_SUBMISSION_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;
const DEFAULT_RETENTION_SECONDS = 24 * 60 * 60;
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;

export type GenLayerCampaignDto = ReturnType<typeof campaignDto>;

export async function createGenLayerMarketplaceCampaign(input: {
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
  nowMs?: number;
}): Promise<GenLayerCampaignDto> {
  assertExactJsonKeys(
    input.body,
    [
      "brandWallet", "brandName", "contentSource", "title", "description",
      "category", "format", "deliverables", "requiredPhrases",
      "forbiddenPhrases", "requireAdDisclosure", "semanticBrief", "budgetGen",
      "deadline", "selectionDeadline", "submissionDeadline", "retentionSeconds",
      "maxUndeterminedRetries",
    ],
    ["title", "description", "category", "format", "deliverables", "budgetGen", "deadline"],
  );
  const nowMs = input.nowMs ?? Date.now();
  assertOptionalActorWallet(input.body, "brandWallet", input.session.wallet);
  const brandWallet = normalizeMarketplaceAddress(input.session.wallet, "brand wallet");
  const brandName = input.body.brandName === undefined
    ? `${brandWallet.slice(0, 6)}…${brandWallet.slice(-4)}`
    : requireText(input.body.brandName, "brandName", 2, 80);
  const contentSource = normalizeContentSource(input.body.contentSource ?? "X");
  const title = requireText(input.body.title, "title", 5, 120);
  const description = requireText(input.body.description, "description", 20, 5_000);
  const category = requireText(input.body.category, "category", 2, 48);
  const format = requireText(input.body.format, "format", 2, 48);
  if (format !== "Post") {
    throw invalid("format", "format must be exactly Post for the current GenLayer contract.");
  }
  const deliverables = requireStringList(input.body.deliverables, "deliverables", {
    minItems: 1,
    maxItems: 12,
    maxItemLength: 280,
  });
  const requiredPhrases = requireStringList(input.body.requiredPhrases ?? [], "requiredPhrases", {
    minItems: 0,
    maxItems: 20,
    maxItemLength: 160,
  });
  const forbiddenPhrases = requireStringList(input.body.forbiddenPhrases ?? [], "forbiddenPhrases", {
    minItems: 0,
    maxItems: 20,
    maxItemLength: 160,
  });
  const requireAdDisclosure = optionalBoolean(input.body.requireAdDisclosure, true);
  const semanticBriefInput = input.body.semanticBrief === undefined
    ? description
    : requireText(input.body.semanticBrief, "semanticBrief", 10, 4_000);
  const semanticBrief = buildCampaignContractBrief(semanticBriefInput, deliverables);
  const budgetAtto = positiveAtto(input.body.budgetGen, "budgetGen");
  const applicationDeadlineAt = requireFutureDeadline(input.body.deadline, nowMs);
  const selectionDeadlineAt = orderedDeadline(
    input.body.selectionDeadline,
    "selectionDeadline",
    applicationDeadlineAt,
    applicationDeadlineAt + DEFAULT_SELECTION_WINDOW_MS,
  );
  const submissionDeadlineAt = orderedDeadline(
    input.body.submissionDeadline,
    "submissionDeadline",
    selectionDeadlineAt,
    selectionDeadlineAt + DEFAULT_SUBMISSION_WINDOW_MS,
  );
  if (submissionDeadlineAt > nowMs + CONTRACT_MAX_CAMPAIGN_SECONDS * 1_000) {
    throw invalid("submissionDeadline", "Campaign duration cannot exceed 90 days.");
  }
  const retentionSeconds = boundedInteger(
    input.body.retentionSeconds ?? DEFAULT_RETENTION_SECONDS,
    "retentionSeconds",
    60,
    604_800,
  );
  const maxUndeterminedRetries = boundedInteger(
    input.body.maxUndeterminedRetries ?? 2,
    "maxUndeterminedRetries",
    1,
    5,
  );
  const clientNonce = createCampaignClientNonce();
  const termsInput = {
    contentSource,
    title,
    brief: semanticBrief,
    requiredPhrases,
    forbiddenPhrases,
    requireAdDisclosure,
    applicationDeadlineEpoch: Math.floor(applicationDeadlineAt / 1_000),
    selectionDeadlineEpoch: Math.floor(selectionDeadlineAt / 1_000),
    submissionDeadlineEpoch: Math.floor(submissionDeadlineAt / 1_000),
    retentionSeconds,
    maxUndeterminedRetries,
  };
  const termsHash = deriveCampaignTermsHash(termsInput);
  const termsDocument = {
    schema_version: 1,
    network: MARKETPLACE_GENLAYER_NETWORK,
    chain_id: MARKETPLACE_GENLAYER_CHAIN_ID,
    native_token_symbol: MARKETPLACE_NATIVE_SYMBOL,
    native_token_decimals: MARKETPLACE_NATIVE_DECIMALS,
    brand_wallet: brandWallet,
    client_nonce: clientNonce,
    budget_atto: budgetAtto,
    ...campaignTerms(termsInput),
  } satisfies Record<string, unknown>;
  const row = await insertGenLayerCampaignDraft({
    brandWallet,
    brandName,
    contentSource,
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
    termsHash,
    clientNonce,
    budgetAtto,
    applicationDeadlineAt,
    selectionDeadlineAt,
    submissionDeadlineAt,
    retentionSeconds,
    maxUndeterminedRetries,
    nowMs,
  });
  return campaignDto(row, null, 0);
}

export async function prepareGenLayerCampaignFunding(input: {
  campaignId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
}): Promise<{
  campaign: GenLayerCampaignDto;
  preparedId: string;
  transaction?: MarketplaceGenLayerCall;
  recovery: { preparedId: string; txHash: string } | null;
}> {
  assertExactJsonKeys(input.body, ["brandWallet"], []);
  const localCampaignId = requireUuid(input.campaignId, "campaignId");
  assertOptionalActorWallet(input.body, "brandWallet", input.session.wallet);
  const [draft, projection] = await Promise.all([
    findGenLayerCampaignDraft(localCampaignId),
    findGenLayerCampaignProjectionByLocalId(localCampaignId),
  ]);
  if (!draft) throw notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  assertBrand(draft, input.session.wallet);
  if (projection) {
    throw new ApiProblem(409, "CAMPAIGN_ALREADY_FUNDED", "This campaign is already funded.");
  }
  if (draft.status !== "FUNDING") {
    throw new ApiProblem(409, "INVALID_MARKETPLACE_STATE", "This campaign cannot be funded.");
  }
  const campaignId = expectedCampaignId(draft);
  const call = campaignCreationCall(draft, campaignId);
  const prepared = await prepareGenLayerMarketplaceTransaction({
    operation: "CREATE_CAMPAIGN",
    call,
    actorWallet: draft.brandWallet,
    localCampaignId,
    onchainEntityId: campaignId,
  });
  return prepared.recovery
    ? {
        campaign: campaignDto(draft, null, 0),
        preparedId: prepared.preparedId,
        recovery: {
          preparedId: prepared.recovery.preparedId,
          txHash: prepared.recovery.transactionHash,
        },
      }
    : {
        campaign: campaignDto(draft, null, 0),
        preparedId: prepared.preparedId,
        transaction: prepared.call,
        recovery: null,
      };
}

export async function confirmGenLayerCampaignFunding(input: {
  campaignId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
  nowMs?: number;
  reconciliationFenceToken?: string;
}): Promise<{ campaign: GenLayerCampaignDto }> {
  assertExactJsonKeys(input.body, ["preparedId", "txHash"]);
  const nowMs = input.nowMs ?? Date.now();
  const localCampaignId = requireUuid(input.campaignId, "campaignId");
  const preparedId = requireUuidField(input.body.preparedId, "preparedId");
  const transactionHash = requireTxHash(input.body.txHash);
  const draft = await findGenLayerCampaignDraft(localCampaignId);
  if (!draft) throw notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  assertBrand(draft, input.session.wallet);
  const prepared = await findGenLayerPreparedTransaction(preparedId);
  if (
    !prepared ||
    prepared.operation !== "CREATE_CAMPAIGN" ||
    prepared.localCampaignId !== localCampaignId ||
    prepared.actorWallet !== draft.brandWallet
  ) {
    throw new ApiProblem(409, "PREPARED_TRANSACTION_MISMATCH", "The prepared transaction is not valid for this campaign.");
  }
  if (prepared.transactionHash && prepared.transactionHash !== transactionHash) {
    throw new ApiProblem(409, "TRANSACTION_HASH_MISMATCH", "This prepared transaction is bound to another hash.");
  }
  const expectedId = expectedCampaignId(draft);
  const existing = await findGenLayerCampaignProjectionByLocalId(localCampaignId);
  if (prepared.status === "FINALIZED" && existing) {
    return { campaign: campaignDto(draft, existing, existing.applicationCount) };
  }
  const bound = await bindGenLayerTransactionHash({
    preparedId,
    actorWallet: draft.brandWallet,
    transactionHash,
    nowMs,
  });
  if (!bound) {
    throw new ApiProblem(409, "TRANSACTION_BINDING_CONFLICT", "The transaction could not be bound to this prepared action.");
  }

  let finalized;
  try {
    finalized = await loadFinalizedMarketplaceTransaction(transactionHash);
    assertTransactionMatchesPreparedCall({
      transaction: finalized,
      call: campaignCreationCall(draft, expectedId),
      actorWallet: draft.brandWallet,
    });
  } catch (error) {
    await recordConfirmationFailure(
      preparedId,
      error,
      nowMs,
      input.reconciliationFenceToken,
    );
    throw confirmationProblem(error);
  }

  let state: GenLayerCampaignState;
  try {
    state = parseCampaignState(await readMarketplaceState("get_campaign", [expectedId]));
    assertCampaignMatchesDraft(state, draft, expectedId);
  } catch (error) {
    await recordGenLayerTransactionStatus({
      preparedId,
      status: "RECONCILIATION_REQUIRED",
      lifecycleStatus: finalized.lifecycleStatus,
      executionResult: finalized.executionResult,
      errorCode: "GENLAYER_STATE_MISMATCH",
      nowMs,
      retryAtMs: 0,
      fenceToken: input.reconciliationFenceToken,
    });
    throw new ApiProblem(409, "GENLAYER_STATE_MISMATCH", errorMessage(error));
  }

  const finalizedAtMs = finalized.finalizedAt * 1_000;
  const snapshotHash = campaignSnapshotHash(state);
  const projection = await upsertGenLayerCampaignProjection({
    campaignId: state.campaignId,
    localCampaignId,
    contractAddress: marketplaceContractAddress(),
    brandWallet: state.brand,
    clientNonce: state.clientNonce,
    contentSource: state.contentSource,
    termsHash: state.termsHash,
    budgetAtto: state.budgetAtto,
    availableAtto: state.availableAtto,
    reservedAtto: state.reservedAtto,
    settledAtto: state.settledAtto,
    creatorPaidAtto: state.creatorPaidAtto,
    brandRefundedAtto: state.brandRefundedAtto,
    feeAtto: state.feeAtto,
    status: state.status,
    feeBps: state.feeBps,
    treasuryWallet: state.treasury,
    applicationCount: state.applicationCount,
    assignmentCount: state.assignmentCount,
    maxUndeterminedRetries: state.maxUndeterminedRetries,
    applicationDeadlineEpoch: state.applicationDeadlineEpoch,
    selectionDeadlineEpoch: state.selectionDeadlineEpoch,
    submissionDeadlineEpoch: state.submissionDeadlineEpoch,
    retentionSeconds: state.retentionSeconds,
    createdAtEpoch: state.createdAtEpoch,
    closedAtEpoch: state.closedAtEpoch,
    creationTxHash: existing?.creationTxHash ?? transactionHash,
    lastTxHash: transactionHash,
    finalizedAt: finalizedAtMs,
    snapshotHash,
    nowMs,
  });
  await setGenLayerCampaignDraftStatus({
    id: localCampaignId,
    expectedStatus: "FUNDING",
    status: "OPEN",
    nowMs,
  });
  await updateGenLayerProjectionCursor({
    contractAddress: marketplaceContractAddress(),
    transactionHash,
    finalizedAt: finalizedAtMs,
    snapshotHash,
    nowMs,
  });
  const journal = await recordGenLayerTransactionStatus({
    preparedId,
    status: "FINALIZED",
    lifecycleStatus: finalized.lifecycleStatus,
    executionResult: finalized.executionResult,
    errorCode: null,
    finalizedAt: finalizedAtMs,
    nowMs,
    fenceToken: input.reconciliationFenceToken,
  });
  if (journal?.status !== "FINALIZED") {
    throw new Error("The finalized campaign journal fence was lost.");
  }
  const freshDraft = (await findGenLayerCampaignDraft(localCampaignId)) ?? draft;
  return { campaign: campaignDto(freshDraft, projection, state.applicationCount) };
}

export async function listGenLayerMarketplaceCampaigns(input: {
  requestUrl: string;
  viewerWallet?: string | null;
}): Promise<{ campaigns: GenLayerCampaignDto[]; summary: { openCampaigns: number; lockedGen: string } }> {
  const url = new URL(input.requestUrl);
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue && /^\d+$/.test(limitValue) ? Number(limitValue) : 100;
  const rows = await listGenLayerCampaignDraftRows({
    viewerWallet: input.viewerWallet,
    limit,
  });
  const campaigns = rows.map((row) => campaignDto(row.draft, row.projection, row.applicationCount));
  const locked = rows.reduce(
    (total, row) => total + BigInt(row.projection?.availableAtto ?? "0") + BigInt(row.projection?.reservedAtto ?? "0"),
    0n,
  );
  return {
    campaigns,
    summary: {
      openCampaigns: rows.filter((row) => row.projection?.status === "OPEN").length,
      lockedGen: locked.toString(),
    },
  };
}

export async function getGenLayerMarketplaceCampaignDetail(input: {
  campaignId: string;
  viewerWallet?: string | null;
}): Promise<{
  campaign: GenLayerCampaignDto;
  applications: MarketplaceApplicationDto[];
  viewerApplication: MarketplaceApplicationDto | null;
  viewerRecovery: { preparedId: string; txHash: string } | null;
}> {
  const localCampaignId = requireUuid(input.campaignId, "campaignId");
  const [draft, projection] = await Promise.all([
    findGenLayerCampaignDraft(localCampaignId),
    findGenLayerCampaignProjectionByLocalId(localCampaignId),
  ]);
  if (!draft) throw notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  const viewer = input.viewerWallet?.toLowerCase() ?? null;
  if (!projection && viewer !== draft.brandWallet) {
    throw notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  }
  const privateRows = await listGenLayerPrivateApplicationsForCampaign(localCampaignId);
  const canViewAll = viewer === draft.brandWallet;
  const visible = canViewAll
    ? privateRows
    : privateRows.filter((application) => application.creatorWallet === viewer);
  const viewerPrivateApplication = canViewAll ? null : visible[0] ?? null;
  const [applications, boundRecovery] = await Promise.all([
    Promise.all(visible.map(async (application) =>
      applicationDto(
        application,
        draft.contentSource,
        await findGenLayerAssignmentProjectionByApplicationId(application.id),
      ))),
    viewerPrivateApplication?.status === "PENDING_ONCHAIN" && viewer
      ? findBoundGenLayerApplicationRecovery({
          localApplicationId: viewerPrivateApplication.id,
          actorWallet: viewer,
        })
      : Promise.resolve(null),
  ]);
  return {
    campaign: campaignDto(draft, projection, privateRows.length),
    applications: canViewAll ? applications : [],
    viewerApplication: canViewAll ? null : applications[0] ?? null,
    viewerRecovery: boundRecovery
      ? {
          preparedId: boundRecovery.preparedId,
          txHash: boundRecovery.transactionHash,
        }
      : null,
  };
}

function campaignCreationCall(draft: GenLayerCampaignDraft, campaignId: string): MarketplaceGenLayerCall {
  return {
    network: MARKETPLACE_GENLAYER_NETWORK,
    chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
    contractAddress: marketplaceContractAddress(),
    functionName: "create_campaign",
    args: [
      campaignId,
      draft.clientNonce,
      draft.contentSource,
      draft.title,
      draft.semanticBrief,
      JSON.stringify(draft.requiredPhrases),
      JSON.stringify(draft.forbiddenPhrases),
      draft.requireAdDisclosure,
      BigInt(Math.floor(draft.applicationDeadlineAt / 1_000)),
      BigInt(Math.floor(draft.selectionDeadlineAt / 1_000)),
      BigInt(Math.floor(draft.submissionDeadlineAt / 1_000)),
      BigInt(draft.retentionSeconds),
      BigInt(draft.maxUndeterminedRetries),
      BigInt(draft.budgetAtto),
    ],
    argTypes: [
      "string", "string", "string", "string", "string", "string", "string", "bool",
      "uint256", "uint256", "uint256", "uint256", "uint256", "uint256",
    ],
    value: draft.budgetAtto,
  };
}

function expectedCampaignId(draft: GenLayerCampaignDraft): string {
  const recomputedTerms = deriveCampaignTermsHash({
    contentSource: draft.contentSource,
    title: draft.title,
    brief: draft.semanticBrief,
    requiredPhrases: draft.requiredPhrases,
    forbiddenPhrases: draft.forbiddenPhrases,
    requireAdDisclosure: draft.requireAdDisclosure,
    applicationDeadlineEpoch: Math.floor(draft.applicationDeadlineAt / 1_000),
    selectionDeadlineEpoch: Math.floor(draft.selectionDeadlineAt / 1_000),
    submissionDeadlineEpoch: Math.floor(draft.submissionDeadlineAt / 1_000),
    retentionSeconds: draft.retentionSeconds,
    maxUndeterminedRetries: draft.maxUndeterminedRetries,
  });
  if (recomputedTerms !== draft.termsHash) {
    throw new Error("The saved campaign terms commitment is inconsistent.");
  }
  return deriveCampaignId({
    brand: draft.brandWallet,
    clientNonce: draft.clientNonce,
    termsHash: draft.termsHash,
    budgetAtto: draft.budgetAtto,
  });
}

function assertCampaignMatchesDraft(
  state: GenLayerCampaignState,
  draft: GenLayerCampaignDraft,
  expectedId: string,
): void {
  if (
    state.campaignId !== expectedId ||
    state.brand !== draft.brandWallet ||
    state.clientNonce !== draft.clientNonce ||
    state.contentSource !== draft.contentSource ||
    state.title !== draft.title ||
    state.brief !== draft.semanticBrief ||
    canonicalHash(state.requiredPhrases) !== canonicalHash(draft.requiredPhrases) ||
    canonicalHash(state.forbiddenPhrases) !== canonicalHash(draft.forbiddenPhrases) ||
    state.requireAdDisclosure !== draft.requireAdDisclosure ||
    state.termsHash !== draft.termsHash ||
    state.budgetAtto !== draft.budgetAtto ||
    state.applicationDeadlineEpoch !== Math.floor(draft.applicationDeadlineAt / 1_000) ||
    state.selectionDeadlineEpoch !== Math.floor(draft.selectionDeadlineAt / 1_000) ||
    state.submissionDeadlineEpoch !== Math.floor(draft.submissionDeadlineAt / 1_000) ||
    state.retentionSeconds !== draft.retentionSeconds ||
    state.maxUndeterminedRetries !== draft.maxUndeterminedRetries
  ) {
    throw new Error("The finalized campaign state does not match the frozen draft.");
  }
}

function campaignDto(
  draft: GenLayerCampaignDraft,
  projection: GenLayerCampaignProjection | null,
  applicationCount: number,
) {
  const fundingStatus = projection ? "funded" : "unfunded";
  const status = (projection?.status ?? draft.status).toLowerCase();
  return {
    id: draft.id,
    brandWallet: draft.brandWallet,
    brandName: draft.brandName,
    contentSource: draft.contentSource,
    title: draft.title,
    description: draft.description,
    category: draft.category,
    format: draft.format,
    deliverables: draft.deliverables,
    requiredPhrases: draft.requiredPhrases,
    forbiddenPhrases: draft.forbiddenPhrases,
    requireAdDisclosure: draft.requireAdDisclosure,
    semanticBrief: draft.semanticBrief,
    termsDocument: draft.termsDocument,
    termsHash: draft.termsHash,
    network: MARKETPLACE_GENLAYER_NETWORK,
    assetSymbol: MARKETPLACE_NATIVE_SYMBOL,
    assetDecimals: MARKETPLACE_NATIVE_DECIMALS,
    budgetGen: draft.budgetAtto,
    chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
    deadline: isoTime(draft.applicationDeadlineAt)!,
    selectionDeadline: isoTime(draft.selectionDeadlineAt)!,
    submissionDeadline: isoTime(draft.submissionDeadlineAt)!,
    retentionSeconds: draft.retentionSeconds.toString(),
    maxUndeterminedRetries: draft.maxUndeterminedRetries,
    status,
    fundingStatus,
    marketplaceContract: projection?.contractAddress ?? marketplaceContractAddress(),
    genlayerCampaignId: projection?.campaignId ?? null,
    fundingTxHash: projection?.creationTxHash ?? null,
    fundedAt: projection ? isoTime(projection.finalizedAt) : null,
    availableAtto: projection?.availableAtto ?? "0",
    reservedAtto: projection?.reservedAtto ?? "0",
    settledAtto: projection?.settledAtto ?? "0",
    creatorPaidAtto: projection?.creatorPaidAtto ?? "0",
    brandRefundedAtto: projection?.brandRefundedAtto ?? "0",
    feeAtto: projection?.feeAtto ?? "0",
    applicationCount,
    createdAt: isoTime(draft.createdAt)!,
    updatedAt: isoTime(draft.updatedAt)!,
  } as const;
}

function applicationDto(
  row: GenLayerPrivateApplication,
  contentSource: "X" | "FARCASTER",
  assignment: Awaited<ReturnType<typeof findGenLayerAssignmentProjectionByApplicationId>>,
): MarketplaceApplicationDto {
  return {
    id: row.id,
    campaignId: row.localCampaignId,
    creatorWallet: row.creatorWallet,
    creatorProfileId: row.creatorProfileProjectionId,
    creatorHandle: assignment?.creatorHandle ?? null,
    contentSource,
    creatorExternalUserId: assignment?.creatorExternalUserId ?? null,
    creatorIdentityHash: assignment?.creatorIdentityHash ?? null,
    requestedRateGen: row.requestedRateAtto,
    pitch: row.pitch,
    status: (assignment?.status ?? row.status).toLowerCase() as MarketplaceApplicationDto["status"],
    selectedAt: assignment ? isoTime(assignment.selectedAtEpoch * 1_000) : null,
    acceptedAt: assignment?.acceptedAtEpoch ? isoTime(assignment.acceptedAtEpoch * 1_000) : null,
    genlayerAssignmentId: assignment?.assignmentId ?? null,
    agreementHash: assignment?.agreementHash ?? null,
    selectionTxHash: assignment?.selectionTxHash ?? null,
    acceptanceTxHash: assignment?.acceptedAtEpoch ? assignment.lastTxHash : null,
    contentId: assignment?.postId || null,
    submissionHash: assignment?.submissionHash ?? null,
    submissionTxHash: assignment?.submissionHash ? assignment.lastTxHash : null,
    submittedAt: assignment?.submittedAtEpoch ? isoTime(assignment.submittedAtEpoch * 1_000) : null,
    requestId: assignment?.resolutionRequestId ?? null,
    resolutionRound: assignment?.resolutionRound ?? 0,
    resolutionOutcome: assignment?.outcome?.toLowerCase() as MarketplaceApplicationDto["resolutionOutcome"] ?? null,
    resolutionEvidenceHash: assignment?.evidenceHash ?? null,
    resolutionTxHash: assignment?.outcome ? assignment.lastTxHash : null,
    resolutionChecks: assignment ? assignment.resolutionChecks as MarketplaceApplicationDto["resolutionChecks"] : null,
    genlayerTxHash: assignment?.lastTxHash ?? null,
    createdAt: isoTime(row.createdAt)!,
    updatedAt: isoTime(row.updatedAt)!,
  };
}

async function recordConfirmationFailure(
  preparedId: string,
  error: unknown,
  nowMs: number,
  fenceToken?: string,
): Promise<void> {
  if (error instanceof MarketplaceGenLayerFinalityError) {
    await recordGenLayerTransactionStatus({
      preparedId,
      status: error.retryable ? "ACCEPTED" : "NETWORK_TERMINATED",
      lifecycleStatus: null,
      executionResult: null,
      errorCode: error.code,
      nowMs,
      retryAtMs: error.retryable ? nowMs + 15_000 : 0,
      fenceToken,
    });
    return;
  }
  await recordGenLayerTransactionStatus({
    preparedId,
    status: "RECONCILIATION_REQUIRED",
    lifecycleStatus: null,
    executionResult: null,
    errorCode: "GENLAYER_TRANSACTION_MISMATCH",
    nowMs,
    retryAtMs: 0,
    fenceToken,
  });
}

function confirmationProblem(error: unknown): ApiProblem {
  if (error instanceof MarketplaceGenLayerFinalityError) {
    return new ApiProblem(error.retryable ? 202 : 409, error.code, error.message);
  }
  return new ApiProblem(409, "GENLAYER_TRANSACTION_MISMATCH", errorMessage(error));
}

function assertBrand(draft: GenLayerCampaignDraft, wallet: string): void {
  if (draft.brandWallet !== wallet.toLowerCase()) {
    throw new ApiProblem(403, "CAMPAIGN_OWNER_REQUIRED", "Only the campaign owner may perform this action.");
  }
}

function orderedDeadline(value: unknown, field: string, after: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length > 64) throw invalid(field, `${field} is invalid.`);
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed <= after) {
    throw invalid(field, `${field} must be after the preceding deadline.`);
  }
  return parsed;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalid(field, `${field} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function positiveAtto(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,77}$/.test(value)) {
    throw invalid(field, `${field} must be a canonical positive GEN atto amount.`);
  }
  if (BigInt(value) >= 1n << 256n) throw invalid(field, `${field} exceeds uint256.`);
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw invalid("requireAdDisclosure", "requireAdDisclosure must be boolean.");
  return value;
}

function requireUuidField(value: unknown, field: string): string {
  if (typeof value !== "string") throw invalid(field, `${field} is required.`);
  return requireUuid(value, field);
}

function requireTxHash(value: unknown): string {
  if (typeof value !== "string" || !TRANSACTION_HASH.test(value)) {
    throw invalid("txHash", "txHash must be a 32-byte StudioNet transaction hash.");
  }
  return value.toLowerCase();
}

function invalid(field: string, message: string): ApiProblem {
  return new ApiProblem(400, "INVALID_REQUEST", message, { "X-Invalid-Field": field });
}

function notFound(code: string, message: string): ApiProblem {
  return new ApiProblem(404, code, message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The StudioNet state could not be verified.";
}
