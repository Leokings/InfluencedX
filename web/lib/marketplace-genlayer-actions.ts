import type { AuthenticatedWalletSession } from "./wallet-session.ts";
import { enqueueCampaignProgression } from "./campaign-progression-queue.ts";
import { assertOptionalActorWallet, requireText, requireUuid } from "./marketplace-core.ts";
import {
  campaignSnapshotHash,
  deriveApplicationId,
  deriveAssignmentId,
  deriveResolutionRequestId,
  deriveWithdrawalId,
  normalizeContentSource,
  parseApplicationState,
  parseAssignmentState,
  parseCampaignState,
  parseClaimableState,
  parseProfileState,
  parseWithdrawalState,
  type GenLayerContentSource,
  type GenLayerApplicationState,
  type GenLayerAssignmentState,
  type GenLayerCampaignState,
  type GenLayerWithdrawalState,
} from "./marketplace-genlayer-core.ts";
import {
  bindGenLayerTransactionHash,
  findGenLayerAssignmentProjectionByAssignmentId,
  findGenLayerAssignmentProjectionByApplicationId,
  findGenLayerCampaignProjectionByOnchainId,
  findGenLayerCampaignDraft,
  findGenLayerCampaignProjectionByLocalId,
  findGenLayerPreparedTransaction,
  findGenLayerWithdrawalProjectionById,
  findLatestGenLayerWithdrawalProjection,
  findGenLayerPrivateApplication,
  findGenLayerPrivateApplicationForCreator,
  findGenLayerProfileByWallet,
  insertGenLayerPrivateApplication,
  prepareGenLayerMarketplaceTransaction,
  recordGenLayerTransactionStatus,
  setGenLayerCampaignDraftStatus,
  setGenLayerPrivateApplicationStatus,
  updateGenLayerProjectionCursor,
  upsertGenLayerAssignmentProjection,
  upsertGenLayerCampaignProjection,
  upsertGenLayerClaimableBalance,
  upsertGenLayerWithdrawalProjection,
  type GenLayerAssignmentProjection,
  type GenLayerCampaignDraft,
  type GenLayerCampaignProjection,
  type GenLayerPrivateApplication,
} from "./marketplace-genlayer-repository.ts";
import {
  MARKETPLACE_GENLAYER_CHAIN_ID,
  MARKETPLACE_GENLAYER_NETWORK,
  MarketplaceGenLayerFinalityError,
  assertTransactionMatchesPreparedCall,
  canonicalHash,
  loadFinalizedMarketplaceTransaction,
  marketplaceCalldataAddress,
  marketplaceContractAddress,
  readMarketplaceState,
  terminalMarketplaceTransactionStatus,
  type FinalizedMarketplaceTransaction,
  type MarketplaceGenLayerCall,
} from "./marketplace-genlayer-rpc.ts";
import { getGenLayerMarketplaceCampaignDetail } from "./marketplace-genlayer-service.ts";
import {
  WithdrawalReconcilerClientProblem,
  createWithdrawalReconcilerClient,
  loadWithdrawalReconcilerConfig,
  requireWithdrawalReconcilerClient,
  type WithdrawalReconciliationProjection,
} from "./marketplace-genlayer-withdrawal-client.ts";
import { ApiProblem, assertExactJsonKeys } from "./verification-api.ts";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const IDENTITY_BUNDLE_SOURCES = ["X", "FARCASTER"] as const;
const USER_SUBMITTED_MARKETPLACE_OPERATIONS = new Set([
  "CREATE_CAMPAIGN",
  "APPLY",
  "WITHDRAW_APPLICATION",
  "SELECT_CREATOR",
  "ACCEPT_ASSIGNMENT",
  "DECLINE_ASSIGNMENT",
  "SUBMIT_EVIDENCE",
  "RESOLVE_ASSIGNMENT",
  "REFUND_UNDETERMINED",
  "REFUND_UNALLOCATED",
  "CANCEL_CAMPAIGN",
  "REQUEST_WITHDRAWAL",
  "EXECUTE_WITHDRAWAL",
]);

export function nextGenLayerResolutionProgression(input: {
  assignment: Pick<
    GenLayerAssignmentState,
    "status" | "assignmentId" | "resolutionRequestId" | "resolutionEligibleAtEpoch"
  >;
  previousRequestId: string;
  finalizedAtEpoch: number;
}) {
  if (
    input.assignment.status !== "UNDETERMINED" ||
    !input.assignment.resolutionRequestId ||
    input.assignment.resolutionRequestId === input.previousRequestId
  ) return null;
  return Object.freeze({
    assignmentId: input.assignment.assignmentId,
    requestId: input.assignment.resolutionRequestId,
    delaySeconds: Math.max(
      0,
      input.assignment.resolutionEligibleAtEpoch - input.finalizedAtEpoch,
    ),
  });
}

export async function bindSubmittedGenLayerMarketplaceTransaction(input: {
  preparedId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
}) {
  assertExactJsonKeys(input.body, ["txHash"]);
  const preparedId = requireUuid(input.preparedId, "preparedId");
  const prepared = await findGenLayerPreparedTransaction(preparedId);
  if (
    !prepared ||
    prepared.actorWallet !== input.session.wallet.toLowerCase() ||
    !USER_SUBMITTED_MARKETPLACE_OPERATIONS.has(prepared.operation)
  ) preparedMismatch();
  const txHash = requireHash(input.body.txHash, "txHash");
  const bound = await bindGenLayerTransactionHash({
    preparedId,
    actorWallet: input.session.wallet,
    transactionHash: txHash,
  });
  if (!bound) preparedMismatch();
  return Object.freeze({
    preparedId: bound.preparedId,
    txHash: bound.transactionHash,
    status: bound.status,
  });
}

export async function prepareGenLayerApplication(input: {
  campaignId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
}) {
  assertExactJsonKeys(
    input.body,
    ["creatorWallet", "requestedRateGen", "pitch"],
    ["requestedRateGen", "pitch"],
  );
  assertOptionalActorWallet(input.body, "creatorWallet", input.session.wallet);
  const context = await campaignContext(input.campaignId);
  requireOpenCampaign(context);
  const creator = input.session.wallet.toLowerCase();
  const requestedRateAtto = positiveAtto(input.body.requestedRateGen, "requestedRateGen");
  if (BigInt(requestedRateAtto) > BigInt(context.projection.budgetAtto)) {
    throw problem(400, "APPLICATION_RATE_INVALID", "Requested GEN exceeds the campaign budget.");
  }
  const pitch = requireText(input.body.pitch, "pitch", 10, 2_000);
  const { profile } = await requireActiveIdentityBundle(
    creator,
    context.draft.contentSource,
  );
  let application = await findGenLayerPrivateApplicationForCreator(
    context.draft.id,
    creator,
  );
  const applicationId = deriveApplicationId(context.projection.campaignId, creator);
  const pitchCommitment = canonicalHash({
    protocol: "influencedx-private-pitch-v1",
    application_id: applicationId,
    pitch,
  });
  if (!application) {
    application = await insertGenLayerPrivateApplication({
      localCampaignId: context.draft.id,
      creatorProfileProjectionId: profile.projectionId,
      creatorWallet: creator,
      requestedRateAtto,
      pitch,
      pitchCommitment,
    });
  } else if (
    application.requestedRateAtto !== requestedRateAtto ||
    application.pitchCommitment !== pitchCommitment
  ) {
    throw problem(409, "APPLICATION_ALREADY_PREPARED", "A different application is already bound to this campaign.");
  }
  const call = callPlan("apply_to_campaign", [
    context.projection.campaignId,
    applicationId,
    BigInt(requestedRateAtto),
    pitchCommitment,
  ], ["string", "string", "uint256", "string"]);
  const prepared = await prepareGenLayerMarketplaceTransaction({
    operation: "APPLY",
    call,
    actorWallet: creator,
    localCampaignId: context.draft.id,
    localApplicationId: application.id,
    onchainEntityId: applicationId,
  });
  return mutationResponse(context.draft, context.projection, application, null, prepared);
}

export async function confirmGenLayerApplication(input: ActionInput) {
  const context = await applicationContext(input);
  const applicationId = deriveApplicationId(
    context.campaign.campaignId,
    context.application.creatorWallet,
  );
  const call = callPlan("apply_to_campaign", [
    context.campaign.campaignId,
    applicationId,
    BigInt(context.application.requestedRateAtto),
    context.application.pitchCommitment,
  ], ["string", "string", "uint256", "string"]);
  const finalized = await confirmExact(input, context, "APPLY", call, context.application.creatorWallet);
  const state = parseApplicationState(await readMarketplaceState("get_application", [
    context.campaign.campaignId,
    marketplaceCalldataAddress(context.application.creatorWallet),
  ]));
  assertApplicationBinding(state, context.application, context.campaign.campaignId, applicationId);
  await setGenLayerPrivateApplicationStatus({
    id: context.application.id,
    expectedStatuses: ["PENDING_ONCHAIN"],
    status: state.status,
    nowMs: finalized.finalizedAt * 1_000,
  });
  await finalizePrepared(input, finalized, canonicalHash(state));
  return mutationResponse(
    context.draft,
    context.campaign,
    (await findGenLayerPrivateApplication(context.application.id)) ?? context.application,
    null,
  );
}

export async function prepareGenLayerSelection(input: ActionInput) {
  assertExactJsonKeys(input.body, []);
  const context = await applicationContext(input);
  assertBrand(context.draft, input.session.wallet);
  if (context.application.status !== "APPLIED") invalidState();
  const { profile } = await requireActiveIdentityBundle(
    context.application.creatorWallet,
    context.draft.contentSource,
  );
  if (profile.projectionId !== context.application.creatorProfileProjectionId) {
    identityBundleMismatch();
  }
  const agreedRateAtto = context.application.requestedRateAtto;
  const agreementHash = canonicalHash({
    protocol: "influencedx-assignment-agreement-v2",
    campaign_id: context.campaign.campaignId,
    application_id: deriveApplicationId(context.campaign.campaignId, context.application.creatorWallet),
    creator: context.application.creatorWallet,
    content_source: context.draft.contentSource,
    agreed_rate_atto: agreedRateAtto,
    terms_hash: context.draft.termsHash,
  });
  const assignmentId = deriveAssignmentId({
    campaignId: context.campaign.campaignId,
    creator: context.application.creatorWallet,
    agreedRateAtto,
    agreementHash,
  });
  const call = callPlan("select_creator", [
    context.campaign.campaignId,
    assignmentId,
    context.application.creatorWallet,
    BigInt(agreedRateAtto),
    agreementHash,
  ], ["string", "string", "address", "uint256", "string"]);
  const prepared = await prepareAction("SELECT_CREATOR", call, context, input.session.wallet, assignmentId);
  return mutationResponse(context.draft, context.campaign, context.application, null, prepared);
}

export async function confirmGenLayerSelection(input: ActionInput) {
  const context = await applicationContext(input);
  assertBrand(context.draft, input.session.wallet);
  const agreementHash = canonicalHash({
    protocol: "influencedx-assignment-agreement-v2",
    campaign_id: context.campaign.campaignId,
    application_id: deriveApplicationId(context.campaign.campaignId, context.application.creatorWallet),
    creator: context.application.creatorWallet,
    content_source: context.draft.contentSource,
    agreed_rate_atto: context.application.requestedRateAtto,
    terms_hash: context.draft.termsHash,
  });
  const assignmentId = deriveAssignmentId({
    campaignId: context.campaign.campaignId,
    creator: context.application.creatorWallet,
    agreedRateAtto: context.application.requestedRateAtto,
    agreementHash,
  });
  const call = callPlan("select_creator", [
    context.campaign.campaignId,
    assignmentId,
    context.application.creatorWallet,
    BigInt(context.application.requestedRateAtto),
    agreementHash,
  ], ["string", "string", "address", "uint256", "string"]);
  const finalized = await confirmExact(input, context, "SELECT_CREATOR", call, context.draft.brandWallet);
  const assignment = parseAssignmentState(await readMarketplaceState("get_assignment", [assignmentId]));
  assertAssignmentBinding(assignment, context, assignmentId, agreementHash);
  const campaign = parseCampaignState(await readMarketplaceState("get_campaign", [context.campaign.campaignId]));
  const projected = await projectAssignment(context, assignment, campaign, finalized, finalized.hash);
  await setGenLayerPrivateApplicationStatus({
    id: context.application.id,
    expectedStatuses: ["APPLIED"],
    status: "SELECTED",
    nowMs: finalized.finalizedAt * 1_000,
  });
  await projectCampaign(context.draft, context.campaign, campaign, finalized.hash, finalized.finalizedAt * 1_000);
  await finalizePrepared(input, finalized, canonicalHash({ assignment, campaign }));
  return mutationResponse(context.draft, context.campaign, context.application, projected);
}

export async function prepareGenLayerAccept(input: ActionInput) {
  return prepareAssignmentSimple(
    input,
    "ACCEPT_ASSIGNMENT",
    "accept_assignment",
    "creator",
    true,
  );
}

export async function confirmGenLayerAccept(input: ActionInput) {
  return confirmAssignmentSimple(input, "ACCEPT_ASSIGNMENT", "accept_assignment", "ACCEPTED", "creator");
}

export async function prepareGenLayerDecline(input: ActionInput) {
  return prepareAssignmentSimple(input, "DECLINE_ASSIGNMENT", "decline_assignment", "creator");
}

export async function confirmGenLayerDecline(input: ActionInput) {
  return confirmAssignmentSimple(input, "DECLINE_ASSIGNMENT", "decline_assignment", "DECLINED", "creator");
}

export async function prepareGenLayerApplicationWithdrawal(input: ActionInput) {
  assertExactJsonKeys(input.body, []);
  const context = await applicationContext(input);
  assertCreator(context.application, input.session.wallet);
  const call = callPlan("withdraw_application", [context.campaign.campaignId], ["string"]);
  const prepared = await prepareAction("WITHDRAW_APPLICATION", call, context, input.session.wallet, deriveApplicationId(context.campaign.campaignId, context.application.creatorWallet));
  return mutationResponse(context.draft, context.campaign, context.application, context.assignment, prepared);
}

export async function confirmGenLayerApplicationWithdrawal(input: ActionInput) {
  const context = await applicationContext(input);
  assertCreator(context.application, input.session.wallet);
  const call = callPlan("withdraw_application", [context.campaign.campaignId], ["string"]);
  const finalized = await confirmExact(input, context, "WITHDRAW_APPLICATION", call, context.application.creatorWallet);
  const state = parseApplicationState(await readMarketplaceState("get_application", [
    context.campaign.campaignId,
    marketplaceCalldataAddress(context.application.creatorWallet),
  ]));
  if (state.status !== "WITHDRAWN") stateMismatch();
  await setGenLayerPrivateApplicationStatus({ id: context.application.id, expectedStatuses: ["APPLIED"], status: "WITHDRAWN", nowMs: finalized.finalizedAt * 1_000 });
  await finalizePrepared(input, finalized, canonicalHash(state));
  return mutationResponse(context.draft, context.campaign, (await findGenLayerPrivateApplication(context.application.id)) ?? context.application, context.assignment);
}

export async function prepareGenLayerSubmission(input: ActionInput) {
  assertExactJsonKeys(input.body, ["contentSource", "contentId", "expectedHandle"]);
  const context = await applicationContext(input);
  assertCreator(context.application, input.session.wallet);
  if (!context.assignment || context.assignment.status !== "ACCEPTED") invalidState();
  const identity = await requireActiveIdentityBundle(
    context.application.creatorWallet,
    context.draft.contentSource,
  );
  assertAssignmentIdentityBinding(identity.authoritativeProfile, context.assignment);
  const source = normalizeContentSource(input.body.contentSource);
  if (source !== context.draft.contentSource) throw problem(400, "CONTENT_SOURCE_MISMATCH", "Submission source does not match the campaign.");
  const expectedHandle = canonicalSubmissionHandle(source, input.body.expectedHandle);
  if (expectedHandle !== context.assignment.creatorHandle) {
    throw problem(409, "CREATOR_HANDLE_MISMATCH", "expectedHandle does not match the selected creator identity.");
  }
  const contentId = contentIdentifier(source, input.body.contentId);
  const submissionHash = canonicalHash({
    protocol: "influencedx-submission-v2",
    assignment_id: context.assignment.assignmentId,
    content_source: source,
    content_id: contentId,
    creator_identity_hash: context.assignment.creatorIdentityHash,
  });
  const requestId = deriveResolutionRequestId({
    assignmentId: context.assignment.assignmentId,
    agreementHash: context.assignment.agreementHash,
    submissionHash,
    contentSource: source,
    postId: contentId,
    roundIndex: 0,
  });
  const call = callPlan("submit_evidence", [context.assignment.assignmentId, requestId, contentId, submissionHash], ["string", "string", "string", "string"]);
  const prepared = await prepareAction("SUBMIT_EVIDENCE", call, context, input.session.wallet, context.assignment.assignmentId);
  return mutationResponse(context.draft, context.campaign, context.application, context.assignment, prepared);
}

export async function confirmGenLayerSubmission(input: ActionInput) {
  const context = await applicationContext(input);
  assertCreator(context.application, input.session.wallet);
  if (!context.assignment) invalidState();
  const prepared = await requirePrepared(input.body.preparedId);
  if (
    prepared.operation !== "SUBMIT_EVIDENCE" ||
    prepared.localCampaignId !== context.draft.id ||
    prepared.localApplicationId !== context.application.id ||
    prepared.actorWallet !== context.application.creatorWallet
  ) preparedMismatch();
  const call = storedCall(prepared);
  if (call.functionName !== "submit_evidence" || call.args.length !== 4) preparedMismatch();
  const [assignmentArg, requestArg, contentArg, submissionArg] = call.args;
  if (
    typeof assignmentArg !== "string" ||
    typeof requestArg !== "string" ||
    typeof contentArg !== "string" ||
    typeof submissionArg !== "string" ||
    assignmentArg !== context.assignment.assignmentId
  ) preparedMismatch();
  const source = context.draft.contentSource;
  const contentId = contentIdentifier(source, contentArg);
  const submissionHash = canonicalHash({ protocol: "influencedx-submission-v2", assignment_id: context.assignment.assignmentId, content_source: source, content_id: contentId, creator_identity_hash: context.assignment.creatorIdentityHash });
  const requestId = deriveResolutionRequestId({ assignmentId: context.assignment.assignmentId, agreementHash: context.assignment.agreementHash, submissionHash, contentSource: source, postId: contentId, roundIndex: 0 });
  if (submissionArg !== submissionHash || requestArg !== requestId) preparedMismatch();
  const finalized = await confirmPrepared(input.body, prepared, call, context.application.creatorWallet, input.reconciliationFenceToken);
  const assignment = parseAssignmentState(await readMarketplaceState("get_assignment", [context.assignment.assignmentId]));
  if (assignment.status !== "SUBMITTED" || assignment.submissionHash !== submissionHash || assignment.resolutionRequestId !== requestId || assignment.postId !== contentId) stateMismatch();
  const campaign = parseCampaignState(await readMarketplaceState("get_campaign", [context.campaign.campaignId]));
  const projected = await projectAssignment(context, assignment, campaign, finalized, context.assignment.selectionTxHash);
  await finalizePrepared(input, finalized, canonicalHash(assignment));
  await enqueueCampaignProgression({
    assignmentId: assignment.assignmentId,
    requestId,
    delaySeconds: Math.max(0, assignment.resolutionEligibleAtEpoch - finalized.finalizedAt),
  });
  return mutationResponse(context.draft, context.campaign, context.application, projected);
}

export async function prepareGenLayerResolution(input: ActionInput) {
  assertExactJsonKeys(input.body, []);
  const context = await applicationContext(input);
  if (!context.assignment?.resolutionRequestId) invalidState();
  if (![context.draft.brandWallet, context.application.creatorWallet].includes(input.session.wallet.toLowerCase())) forbidden();
  const call = callPlan("resolve_assignment", [context.assignment.assignmentId, context.assignment.resolutionRequestId], ["string", "string"]);
  const prepared = await prepareAction("RESOLVE_ASSIGNMENT", call, context, input.session.wallet, context.assignment.assignmentId);
  return mutationResponse(context.draft, context.campaign, context.application, context.assignment, prepared);
}

export async function confirmGenLayerResolution(input: ActionInput) {
  const context = await applicationContext(input);
  if (!context.assignment?.resolutionRequestId) invalidState();
  if (![context.draft.brandWallet, context.application.creatorWallet].includes(input.session.wallet.toLowerCase())) forbidden();
  const call = callPlan("resolve_assignment", [context.assignment.assignmentId, context.assignment.resolutionRequestId], ["string", "string"]);
  const finalized = await confirmExact(input, context, "RESOLVE_ASSIGNMENT", call, input.session.wallet);
  const assignment = parseAssignmentState(await readMarketplaceState("get_assignment", [context.assignment.assignmentId]));
  const campaign = parseCampaignState(await readMarketplaceState("get_campaign", [context.campaign.campaignId]));
  const projected = await projectAssignment(context, assignment, campaign, finalized, context.assignment.selectionTxHash);
  await projectCampaign(context.draft, context.campaign, campaign, finalized.hash, finalized.finalizedAt * 1_000);
  await projectClaimable(context.application.creatorWallet, finalized.hash, finalized.finalizedAt * 1_000);
  await projectClaimable(context.draft.brandWallet, finalized.hash, finalized.finalizedAt * 1_000);
  await finalizePrepared(input, finalized, canonicalHash({ assignment, campaign }));
  const retry = nextGenLayerResolutionProgression({
    assignment,
    previousRequestId: context.assignment.resolutionRequestId,
    finalizedAtEpoch: finalized.finalizedAt,
  });
  if (retry) await enqueueCampaignProgression(retry);
  return mutationResponse(context.draft, context.campaign, context.application, projected);
}

/**
 * Reconciles an operator-finalized permissionless resolution back into the
 * deployment-scoped Neon read model. The contract remains authoritative.
 */
export async function reconcileGenLayerOperatorResolution(input: {
  assignmentId: string;
  requestId: string;
  transactionHash: string;
  finalizedAtMs: number;
}) {
  const existing = await findGenLayerAssignmentProjectionByAssignmentId(
    requireHash(input.assignmentId, "assignmentId"),
  );
  if (!existing || existing.resolutionRequestId !== requireHash(input.requestId, "requestId")) {
    throw problem(409, "GENLAYER_OPERATOR_BINDING_MISMATCH", "The operator result is not bound to a projected assignment.");
  }
  const application = await findGenLayerPrivateApplication(existing.localApplicationId);
  if (!application) stateMismatch();
  const context = await applicationContext({
    campaignId: application.localCampaignId,
    applicationId: application.id,
  });
  const assignment = parseAssignmentState(
    await readMarketplaceState("get_assignment", [existing.assignmentId]),
  );
  const campaign = parseCampaignState(
    await readMarketplaceState("get_campaign", [existing.campaignId]),
  );
  if (
    assignment.assignmentId !== existing.assignmentId ||
    assignment.campaignId !== existing.campaignId ||
    campaign.campaignId !== existing.campaignId
  ) stateMismatch();
  assertOperatorAssignmentBinding(existing, assignment, campaign);
  const finalized = await loadExactOperatorFinalizedTransaction({
    transactionHash: input.transactionHash,
    finalizedAtMs: input.finalizedAtMs,
    functionName: "resolve_assignment",
    args: [existing.assignmentId, input.requestId],
  });
  const finalizedAtMs = finalized.finalizedAt * 1_000;
  const projected = await projectAssignment(
    context,
    assignment,
    campaign,
    finalized,
    existing.selectionTxHash,
  );
  await Promise.all([
    projectCampaign(context.draft, context.campaign, campaign, finalized.hash, finalizedAtMs),
    projectClaimable(context.draft.brandWallet, finalized.hash, finalizedAtMs),
    projectClaimable(context.application.creatorWallet, finalized.hash, finalizedAtMs),
    updateGenLayerProjectionCursor({
      contractAddress: marketplaceContractAddress(),
      transactionHash: finalized.hash,
      finalizedAt: finalizedAtMs,
      snapshotHash: canonicalHash({ assignment, campaign }),
    }),
  ]);
  const retry = nextGenLayerResolutionProgression({
    assignment,
    previousRequestId: input.requestId,
    finalizedAtEpoch: finalized.finalizedAt,
  });
  if (retry) await enqueueCampaignProgression(retry);
  return Object.freeze({ assignment: projected, campaign });
}

/** Reconciles a permissionless assignment expiry from exact finalized state. */
export async function reconcileGenLayerOperatorExpiry(input: {
  assignmentId: string;
  transactionHash: string;
  finalizedAtMs: number;
}) {
  const existing = await findGenLayerAssignmentProjectionByAssignmentId(
    requireHash(input.assignmentId, "assignmentId"),
  );
  if (!existing) {
    throw problem(409, "GENLAYER_OPERATOR_BINDING_MISMATCH", "The operator expiry is not bound to a projected assignment.");
  }
  const application = await findGenLayerPrivateApplication(existing.localApplicationId);
  if (!application) stateMismatch();
  const context = await applicationContext({
    campaignId: application.localCampaignId,
    applicationId: application.id,
  });
  const [assignment, campaign, finalized] = await Promise.all([
    readMarketplaceState("get_assignment", [existing.assignmentId]).then(parseAssignmentState),
    readMarketplaceState("get_campaign", [existing.campaignId]).then(parseCampaignState),
    loadExactOperatorFinalizedTransaction({
      transactionHash: input.transactionHash,
      finalizedAtMs: input.finalizedAtMs,
      functionName: "expire_assignment",
      args: [existing.assignmentId],
    }),
  ]);
  assertOperatorAssignmentBinding(existing, assignment, campaign);
  if (!["EXPIRED", "SETTLED_FAIL"].includes(assignment.status)) stateMismatch();
  const finalizedAtMs = finalized.finalizedAt * 1_000;
  const projected = await projectAssignment(
    context,
    assignment,
    campaign,
    finalized,
    existing.selectionTxHash,
  );
  await Promise.all([
    projectCampaign(context.draft, context.campaign, campaign, finalized.hash, finalizedAtMs),
    projectClaimable(context.draft.brandWallet, finalized.hash, finalizedAtMs),
    projectClaimable(context.application.creatorWallet, finalized.hash, finalizedAtMs),
    updateGenLayerProjectionCursor({
      contractAddress: marketplaceContractAddress(),
      transactionHash: finalized.hash,
      finalizedAt: finalizedAtMs,
      snapshotHash: canonicalHash({ assignment, campaign }),
    }),
  ]);
  return Object.freeze({ assignment: projected, campaign });
}

/** Reconciles a permissionless campaign finalization and brand refund. */
export async function reconcileGenLayerOperatorCampaignFinalization(input: {
  campaignId: string;
  transactionHash: string;
  finalizedAtMs: number;
}) {
  const existing = await findGenLayerCampaignProjectionByOnchainId(
    requireHash(input.campaignId, "campaignId"),
  );
  if (!existing) {
    throw problem(409, "GENLAYER_OPERATOR_BINDING_MISMATCH", "The operator finalization is not bound to a projected campaign.");
  }
  const context = await campaignContext(existing.localCampaignId);
  const [campaign, finalized] = await Promise.all([
    readMarketplaceState("get_campaign", [existing.campaignId]).then(parseCampaignState),
    loadExactOperatorFinalizedTransaction({
      transactionHash: input.transactionHash,
      finalizedAtMs: input.finalizedAtMs,
      functionName: "finalize_campaign",
      args: [existing.campaignId],
    }),
  ]);
  assertOperatorCampaignBinding(existing, campaign);
  if (campaign.status !== "CLOSED" || campaign.reservedAtto !== "0" || campaign.availableAtto !== "0") {
    stateMismatch();
  }
  const finalizedAtMs = finalized.finalizedAt * 1_000;
  const projected = await projectCampaign(
    context.draft,
    context.projection,
    campaign,
    finalized.hash,
    finalizedAtMs,
  );
  await Promise.all([
    setGenLayerCampaignDraftStatus({
      id: context.draft.id,
      expectedStatus: context.draft.status,
      status: "CLOSED",
      nowMs: finalizedAtMs,
    }),
    projectClaimable(context.draft.brandWallet, finalized.hash, finalizedAtMs),
    updateGenLayerProjectionCursor({
      contractAddress: marketplaceContractAddress(),
      transactionHash: finalized.hash,
      finalizedAt: finalizedAtMs,
      snapshotHash: canonicalHash(campaign),
    }),
  ]);
  return Object.freeze({ campaign: projected });
}

export async function prepareGenLayerRefundUndetermined(input: ActionInput) {
  return prepareAssignmentSimple(input, "REFUND_UNDETERMINED", "refund_undetermined", "participant");
}

export async function confirmGenLayerRefundUndetermined(input: ActionInput) {
  return confirmAssignmentSimple(input, "REFUND_UNDETERMINED", "refund_undetermined", "REFUNDED", "participant");
}

export async function prepareGenLayerCampaignCancel(input: CampaignActionInput) {
  return prepareCampaignSimple(input, "CANCEL_CAMPAIGN", "cancel_campaign");
}

export async function confirmGenLayerCampaignCancel(input: CampaignActionInput) {
  return confirmCampaignSimple(input, "CANCEL_CAMPAIGN", "cancel_campaign", "CANCELLED");
}

export async function prepareGenLayerRefundUnallocated(input: CampaignActionInput) {
  assertExactJsonKeys(input.body, []);
  const context = await campaignContext(input.campaignId);
  assertBrand(context.draft, input.session.wallet);
  const state = parseCampaignState(
    await readMarketplaceState("get_campaign", [context.projection.campaignId]),
  );
  assertOperatorCampaignBinding(context.projection, state);
  const availability = genLayerUnallocatedRefundAvailability(state);
  if (availability.reason === "EARLY") {
    throw problem(
      409,
      "REFUND_EARLY",
      `Unused GEN unlocks ${availability.unlocksAt}.`,
    );
  }
  if (availability.reason === "EMPTY") {
    throw problem(409, "NO_UNALLOCATED", "No unused GEN remains.");
  }
  const call = callPlan(
    "refund_unallocated",
    [context.projection.campaignId],
    ["string"],
  );
  const prepared = await prepareGenLayerMarketplaceTransaction({
    operation: "REFUND_UNALLOCATED",
    call,
    actorWallet: input.session.wallet,
    localCampaignId: context.draft.id,
    onchainEntityId: context.projection.campaignId,
  });
  return {
    campaign: (await getGenLayerMarketplaceCampaignDetail({
      campaignId: context.draft.id,
      viewerWallet: input.session.wallet,
    })).campaign,
    ...preparedMutationFields(prepared),
  };
}

export async function confirmGenLayerRefundUnallocated(input: CampaignActionInput) {
  return confirmCampaignSimple(input, "REFUND_UNALLOCATED", "refund_unallocated", "OPEN");
}

export async function getGenLayerSettlement(input: CampaignActionInput) {
  const context = await campaignContext(input.campaignId);
  const wallet = input.session.wallet.toLowerCase();
  const application = await findGenLayerPrivateApplicationForCreator(
    context.draft.id,
    wallet,
  );
  const role = wallet === context.draft.brandWallet
    ? "brand"
    : application?.creatorWallet === wallet
      ? "creator"
      : null;
  if (!role) forbidden();
  const [claimable, authoritativeCampaign] = await Promise.all([
    readMarketplaceState("get_claimable", [marketplaceCalldataAddress(wallet)])
      .then(parseClaimableState),
    readMarketplaceState("get_campaign", [context.projection.campaignId])
      .then(parseCampaignState),
  ]);
  assertOperatorCampaignBinding(context.projection, authoritativeCampaign);
  const refundAvailability = genLayerUnallocatedRefundAvailability(authoritativeCampaign);
  let latestWithdrawal = await findLatestGenLayerWithdrawalProjection(wallet);
  const withdrawalReconciliation = latestWithdrawal &&
    ["EMITTED_UNCONFIRMED", "CONFIRMED"].includes(latestWithdrawal.status)
    ? await pollWithdrawalReconciliation(latestWithdrawal.withdrawalId)
    : null;
  if (withdrawalReconciliation?.status === "FINALIZED") {
    const authoritative = parseWithdrawalState(await readMarketplaceState("get_withdrawal", [latestWithdrawal!.withdrawalId]));
    if (
      authoritative.status !== "CONFIRMED" ||
      authoritative.evidenceHash !== withdrawalReconciliation.evidenceHash ||
      !withdrawalReconciliation.confirmationTxHash ||
      !withdrawalReconciliation.finalizedAt
    ) stateMismatch();
    await projectWithdrawal(
      authoritative,
      latestWithdrawal!.requestTxHash,
      withdrawalReconciliation.confirmationTxHash,
      Date.parse(withdrawalReconciliation.finalizedAt),
    );
    latestWithdrawal = await findLatestGenLayerWithdrawalProjection(wallet);
  }
  return {
    settlement: {
      actorWallet: wallet,
      role,
      claimableGen: claimable.claimableAtto,
      claimableAtto: claimable.claimableAtto,
      unallocatedGen: role === "brand" ? authoritativeCampaign.availableAtto : "0",
      unallocatedAtto: role === "brand" ? authoritativeCampaign.availableAtto : "0",
      canClaim: BigInt(claimable.claimableAtto) > 0n,
      canRefundUnallocated: role === "brand" && refundAvailability.canRefund,
      selectionDeadline: refundAvailability.unlocksAt,
      withdrawalId: latestWithdrawal?.withdrawalId ?? null,
      withdrawalStatus: latestWithdrawal?.status ?? null,
      withdrawalDelivered: latestWithdrawal?.status === "CONFIRMED",
      withdrawalReconciliation,
    },
  };
}

export async function prepareGenLayerWithdrawal(input: CampaignActionInput) {
  assertExactJsonKeys(input.body, []);
  const context = await campaignContext(input.campaignId);
  const wallet = input.session.wallet.toLowerCase();
  const claimable = parseClaimableState(await readMarketplaceState("get_claimable", [marketplaceCalldataAddress(wallet)]));
  if (claimable.account !== wallet || BigInt(claimable.claimableAtto) <= 0n) invalidState();
  const withdrawalId = deriveWithdrawalId({
    account: wallet,
    nonce: claimable.nextWithdrawalNonce,
    amountAtto: claimable.claimableAtto,
  });
  const call = callPlan("request_withdrawal", [withdrawalId, BigInt(claimable.claimableAtto)], ["string", "uint256"]);
  const prepared = await prepareGenLayerMarketplaceTransaction({ operation: "REQUEST_WITHDRAWAL", call, actorWallet: wallet, localCampaignId: context.draft.id, onchainEntityId: withdrawalId });
  return { ...(await getGenLayerSettlement(input)), ...preparedMutationFields(prepared), withdrawalId };
}

export async function confirmGenLayerWithdrawal(input: CampaignActionInput) {
  const context = await campaignContext(input.campaignId);
  const prepared = await requirePrepared(input.body.preparedId);
  if (prepared.operation !== "REQUEST_WITHDRAWAL" || prepared.localCampaignId !== context.draft.id || prepared.actorWallet !== input.session.wallet.toLowerCase()) preparedMismatch();
  const call = storedCall(prepared);
  const finalized = await confirmPrepared(input.body, prepared, call, input.session.wallet, input.reconciliationFenceToken);
  const withdrawalId = requireHash(prepared.onchainEntityId, "withdrawalId");
  const withdrawal = parseWithdrawalState(await readMarketplaceState("get_withdrawal", [withdrawalId]));
  if (withdrawal.status !== "PENDING" || withdrawal.account !== input.session.wallet.toLowerCase()) stateMismatch();
  await projectWithdrawal(withdrawal, finalized.hash, finalized.hash, finalized.finalizedAt * 1_000);
  await projectClaimable(withdrawal.account, finalized.hash, finalized.finalizedAt * 1_000);
  await finalizePrepared(input, finalized, canonicalHash(withdrawal));
  return { ...(await getGenLayerSettlement(input)), withdrawal: withdrawalDto(withdrawal), withdrawalId };
}

export async function prepareGenLayerWithdrawalExecution(input: CampaignActionInput) {
  assertExactJsonKeys(input.body, []);
  await requiredWithdrawalReconciler();
  const context = await campaignContext(input.campaignId);
  const latest = await findLatestGenLayerWithdrawalProjection(input.session.wallet);
  const withdrawalId = requireHash(latest?.withdrawalId, "withdrawalId");
  const withdrawal = parseWithdrawalState(await readMarketplaceState("get_withdrawal", [withdrawalId]));
  if (withdrawal.account !== input.session.wallet.toLowerCase() || withdrawal.status !== "PENDING") invalidState();
  const call = callPlan("execute_withdrawal", [withdrawalId], ["string"]);
  const prepared = await prepareGenLayerMarketplaceTransaction({ operation: "EXECUTE_WITHDRAWAL", call, actorWallet: withdrawal.account, localCampaignId: context.draft.id, onchainEntityId: withdrawalId });
  return { ...(await getGenLayerSettlement(input)), ...preparedMutationFields(prepared), withdrawalId };
}

export async function confirmGenLayerWithdrawalExecution(input: CampaignActionInput) {
  const reconciler = await requiredWithdrawalReconciler();
  const prepared = await requirePrepared(input.body.preparedId);
  if (prepared.operation !== "EXECUTE_WITHDRAWAL" || prepared.actorWallet !== input.session.wallet.toLowerCase()) preparedMismatch();
  const call = storedCall(prepared);
  const finalized = await confirmPrepared(input.body, prepared, call, input.session.wallet, input.reconciliationFenceToken);
  const withdrawalId = requireHash(prepared.onchainEntityId, "withdrawalId");
  const withdrawal = parseWithdrawalState(await readMarketplaceState("get_withdrawal", [withdrawalId]));
  if (withdrawal.status !== "EMITTED_UNCONFIRMED") stateMismatch();
  const existing = await findGenLayerWithdrawalProjectionById(withdrawalId);
  if (!existing) stateMismatch();
  await projectWithdrawal(withdrawal, existing.requestTxHash, finalized.hash, finalized.finalizedAt * 1_000);
  await finalizePrepared(input, finalized, canonicalHash(withdrawal));
  let reconciliation: WithdrawalReconciliationProjection;
  try {
    ({ reconciliation } = await reconciler.submit(withdrawalId));
  } catch (error) {
    throw reconcilerProblem(error);
  }
  return {
    ...(await getGenLayerSettlement(input)),
    withdrawal: withdrawalDto(withdrawal),
    withdrawalId,
    withdrawalStatus: withdrawal.status,
    withdrawalDelivered: false,
    withdrawalReconciliation: reconciliation,
  };
}

type ActionInput = Readonly<{
  campaignId: string;
  applicationId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
  reconciliationFenceToken?: string;
}>;

type CampaignActionInput = Readonly<{
  campaignId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
  reconciliationFenceToken?: string;
}>;

type ActionContext = Readonly<{
  draft: GenLayerCampaignDraft;
  campaign: GenLayerCampaignProjection;
  application: GenLayerPrivateApplication;
  assignment: GenLayerAssignmentProjection | null;
}>;

async function campaignContext(localCampaignId: string) {
  const id = requireUuid(localCampaignId, "campaignId");
  const [draft, projection] = await Promise.all([
    findGenLayerCampaignDraft(id),
    findGenLayerCampaignProjectionByLocalId(id),
  ]);
  if (!draft || !projection) throw problem(404, "CAMPAIGN_NOT_FOUND", "Funded campaign not found.");
  return { draft, projection };
}

async function applicationContext(input: Pick<ActionInput, "campaignId" | "applicationId">): Promise<ActionContext> {
  const campaign = await campaignContext(input.campaignId);
  const applicationId = requireUuid(input.applicationId, "applicationId");
  const application = await findGenLayerPrivateApplication(applicationId);
  if (!application || application.localCampaignId !== campaign.draft.id) throw problem(404, "APPLICATION_NOT_FOUND", "Application not found.");
  const assignment = await findGenLayerAssignmentProjectionByApplicationId(application.id);
  return { draft: campaign.draft, campaign: campaign.projection, application, assignment };
}

async function prepareAction(
  operation: Parameters<typeof prepareGenLayerMarketplaceTransaction>[0]["operation"],
  call: MarketplaceGenLayerCall,
  context: ActionContext,
  actor: string,
  entityId: string,
) {
  return prepareGenLayerMarketplaceTransaction({ operation, call, actorWallet: actor, localCampaignId: context.draft.id, localApplicationId: context.application.id, onchainEntityId: entityId });
}

async function prepareAssignmentSimple(
  input: ActionInput,
  operation: Parameters<typeof prepareGenLayerMarketplaceTransaction>[0]["operation"],
  method: string,
  actor: "creator" | "participant",
  requireCreatorIdentityBundle = false,
) {
  assertExactJsonKeys(input.body, []);
  const context = await applicationContext(input);
  if (!context.assignment) invalidState();
  if (actor === "creator") assertCreator(context.application, input.session.wallet);
  else if (![context.draft.brandWallet, context.application.creatorWallet].includes(input.session.wallet.toLowerCase())) forbidden();
  if (requireCreatorIdentityBundle) {
    const identity = await requireActiveIdentityBundle(
      context.application.creatorWallet,
      context.draft.contentSource,
    );
    assertAssignmentIdentityBinding(identity.authoritativeProfile, context.assignment);
  }
  const call = callPlan(method, [context.assignment.assignmentId], ["string"]);
  const prepared = await prepareAction(operation, call, context, input.session.wallet, context.assignment.assignmentId);
  return mutationResponse(context.draft, context.campaign, context.application, context.assignment, prepared);
}

async function confirmAssignmentSimple(
  input: ActionInput,
  operation: Parameters<typeof prepareGenLayerMarketplaceTransaction>[0]["operation"],
  method: string,
  expectedStatus: GenLayerAssignmentState["status"],
  actor: "creator" | "participant",
) {
  const context = await applicationContext(input);
  if (!context.assignment) invalidState();
  if (actor === "creator") assertCreator(context.application, input.session.wallet);
  else if (![context.draft.brandWallet, context.application.creatorWallet].includes(input.session.wallet.toLowerCase())) forbidden();
  const call = callPlan(method, [context.assignment.assignmentId], ["string"]);
  const finalized = await confirmExact(input, context, operation, call, input.session.wallet);
  const assignment = parseAssignmentState(await readMarketplaceState("get_assignment", [context.assignment.assignmentId]));
  if (assignment.status !== expectedStatus) stateMismatch();
  const campaign = parseCampaignState(await readMarketplaceState("get_campaign", [context.campaign.campaignId]));
  const projected = await projectAssignment(context, assignment, campaign, finalized, context.assignment.selectionTxHash);
  if (expectedStatus === "ACCEPTED") await setGenLayerPrivateApplicationStatus({ id: context.application.id, expectedStatuses: ["SELECTED"], status: "ACCEPTED", nowMs: finalized.finalizedAt * 1_000 });
  if (expectedStatus === "DECLINED") await setGenLayerPrivateApplicationStatus({ id: context.application.id, expectedStatuses: ["SELECTED"], status: "DECLINED", nowMs: finalized.finalizedAt * 1_000 });
  await projectCampaign(context.draft, context.campaign, campaign, finalized.hash, finalized.finalizedAt * 1_000);
  await finalizePrepared(input, finalized, canonicalHash({ assignment, campaign }));
  return mutationResponse(context.draft, context.campaign, context.application, projected);
}

async function prepareCampaignSimple(
  input: CampaignActionInput,
  operation: Parameters<typeof prepareGenLayerMarketplaceTransaction>[0]["operation"],
  method: string,
) {
  assertExactJsonKeys(input.body, []);
  const context = await campaignContext(input.campaignId);
  assertBrand(context.draft, input.session.wallet);
  const call = callPlan(method, [context.projection.campaignId], ["string"]);
  const prepared = await prepareGenLayerMarketplaceTransaction({ operation, call, actorWallet: input.session.wallet, localCampaignId: context.draft.id, onchainEntityId: context.projection.campaignId });
  return { campaign: (await getGenLayerMarketplaceCampaignDetail({ campaignId: context.draft.id, viewerWallet: input.session.wallet })).campaign, ...preparedMutationFields(prepared) };
}

async function confirmCampaignSimple(
  input: CampaignActionInput,
  operation: Parameters<typeof prepareGenLayerMarketplaceTransaction>[0]["operation"],
  method: string,
  expectedStatus: GenLayerCampaignState["status"],
) {
  const context = await campaignContext(input.campaignId);
  assertBrand(context.draft, input.session.wallet);
  const call = callPlan(method, [context.projection.campaignId], ["string"]);
  const prepared = await requirePrepared(input.body.preparedId);
  if (prepared.operation !== operation || prepared.localCampaignId !== context.draft.id) preparedMismatch();
  const finalized = await confirmPrepared(input.body, prepared, call, input.session.wallet, input.reconciliationFenceToken);
  const state = parseCampaignState(await readMarketplaceState("get_campaign", [context.projection.campaignId]));
  if (state.status !== expectedStatus || (method === "refund_unallocated" && state.availableAtto !== "0")) stateMismatch();
  const projected = await projectCampaign(context.draft, context.projection, state, finalized.hash, finalized.finalizedAt * 1_000);
  if (expectedStatus !== "OPEN") await setGenLayerCampaignDraftStatus({ id: context.draft.id, expectedStatus: context.draft.status, status: expectedStatus, nowMs: finalized.finalizedAt * 1_000 });
  await projectClaimable(context.draft.brandWallet, finalized.hash, finalized.finalizedAt * 1_000);
  await finalizePrepared(input, finalized, canonicalHash(state));
  return { campaign: (await getGenLayerMarketplaceCampaignDetail({ campaignId: context.draft.id, viewerWallet: input.session.wallet })).campaign, projection: projected };
}

async function confirmExact(
  input: ActionInput,
  context: ActionContext,
  operation: Parameters<typeof prepareGenLayerMarketplaceTransaction>[0]["operation"],
  call: MarketplaceGenLayerCall,
  actor: string,
) {
  const prepared = await requirePrepared(input.body.preparedId);
  if (prepared.operation !== operation || prepared.localCampaignId !== context.draft.id || prepared.localApplicationId !== context.application.id) preparedMismatch();
  return confirmPrepared(input.body, prepared, call, actor, input.reconciliationFenceToken);
}

async function confirmPrepared(
  body: Record<string, unknown>,
  prepared: NonNullable<Awaited<ReturnType<typeof findGenLayerPreparedTransaction>>>,
  call: MarketplaceGenLayerCall,
  actor: string,
  reconciliationFenceToken?: string,
): Promise<FinalizedMarketplaceTransaction> {
  assertExactJsonKeys(body, ["preparedId", "txHash"]);
  const txHash = requireHash(body.txHash, "txHash");
  if (
    prepared.actorWallet !== actor.toLowerCase() ||
    prepared.contractAddress !== call.contractAddress ||
    prepared.functionName !== call.functionName ||
    prepared.argsHash !== canonicalHash(call.args) ||
    prepared.valueAtto !== call.value ||
    (prepared.transactionHash && prepared.transactionHash !== txHash)
  ) preparedMismatch();
  const bound = await bindGenLayerTransactionHash({ preparedId: prepared.preparedId, actorWallet: actor, transactionHash: txHash });
  if (!bound) preparedMismatch();
  try {
    const finalized = await loadFinalizedMarketplaceTransaction(txHash);
    assertTransactionMatchesPreparedCall({ transaction: finalized, call, actorWallet: actor });
    return finalized;
  } catch (error) {
    const retryable = error instanceof MarketplaceGenLayerFinalityError && error.retryable;
    const terminalStatus = terminalMarketplaceTransactionStatus(error);
    await recordGenLayerTransactionStatus({ preparedId: prepared.preparedId, status: terminalStatus ?? (retryable ? "ACCEPTED" : "RECONCILIATION_REQUIRED"), lifecycleStatus: null, executionResult: null, errorCode: error instanceof MarketplaceGenLayerFinalityError ? error.code : "GENLAYER_TRANSACTION_MISMATCH", retryAtMs: retryable ? Date.now() + 15_000 : 0, fenceToken: reconciliationFenceToken });
    if (error instanceof MarketplaceGenLayerFinalityError) throw new ApiProblem(retryable ? 202 : 409, error.code, error.message);
    throw problem(409, "GENLAYER_TRANSACTION_MISMATCH", error instanceof Error ? error.message : "Transaction mismatch.");
  }
}

export function genLayerUnallocatedRefundAvailability(
  campaign: Pick<GenLayerCampaignState, "availableAtto" | "selectionDeadlineEpoch">,
  nowEpoch = Math.floor(Date.now() / 1_000),
): Readonly<{
  canRefund: boolean;
  reason: "EARLY" | "EMPTY" | null;
  unlocksAt: string;
}> {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) {
    throw new Error("The refund eligibility clock is invalid.");
  }
  const unlocksAt = new Date(campaign.selectionDeadlineEpoch * 1_000).toISOString();
  if (BigInt(campaign.availableAtto) <= 0n) {
    return Object.freeze({ canRefund: false, reason: "EMPTY", unlocksAt });
  }
  if (nowEpoch < campaign.selectionDeadlineEpoch) {
    return Object.freeze({ canRefund: false, reason: "EARLY", unlocksAt });
  }
  return Object.freeze({ canRefund: true, reason: null, unlocksAt });
}

async function finalizePrepared(
  input: { body: Record<string, unknown>; reconciliationFenceToken?: string },
  finalized: FinalizedMarketplaceTransaction,
  snapshotHash: string,
) {
  if (typeof input.body.preparedId !== "string") preparedMismatch();
  const preparedId = requireUuid(input.body.preparedId, "preparedId");
  const finalizedAt = finalized.finalizedAt * 1_000;
  await updateGenLayerProjectionCursor({
    contractAddress: marketplaceContractAddress(),
    transactionHash: finalized.hash,
    finalizedAt,
    snapshotHash,
  });
  const journal = await recordGenLayerTransactionStatus({
    preparedId,
    status: "FINALIZED",
    lifecycleStatus: finalized.lifecycleStatus,
    executionResult: finalized.executionResult,
    errorCode: null,
    finalizedAt,
    fenceToken: input.reconciliationFenceToken,
  });
  if (journal?.status !== "FINALIZED") {
    throw new Error("The finalized GenLayer journal fence was lost.");
  }
}

async function loadExactOperatorFinalizedTransaction(input: {
  transactionHash: string;
  finalizedAtMs: number;
  functionName: "resolve_assignment" | "expire_assignment" | "finalize_campaign";
  args: string[];
}): Promise<FinalizedMarketplaceTransaction> {
  if (!Number.isSafeInteger(input.finalizedAtMs) || input.finalizedAtMs <= 0) {
    throw new Error("Operator finalizedAt is invalid.");
  }
  const finalized = await loadFinalizedMarketplaceTransaction(
    requireHash(input.transactionHash, "transactionHash"),
  );
  if (
    finalized.recipient !== marketplaceContractAddress() ||
    finalized.functionName !== input.functionName ||
    finalized.valueAtto !== "0" ||
    finalized.args === null ||
    finalized.args.length !== input.args.length ||
    finalized.args.some((value, index) => value !== input.args[index])
  ) {
    throw problem(
      409,
      "GENLAYER_OPERATOR_TRANSACTION_MISMATCH",
      "The finalized operator transaction does not match the expected zero-value V2 call.",
    );
  }
  return finalized;
}

function assertOperatorAssignmentBinding(
  existing: GenLayerAssignmentProjection,
  assignment: GenLayerAssignmentState,
  campaign: GenLayerCampaignState,
): void {
  if (
    assignment.assignmentId !== existing.assignmentId ||
    assignment.campaignId !== existing.campaignId ||
    assignment.brand !== existing.brandWallet ||
    assignment.creator !== existing.creatorWallet ||
    assignment.contentSource !== existing.contentSource ||
    assignment.creatorIdentityHash !== existing.creatorIdentityHash ||
    assignment.applicationId !== existing.applicationId ||
    assignment.agreementHash !== existing.agreementHash ||
    assignment.agreedRateAtto !== existing.agreedRateAtto ||
    campaign.campaignId !== existing.campaignId ||
    campaign.brand !== existing.brandWallet ||
    campaign.contentSource !== existing.contentSource ||
    campaign.maxUndeterminedRetries !== existing.maxUndeterminedRetries
  ) stateMismatch();
}

function assertOperatorCampaignBinding(
  existing: GenLayerCampaignProjection,
  campaign: GenLayerCampaignState,
): void {
  if (
    campaign.campaignId !== existing.campaignId ||
    campaign.brand !== existing.brandWallet ||
    campaign.clientNonce !== existing.clientNonce ||
    campaign.contentSource !== existing.contentSource ||
    campaign.termsHash !== existing.termsHash ||
    campaign.budgetAtto !== existing.budgetAtto ||
    campaign.applicationDeadlineEpoch !== existing.applicationDeadlineEpoch ||
    campaign.selectionDeadlineEpoch !== existing.selectionDeadlineEpoch ||
    campaign.submissionDeadlineEpoch !== existing.submissionDeadlineEpoch ||
    campaign.retentionSeconds !== existing.retentionSeconds ||
    campaign.maxUndeterminedRetries !== existing.maxUndeterminedRetries
  ) stateMismatch();
}

async function projectCampaign(
  draft: GenLayerCampaignDraft,
  existing: GenLayerCampaignProjection,
  state: GenLayerCampaignState,
  txHash: string,
  finalizedAt: number,
) {
  return upsertGenLayerCampaignProjection({
    campaignId: state.campaignId, localCampaignId: draft.id, contractAddress: marketplaceContractAddress(), brandWallet: state.brand, clientNonce: state.clientNonce, contentSource: state.contentSource, termsHash: state.termsHash, budgetAtto: state.budgetAtto, availableAtto: state.availableAtto, reservedAtto: state.reservedAtto, settledAtto: state.settledAtto, creatorPaidAtto: state.creatorPaidAtto, brandRefundedAtto: state.brandRefundedAtto, feeAtto: state.feeAtto, status: state.status, feeBps: state.feeBps, treasuryWallet: state.treasury, applicationCount: state.applicationCount, assignmentCount: state.assignmentCount, maxUndeterminedRetries: state.maxUndeterminedRetries, applicationDeadlineEpoch: state.applicationDeadlineEpoch, selectionDeadlineEpoch: state.selectionDeadlineEpoch, submissionDeadlineEpoch: state.submissionDeadlineEpoch, retentionSeconds: state.retentionSeconds, createdAtEpoch: state.createdAtEpoch, closedAtEpoch: state.closedAtEpoch, creationTxHash: existing.creationTxHash, lastTxHash: txHash, finalizedAt, snapshotHash: campaignSnapshotHash(state), nowMs: finalizedAt,
  });
}

async function projectAssignment(
  context: ActionContext,
  state: GenLayerAssignmentState,
  campaign: GenLayerCampaignState,
  finalized: FinalizedMarketplaceTransaction,
  selectionTxHash: string,
) {
  return upsertGenLayerAssignmentProjection({
    contractAddress: marketplaceContractAddress(), assignmentId: state.assignmentId, campaignId: state.campaignId, localApplicationId: context.application.id, brandWallet: state.brand, creatorWallet: state.creator, contentSource: state.contentSource, creatorHandle: state.creatorHandle, creatorExternalUserId: state.creatorExternalUserId, creatorIdentityHash: state.creatorIdentityHash, applicationId: state.applicationId, agreedRateAtto: state.agreedRateAtto, agreementHash: state.agreementHash, status: state.status, selectedAtEpoch: state.selectedAtEpoch, acceptanceDeadlineEpoch: state.acceptanceDeadlineEpoch, acceptedAtEpoch: state.acceptedAtEpoch, postId: state.postId, submissionHash: state.submissionHash, resolutionRequestId: state.resolutionRequestId, resolutionAttempts: state.resolutionAttempts, resolutionEligibleAtEpoch: state.resolutionEligibleAtEpoch, lastResolutionAtEpoch: state.lastResolutionAtEpoch, evidenceHash: state.evidenceHash, outcome: state.outcome, reasoning: state.reasoning, resolutionChecks: state.resolutionChecks, resolutionRound: state.resolutionRound, maxUndeterminedRetries: campaign.maxUndeterminedRetries, creatorCreditAtto: state.creatorCreditAtto, brandCreditAtto: state.brandCreditAtto, feeAtto: state.feeAtto, submittedAtEpoch: state.submittedAtEpoch, settledAtEpoch: state.settledAtEpoch, closedAtEpoch: state.closedAtEpoch, selectionTxHash, lastTxHash: finalized.hash, finalizedAt: finalized.finalizedAt * 1_000, snapshotHash: canonicalHash(state), nowMs: finalized.finalizedAt * 1_000,
  });
}

async function projectClaimable(wallet: string, txHash: string, nowMs: number) {
  const state = parseClaimableState(await readMarketplaceState("get_claimable", [marketplaceCalldataAddress(wallet)]));
  await upsertGenLayerClaimableBalance({ contractAddress: marketplaceContractAddress(), wallet: state.account, amountAtto: state.claimableAtto, nextWithdrawalNonce: state.nextWithdrawalNonce, transactionHash: txHash, snapshotHash: canonicalHash(state), nowMs });
}

async function projectWithdrawal(
  state: GenLayerWithdrawalState,
  requestTxHash: string,
  lastTxHash: string,
  finalizedAt: number,
) {
  return upsertGenLayerWithdrawalProjection({
    contractAddress: marketplaceContractAddress(),
    withdrawalId: state.withdrawalId,
    account: state.account,
    nonce: state.nonce,
    amountAtto: state.amountAtto,
    status: state.status,
    requestedAtEpoch: state.requestedAtEpoch,
    emittedAtEpoch: state.emittedAtEpoch,
    reconciledAtEpoch: state.reconciledAtEpoch,
    evidenceHash: state.evidenceHash,
    recapitalizedAtto: state.recapitalizedAtto,
    requestTxHash,
    lastTxHash,
    finalizedAt,
    snapshotHash: canonicalHash(state),
    nowMs: finalizedAt,
  });
}

function assertApplicationBinding(state: GenLayerApplicationState, local: GenLayerPrivateApplication, campaignId: string, applicationId: string) {
  if (state.applicationId !== applicationId || state.campaignId !== campaignId || state.creator !== local.creatorWallet || state.requestedRateAtto !== local.requestedRateAtto || state.pitchCommitment !== local.pitchCommitment || state.status !== "APPLIED") stateMismatch();
}

function assertAssignmentBinding(state: GenLayerAssignmentState, context: ActionContext, assignmentId: string, agreementHash: string) {
  if (state.assignmentId !== assignmentId || state.campaignId !== context.campaign.campaignId || state.creator !== context.application.creatorWallet || state.contentSource !== context.draft.contentSource || state.applicationId !== deriveApplicationId(context.campaign.campaignId, context.application.creatorWallet) || state.agreementHash !== agreementHash || state.agreedRateAtto !== context.application.requestedRateAtto || state.status !== "SELECTED") stateMismatch();
}

async function requireActiveIdentityBundle(
  wallet: string,
  selectedSource: GenLayerContentSource,
) {
  const normalizedWallet = wallet.toLowerCase();
  const nowMs = Date.now();
  const identities = await Promise.all(
    IDENTITY_BUNDLE_SOURCES.map(async (source) => {
      const profile = await findGenLayerProfileByWallet(normalizedWallet, source);
      if (!profile?.active || profile.expiresAt <= nowMs) identityBundleRequired();
      let authoritativeProfile;
      try {
        authoritativeProfile = parseProfileState(await readMarketplaceState(
          "get_identity",
          [marketplaceCalldataAddress(normalizedWallet), source],
        ));
      } catch (error) {
        if (error instanceof Error && /does not exist|not active|expired/i.test(error.message)) {
          identityBundleRequired();
        }
        throw error;
      }
      if (
        !authoritativeProfile.active ||
        authoritativeProfile.expiresAtEpoch * 1_000 <= nowMs ||
        authoritativeProfile.wallet !== normalizedWallet ||
        authoritativeProfile.source !== source ||
        authoritativeProfile.identityHash !== profile.identityHash ||
        authoritativeProfile.externalUserId !== profile.externalUserId
      ) identityBundleMismatch();
      return { source, profile, authoritativeProfile };
    }),
  );
  const selected = identities.find(({ source }) => source === selectedSource);
  if (!selected) identityBundleMismatch();
  return selected;
}

function assertAssignmentIdentityBinding(
  profile: ReturnType<typeof parseProfileState>,
  assignment: GenLayerAssignmentProjection,
) {
  if (
    profile.identityHash !== assignment.creatorIdentityHash ||
    profile.externalUserId !== assignment.creatorExternalUserId
  ) identityBundleMismatch();
}

function identityBundleRequired(): never {
  throw problem(
    403,
    "CREATOR_IDENTITY_BUNDLE_REQUIRED",
    "Active X and Farcaster identities are required.",
  );
}

function identityBundleMismatch(): never {
  throw problem(
    409,
    "CREATOR_IDENTITY_STATE_MISMATCH",
    "Saved X and Farcaster identities do not match current GenLayer state.",
  );
}

function mutationResponse(draft: GenLayerCampaignDraft, campaign: GenLayerCampaignProjection, application: GenLayerPrivateApplication, assignment: GenLayerAssignmentProjection | null, prepared?: Awaited<ReturnType<typeof prepareGenLayerMarketplaceTransaction>>) {
  const dto = applicationDto(application, draft.contentSource, assignment);
  return {
    campaign: { id: draft.id, status: campaign.status.toLowerCase(), contentSource: draft.contentSource, genlayerCampaignId: campaign.campaignId },
    application: dto,
    ...(prepared ? preparedMutationFields(prepared) : {}),
  };
}

function preparedMutationFields(
  prepared: Awaited<ReturnType<typeof prepareGenLayerMarketplaceTransaction>>,
) {
  if (prepared.recovery) {
    return {
      preparedId: prepared.preparedId,
      recovery: {
        preparedId: prepared.recovery.preparedId,
        txHash: prepared.recovery.transactionHash,
      },
    };
  }
  return {
    preparedId: prepared.preparedId,
    transaction: prepared.call,
    recovery: null,
  };
}

function applicationDto(
  row: GenLayerPrivateApplication,
  contentSource: "X" | "FARCASTER",
  assignment: GenLayerAssignmentProjection | null,
) {
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
    status: (assignment?.status ?? row.status).toLowerCase(),
    selectedAt: assignment ? new Date(assignment.selectedAtEpoch * 1_000).toISOString() : null,
    acceptedAt: assignment?.acceptedAtEpoch ? new Date(assignment.acceptedAtEpoch * 1_000).toISOString() : null,
    genlayerAssignmentId: assignment?.assignmentId ?? null,
    agreementHash: assignment?.agreementHash ?? null,
    selectionTxHash: assignment?.selectionTxHash ?? null,
    acceptanceTxHash: assignment?.acceptedAtEpoch ? assignment.lastTxHash : null,
    contentId: assignment?.postId || null,
    submissionHash: assignment?.submissionHash ?? null,
    submissionTxHash: assignment?.submissionHash ? assignment.lastTxHash : null,
    submittedAt: assignment?.submittedAtEpoch ? new Date(assignment.submittedAtEpoch * 1_000).toISOString() : null,
    requestId: assignment?.resolutionRequestId ?? null,
    resolutionRound: assignment?.resolutionRound ?? 0,
    resolutionOutcome: assignment?.outcome?.toLowerCase() ?? null,
    resolutionEvidenceHash: assignment?.evidenceHash ?? null,
    resolutionTxHash: assignment?.outcome ? assignment.lastTxHash : null,
    resolutionChecks: assignment?.resolutionChecks ?? null,
    genlayerTxHash: assignment?.lastTxHash ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function callPlan(functionName: string, args: MarketplaceGenLayerCall["args"], argTypes: MarketplaceGenLayerCall["argTypes"]): MarketplaceGenLayerCall {
  return { network: MARKETPLACE_GENLAYER_NETWORK, chainId: MARKETPLACE_GENLAYER_CHAIN_ID, contractAddress: marketplaceContractAddress(), functionName, args, argTypes, value: "0" };
}

function storedCall(row: NonNullable<Awaited<ReturnType<typeof findGenLayerPreparedTransaction>>>): MarketplaceGenLayerCall {
  return { network: MARKETPLACE_GENLAYER_NETWORK, chainId: MARKETPLACE_GENLAYER_CHAIN_ID, contractAddress: row.contractAddress as `0x${string}`, functionName: row.functionName, args: row.args as never[], argTypes: row.argTypes, value: row.valueAtto };
}

async function requirePrepared(value: unknown) {
  const id = typeof value === "string" ? requireUuid(value, "preparedId") : "";
  const row = id ? await findGenLayerPreparedTransaction(id) : null;
  if (!row) preparedMismatch();
  return row;
}

function requireOpenCampaign(context: { projection: GenLayerCampaignProjection }) {
  if (context.projection.status !== "OPEN") invalidState();
}

function assertBrand(draft: GenLayerCampaignDraft, wallet: string) {
  if (draft.brandWallet !== wallet.toLowerCase()) forbidden();
}

function assertCreator(application: GenLayerPrivateApplication, wallet: string) {
  if (application.creatorWallet !== wallet.toLowerCase()) forbidden();
}

function positiveAtto(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,77}$/.test(value) || BigInt(value) >= 1n << 256n) throw problem(400, "INVALID_REQUEST", `${field} is invalid.`);
  return value;
}

function contentIdentifier(source: "X" | "FARCASTER", value: unknown): string {
  if (typeof value !== "string") throw problem(400, "CONTENT_ID_INVALID", "A content ID is required.");
  const normalized = value.trim().toLowerCase();
  if (source === "X") {
    if (/^\d{5,25}$/.test(normalized)) return normalized;
    const match = /^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d{5,25})(?:[/?#].*)?$/.exec(normalized);
    if (match) return match[1];
  } else if (/^0x[0-9a-f]{40}$/.test(normalized)) return normalized;
  throw problem(400, "CONTENT_ID_INVALID", `A canonical ${source} content ID is required.`);
}

function canonicalSubmissionHandle(source: "X" | "FARCASTER", value: unknown): string {
  if (typeof value !== "string") {
    throw problem(400, "CREATOR_HANDLE_INVALID", "expectedHandle is required.");
  }
  const normalized = value.trim().replace(/^@/, "").toLowerCase();
  const valid = source === "X"
    ? /^[a-z0-9_]{1,15}$/.test(normalized)
    : /^[a-z0-9][a-z0-9-]{0,15}$/.test(normalized);
  if (!valid) throw problem(400, "CREATOR_HANDLE_INVALID", "expectedHandle is invalid for the campaign source.");
  return normalized;
}

function withdrawalDto(state: GenLayerWithdrawalState) {
  return { withdrawalId: state.withdrawalId, account: state.account, nonce: state.nonce, amountAtto: state.amountAtto, status: state.status, requestedAt: new Date(state.requestedAtEpoch * 1_000).toISOString(), emittedAt: state.emittedAtEpoch ? new Date(state.emittedAtEpoch * 1_000).toISOString() : null, reconciledAt: state.reconciledAtEpoch ? new Date(state.reconciledAtEpoch * 1_000).toISOString() : null, evidenceHash: state.evidenceHash, recapitalizedAtto: state.recapitalizedAtto };
}

async function requiredWithdrawalReconciler() {
  try {
    return await requireWithdrawalReconcilerClient();
  } catch (error) {
    throw reconcilerProblem(error);
  }
}

async function pollWithdrawalReconciliation(
  withdrawalId: string,
): Promise<WithdrawalReconciliationProjection | Readonly<{
  status: "NOT_CONFIGURED" | "UNAVAILABLE";
  errorCode: string | null;
}> | null> {
  let config;
  try {
    config = await loadWithdrawalReconcilerConfig();
  } catch (error) {
    return Object.freeze({
      status: "UNAVAILABLE" as const,
      errorCode: error instanceof WithdrawalReconcilerClientProblem ? error.code : null,
    });
  }
  if (!config) return Object.freeze({ status: "NOT_CONFIGURED" as const, errorCode: null });
  try {
    return await createWithdrawalReconcilerClient(config).get(withdrawalId);
  } catch (error) {
    return Object.freeze({
      status: "UNAVAILABLE" as const,
      errorCode: error instanceof WithdrawalReconcilerClientProblem ? error.code : null,
    });
  }
}

function reconcilerProblem(error: unknown): ApiProblem {
  if (error instanceof WithdrawalReconcilerClientProblem) {
    return problem(503, error.code, error.message);
  }
  return problem(503, "WITHDRAWAL_RECONCILER_UNAVAILABLE", "Hosted GEN withdrawal reconciliation is unavailable.");
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw problem(400, "INVALID_REQUEST", `${field} is invalid.`);
  return value.toLowerCase();
}

function problem(status: number, code: string, message: string) { return new ApiProblem(status, code, message); }
function forbidden(): never { throw problem(403, "MARKETPLACE_ACTION_FORBIDDEN", "This wallet cannot perform the marketplace action."); }
function invalidState(): never { throw problem(409, "INVALID_MARKETPLACE_STATE", "The marketplace action is not available in the current contract state."); }
function preparedMismatch(): never { throw problem(409, "PREPARED_TRANSACTION_MISMATCH", "The prepared transaction does not match this action."); }
function stateMismatch(): never { throw problem(409, "GENLAYER_STATE_MISMATCH", "Finalized StudioNet state does not match the prepared marketplace action."); }
