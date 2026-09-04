import type { AuthenticatedWalletSession } from "./wallet-session.ts";
import { enqueueCampaignProgression } from "./campaign-progression-queue.ts";
import { marketplaceRecoveryOnly } from "./marketplace-api.ts";
import { assertOptionalActorWallet, requireText, requireUuid } from "./marketplace-core.ts";
import {
  campaignSnapshotHash,
  deriveApplicationId,
  deriveAssignmentId,
  deriveResolutionRequestId,
  deriveWithdrawalId,
  genLayerApplicationWithdrawalAvailability,
  genLayerAssignmentAcceptanceAvailability,
  genLayerAssignmentSubmissionAvailability,
  genLayerCampaignApplicationAvailability,
  genLayerCampaignCancellationAvailability,
  genLayerCampaignSelectionAvailability,
  genLayerResolutionAvailability,
  genLayerUndeterminedRefundAvailability,
  genLayerUndeterminedRefundEligibleAtEpoch,
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
  exactGenLayerJournalCall,
  ensureGenLayerSharedResolutionRepairMarker,
  findGenLayerAssignmentProjectionByAssignmentId,
  findGenLayerAssignmentProjectionByApplicationId,
  findGenLayerCampaignProjectionByOnchainId,
  findGenLayerCampaignDraft,
  findGenLayerCampaignProjectionByLocalId,
  findBoundGenLayerSubmissionTransaction,
  findGenLayerPreparedTransaction,
  findGenLayerWithdrawalProjectionById,
  findLatestGenLayerWithdrawalProjection,
  findGenLayerPrivateApplication,
  findGenLayerPrivateApplicationForCreator,
  findGenLayerProfileByWallet,
  insertGenLayerPrivateApplication,
  nextGenLayerSharedObservationTicket,
  prepareGenLayerMarketplaceTransaction,
  recoverPreparedMarketplaceTransactionBeforePreflight,
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
import { resolveFarcasterCastHashFromUrl } from "./marketplace-genlayer-activation.ts";
import {
  MARKETPLACE_GENLAYER_CHAIN_ID,
  MARKETPLACE_GENLAYER_NETWORK,
  MarketplaceGenLayerFinalityError,
  assertTransactionMatchesPreparedCall,
  canonicalHash,
  exactTerminalMarketplaceTransaction,
  loadFinalizedMarketplaceTransaction,
  marketplaceCalldataAddress,
  marketplaceContractAddress,
  readMarketplaceState,
  terminalMarketplaceTransactionStatus,
  type FinalizedMarketplaceTransaction,
  type MarketplaceGenLayerCall,
} from "./marketplace-genlayer-rpc.ts";
import { getGenLayerMarketplaceCampaignDetail } from "./marketplace-genlayer-service.ts";
import { observeGenLayerResolutionSharedState } from "./marketplace-genlayer-shared-observation.ts";
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
  assignment: Readonly<{
    status: string;
    assignmentId: string;
    resolutionRequestId: string | null;
    resolutionEligibleAtEpoch: number;
  }>;
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
  const recoveryOnly = marketplaceRecoveryOnly(input.body);
  assertExactJsonKeys(
    input.body,
    ["creatorWallet", "requestedRateGen", "pitch"],
    ["requestedRateGen", "pitch"],
  );
  assertOptionalActorWallet(input.body, "creatorWallet", input.session.wallet);
  const context = await campaignContext(input.campaignId);
  const creator = input.session.wallet.toLowerCase();
  const requestedRateAtto = positiveAtto(input.body.requestedRateGen, "requestedRateGen");
  if (BigInt(requestedRateAtto) > BigInt(context.projection.budgetAtto)) {
    throw problem(400, "APPLICATION_RATE_INVALID", "Requested GEN exceeds the campaign budget.");
  }
  const pitch = requireText(input.body.pitch, "pitch", 10, 2_000);
  const applicationId = deriveApplicationId(context.projection.campaignId, creator);
  const pitchCommitment = canonicalHash({
    protocol: "influencedx-private-pitch-v1",
    application_id: applicationId,
    pitch,
  });
  const preflightApplicationCampaign = async () => {
    const authoritativeCampaign = parseCampaignState(
      await readMarketplaceState("get_campaign", [context.projection.campaignId]),
    );
    assertOperatorCampaignBinding(context.projection, authoritativeCampaign);
    const applicationAvailability = genLayerCampaignApplicationAvailability(authoritativeCampaign);
    if (!applicationAvailability.canApply) {
      throw problem(409, "APPLICATION_CLOSED", "Campaign is not accepting applications.");
    }
  };
  let application = await findGenLayerPrivateApplicationForCreator(
    context.draft.id,
    creator,
  );
  let applicationWasCreated = false;
  if (!application) {
    await recoverPreparedMarketplaceTransactionBeforePreflight({
      row: null,
      recoveryOnly,
    });
    const { profile } = await requireActiveIdentityBundle(
      creator,
      context.draft.contentSource,
    );
    await preflightApplicationCampaign();
    application = await insertGenLayerPrivateApplication({
      localCampaignId: context.draft.id,
      creatorProfileProjectionId: profile.projectionId,
      creatorWallet: creator,
      requestedRateAtto,
      pitch,
      pitchCommitment,
    });
    if (application.creatorProfileProjectionId !== profile.projectionId) {
      identityBundleMismatch();
    }
    if (
      application.requestedRateAtto !== requestedRateAtto ||
      application.pitchCommitment !== pitchCommitment
    ) {
      throw problem(409, "APPLICATION_ALREADY_PREPARED", "A different application is already bound to this campaign.");
    }
    applicationWasCreated = true;
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
    recoveryOnly,
    beforeInsert: applicationWasCreated
      ? undefined
      : async () => {
        const { profile } = await requireActiveIdentityBundle(
          creator,
          context.draft.contentSource,
        );
        if (profile.projectionId !== application.creatorProfileProjectionId) {
          identityBundleMismatch();
        }
        await preflightApplicationCampaign();
      },
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
  const applicationId = deriveApplicationId(
    context.campaign.campaignId,
    context.application.creatorWallet,
  );
  const agreedRateAtto = context.application.requestedRateAtto;
  const preflightSelection = async () => {
    const { profile } = await requireActiveIdentityBundle(
      context.application.creatorWallet,
      context.draft.contentSource,
    );
    if (profile.projectionId !== context.application.creatorProfileProjectionId) {
      identityBundleMismatch();
    }
    const [authoritativeCampaign, authoritativeApplication] = await Promise.all([
      readMarketplaceState("get_campaign", [context.campaign.campaignId]).then(parseCampaignState),
      readMarketplaceState("get_application", [
        context.campaign.campaignId,
        marketplaceCalldataAddress(context.application.creatorWallet),
      ]).then(parseApplicationState),
    ]);
    assertOperatorCampaignBinding(context.campaign, authoritativeCampaign);
    assertPreparationApplicationBinding(authoritativeApplication, context, applicationId);
    const selectionAvailability = genLayerCampaignSelectionAvailability(authoritativeCampaign);
    if (!selectionAvailability.canSelect) {
      throw problem(409, "SELECTION_CLOSED", "Campaign selection is closed.");
    }
    if (
      BigInt(agreedRateAtto) <= 0n ||
      BigInt(agreedRateAtto) > BigInt(authoritativeApplication.requestedRateAtto)
    ) invalidState();
    if (BigInt(agreedRateAtto) > BigInt(authoritativeCampaign.availableAtto)) {
      throw problem(409, "CAMPAIGN_BUDGET", "Campaign has insufficient unallocated budget.");
    }
    assertApplicationIdentityBinding(authoritativeApplication, profile);
  };
  const agreementHash = canonicalHash({
    protocol: "influencedx-assignment-agreement-v2",
    campaign_id: context.campaign.campaignId,
    application_id: applicationId,
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
  const prepared = await prepareAction(
    "SELECT_CREATOR",
    call,
    context,
    input.session.wallet,
    assignmentId,
    preflightSelection,
    marketplaceRecoveryOnly(input.body),
  );
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
  const observationTicket = await nextGenLayerSharedObservationTicket();
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
  await projectCampaign(context.draft, context.campaign, campaign, finalized.hash, finalized.finalizedAt * 1_000, observationTicket);
  await finalizePrepared(input, finalized, canonicalHash({ assignment, campaign }));
  return mutationResponse(context.draft, context.campaign, context.application, projected);
}

export async function prepareGenLayerAccept(input: ActionInput) {
  assertExactJsonKeys(input.body, []);
  const context = await applicationContext(input);
  if (!context.assignment) invalidState();
  const projectedAssignment = context.assignment;
  assertCreator(context.application, input.session.wallet);
  const preflightAcceptance = async () => {
    const identity = await requireActiveIdentityBundle(
      context.application.creatorWallet,
      context.draft.contentSource,
    );
    const [authoritativeAssignment, authoritativeCampaign] = await Promise.all([
      readMarketplaceState("get_assignment", [projectedAssignment.assignmentId])
        .then(parseAssignmentState),
      readMarketplaceState("get_campaign", [context.campaign.campaignId])
        .then(parseCampaignState),
    ]);
    assertOperatorCampaignBinding(context.campaign, authoritativeCampaign);
    assertOperatorAssignmentBinding(projectedAssignment, authoritativeAssignment, authoritativeCampaign);
    assertPreparationAssignmentBinding(projectedAssignment, authoritativeAssignment);
    const acceptanceAvailability = genLayerAssignmentAcceptanceAvailability(authoritativeAssignment);
    if (acceptanceAvailability.reason === "EXPIRED") {
      throw problem(409, "ACCEPTANCE_EXPIRED", "Assignment acceptance deadline has passed.");
    }
    if (!acceptanceAvailability.canAccept) invalidState();
    assertAssignmentIdentityBinding(identity.authoritativeProfile, authoritativeAssignment);
  };
  const call = callPlan(
    "accept_assignment",
    [projectedAssignment.assignmentId],
    ["string"],
  );
  const prepared = await prepareAction(
    "ACCEPT_ASSIGNMENT",
    call,
    context,
    input.session.wallet,
    projectedAssignment.assignmentId,
    preflightAcceptance,
    marketplaceRecoveryOnly(input.body),
  );
  return mutationResponse(
    context.draft,
    context.campaign,
    context.application,
    context.assignment,
    prepared,
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
  const applicationId = deriveApplicationId(
    context.campaign.campaignId,
    context.application.creatorWallet,
  );
  const preflightWithdrawal = async () => {
    const [authoritativeCampaign, authoritativeApplication] = await Promise.all([
      readMarketplaceState("get_campaign", [context.campaign.campaignId]).then(parseCampaignState),
      readMarketplaceState("get_application", [
        context.campaign.campaignId,
        marketplaceCalldataAddress(context.application.creatorWallet),
      ]).then(parseApplicationState),
    ]);
    assertOperatorCampaignBinding(context.campaign, authoritativeCampaign);
    assertPreparationApplicationBinding(authoritativeApplication, context, applicationId);
    const withdrawalAvailability = genLayerApplicationWithdrawalAvailability(
      authoritativeApplication,
      authoritativeCampaign,
    );
    if (withdrawalAvailability.reason === "CLOSED") {
      throw problem(409, "APPLICATION_LOCKED", "Application withdrawal is closed.");
    }
    if (!withdrawalAvailability.canWithdraw) invalidState();
  };
  const call = callPlan("withdraw_application", [context.campaign.campaignId], ["string"]);
  const prepared = await prepareAction(
    "WITHDRAW_APPLICATION",
    call,
    context,
    input.session.wallet,
    applicationId,
    preflightWithdrawal,
    marketplaceRecoveryOnly(input.body),
  );
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
  if (!context.assignment) invalidState();
  const projectedAssignment = context.assignment;
  const findBoundSubmission = () => findBoundGenLayerSubmissionTransaction({
    localCampaignId: context.draft.id,
    localApplicationId: context.application.id,
    assignmentId: projectedAssignment.assignmentId,
    actorWallet: input.session.wallet,
  });
  const earlyRecovery = await recoverPreparedMarketplaceTransactionBeforePreflight({
    row: await findBoundSubmission(),
    recoveryOnly: marketplaceRecoveryOnly(input.body),
  });
  if (earlyRecovery) {
    return mutationResponse(
      context.draft,
      context.campaign,
      context.application,
      context.assignment,
      earlyRecovery,
    );
  }
  const source = normalizeContentSource(input.body.contentSource);
  if (source !== context.draft.contentSource) throw problem(400, "CONTENT_SOURCE_MISMATCH", "Submission source does not match the campaign.");
  const expectedHandle = canonicalSubmissionHandle(source, input.body.expectedHandle);
  if (expectedHandle !== projectedAssignment.creatorHandle) {
    throw problem(409, "CREATOR_HANDLE_MISMATCH", "expectedHandle does not match the selected creator identity.");
  }
  let call: MarketplaceGenLayerCall;
  try {
    const submissionIdentity = source === "FARCASTER"
      ? await requireActiveIdentityBundle(
          context.application.creatorWallet,
          context.draft.contentSource,
        )
      : null;
    if (submissionIdentity) {
      assertAssignmentIdentityBinding(
        submissionIdentity.authoritativeProfile,
        projectedAssignment,
      );
    }
    call = (await buildGenLayerSubmissionCall({
      assignmentId: projectedAssignment.assignmentId,
      agreementHash: projectedAssignment.agreementHash,
      creatorIdentityHash: projectedAssignment.creatorIdentityHash,
      contentSource: source,
      submittedContent: input.body.contentId,
      expectedUsername: submissionIdentity?.authoritativeProfile.handle
        ?? projectedAssignment.creatorHandle,
      expectedExternalUserId: submissionIdentity?.authoritativeProfile.externalUserId
        ?? projectedAssignment.creatorExternalUserId,
    })).call;
  } catch (error) {
    const racedRecovery = await recoverPreparedMarketplaceTransactionBeforePreflight({
      row: await findBoundSubmission(),
    });
    if (racedRecovery) {
      return mutationResponse(
        context.draft,
        context.campaign,
        context.application,
        context.assignment,
        racedRecovery,
      );
    }
    throw error;
  }
  const preflightSubmission = async () => {
    const currentIdentity = await requireActiveIdentityBundle(
      context.application.creatorWallet,
      context.draft.contentSource,
    );
    const [authoritativeAssignment, authoritativeCampaign] = await Promise.all([
      readMarketplaceState("get_assignment", [projectedAssignment.assignmentId])
        .then(parseAssignmentState),
      readMarketplaceState("get_campaign", [context.campaign.campaignId])
        .then(parseCampaignState),
    ]);
    assertOperatorCampaignBinding(context.campaign, authoritativeCampaign);
    assertOperatorAssignmentBinding(projectedAssignment, authoritativeAssignment, authoritativeCampaign);
    assertPreparationAssignmentBinding(projectedAssignment, authoritativeAssignment);
    const submissionAvailability = genLayerAssignmentSubmissionAvailability(
      authoritativeAssignment,
      authoritativeCampaign,
    );
    if (submissionAvailability.reason === "EXPIRED") {
      throw problem(409, "SUBMISSION_EXPIRED", "Submission deadline has passed.");
    }
    if (!submissionAvailability.canSubmit) invalidState();
    assertAssignmentIdentityBinding(
      currentIdentity.authoritativeProfile,
      authoritativeAssignment,
    );
    if (expectedHandle !== authoritativeAssignment.creatorHandle) {
      throw problem(409, "CREATOR_HANDLE_MISMATCH", "expectedHandle does not match the selected creator identity.");
    }
  };
  let prepared;
  try {
    prepared = await prepareAction(
      "SUBMIT_EVIDENCE",
      call,
      context,
      input.session.wallet,
      projectedAssignment.assignmentId,
      preflightSubmission,
      marketplaceRecoveryOnly(input.body),
    );
  } catch (error) {
    const racedRecovery = await recoverPreparedMarketplaceTransactionBeforePreflight({
      row: await findBoundSubmission(),
    });
    if (!racedRecovery) throw error;
    prepared = racedRecovery;
  }
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
  const projected = await projectAssignment(
    context,
    assignment,
    campaign,
    finalized,
    context.assignment.selectionTxHash,
    { expectedPreviousSnapshotHash: context.assignment.snapshotHash },
  );
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
  const projectedAssignment = context.assignment;
  if (![context.draft.brandWallet, context.application.creatorWallet].includes(input.session.wallet.toLowerCase())) forbidden();
  const preflightResolution = async () => {
    const [authoritativeAssignment, authoritativeCampaign] = await Promise.all([
      readMarketplaceState("get_assignment", [projectedAssignment.assignmentId])
        .then(parseAssignmentState),
      readMarketplaceState("get_campaign", [context.campaign.campaignId])
        .then(parseCampaignState),
    ]);
    assertOperatorCampaignBinding(context.campaign, authoritativeCampaign);
    assertOperatorAssignmentBinding(
      projectedAssignment,
      authoritativeAssignment,
      authoritativeCampaign,
    );
    assertResolutionPreparationBinding(projectedAssignment, authoritativeAssignment);
    const availability = genLayerResolutionAvailability(
      authoritativeAssignment,
      authoritativeCampaign,
    );
    if (availability.reason === "EARLY") {
      throw problem(409, "RETENTION", `Resolution unlocks ${availability.unlocksAt}.`);
    }
    if (availability.reason === "RETRIES_EXHAUSTED") {
      throw problem(409, "RETRIES_EXHAUSTED", "Resolution retries are exhausted. Use refund instead.");
    }
    if (!availability.canResolve || !authoritativeAssignment.resolutionRequestId) invalidState();
  };
  const call = callPlan(
    "resolve_assignment",
    [projectedAssignment.assignmentId, projectedAssignment.resolutionRequestId],
    ["string", "string"],
  );
  const prepared = await prepareAction(
    "RESOLVE_ASSIGNMENT",
    call,
    context,
    input.session.wallet,
    projectedAssignment.assignmentId,
    preflightResolution,
    marketplaceRecoveryOnly(input.body),
  );
  return mutationResponse(context.draft, context.campaign, context.application, context.assignment, prepared);
}

export async function confirmGenLayerResolution(input: ActionInput) {
  const context = await applicationContext(input);
  if (!context.assignment) invalidState();
  if (![context.draft.brandWallet, context.application.creatorWallet].includes(input.session.wallet.toLowerCase())) forbidden();
  const prepared = await requirePrepared(input.body.preparedId);
  if (
    prepared.operation !== "RESOLVE_ASSIGNMENT" ||
    prepared.localCampaignId !== context.draft.id ||
    prepared.localApplicationId !== context.application.id
  ) preparedMismatch();
  let call: MarketplaceGenLayerCall;
  try {
    call = exactGenLayerJournalCall(prepared);
  } catch {
    preparedMismatch();
  }
  if (
    call.functionName !== "resolve_assignment" ||
    call.value !== "0" ||
    call.args.length !== 2 ||
    call.argTypes.length !== 2 ||
    call.argTypes[0] !== "string" ||
    call.argTypes[1] !== "string" ||
    call.args[0] !== context.assignment.assignmentId
  ) preparedMismatch();
  const preparedRequestId = requireHash(call.args[1], "requestId");
  const finalized = await confirmPrepared(
    input.body,
    prepared,
    call,
    input.session.wallet,
    input.reconciliationFenceToken,
  );
  if (resolutionReceiptAlreadyProjected(context.assignment, finalized)) {
    let projected = context.assignment;
    if (resolutionRequiresSharedObservation(projected)) {
      const rebound = await ensureGenLayerSharedResolutionRepairMarker({
        projectionId: projected.projectionId,
        anchorTransactionHash: finalized.hash,
        snapshotHash: projected.snapshotHash,
      });
      if (!rebound) stateMismatch();
      projected = rebound;
    }
    await finalizePrepared(input, finalized, projected.snapshotHash);
    const retry = nextGenLayerResolutionProgression({
      assignment: projected,
      previousRequestId: preparedRequestId,
      finalizedAtEpoch: finalized.finalizedAt,
    });
    if (retry) await enqueueCampaignProgression(retry);
    if (resolutionRequiresSharedObservation(projected)) {
      await repairSharedObservationBestEffort(projected, finalized);
    }
    return mutationResponse(
      context.draft,
      context.campaign,
      context.application,
      projected,
    );
  }
  const assignment = parseAssignmentState(await readMarketplaceState("get_assignment", [context.assignment.assignmentId]));
  const campaign = parseCampaignState(await readMarketplaceState("get_campaign", [context.campaign.campaignId]));
  assertOperatorAssignmentBinding(context.assignment, assignment, campaign);
  assertOperatorCampaignBinding(context.campaign, campaign);
  deferPendingResolution(context.assignment, assignment, preparedRequestId);
  const assignmentSnapshotHash = canonicalHash(assignment);
  if (
    context.assignment.resolutionRequestId !== preparedRequestId ||
    !genLayerResolutionAssignmentPostcondition(
      context.assignment,
      assignment,
      context.campaign.feeBps,
    )
  ) stateMismatch();
  const projected = await projectAssignment(
    context,
    assignment,
    campaign,
    finalized,
    context.assignment.selectionTxHash,
    {
      sharedProjectionPending: resolutionRequiresSharedObservation(assignment),
      expectedPreviousSnapshotHash: context.assignment.snapshotHash,
    },
  );
  await finalizePrepared(input, finalized, assignmentSnapshotHash);
  const retry = nextGenLayerResolutionProgression({
    assignment,
    previousRequestId: preparedRequestId,
    finalizedAtEpoch: finalized.finalizedAt,
  });
  if (retry) await enqueueCampaignProgression(retry);
  if (resolutionRequiresSharedObservation(projected)) {
    await repairSharedObservationBestEffort(projected, finalized);
  }
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
  const requestId = requireHash(input.requestId, "requestId");
  if (!existing) {
    throw problem(409, "GENLAYER_OPERATOR_BINDING_MISMATCH", "The operator result is not bound to a projected assignment.");
  }
  const application = await findGenLayerPrivateApplication(existing.localApplicationId);
  if (!application) stateMismatch();
  const context = await applicationContext({
    campaignId: application.localCampaignId,
    applicationId: application.id,
  });
  const finalized = await loadExactOperatorFinalizedTransaction({
    transactionHash: input.transactionHash,
    finalizedAtMs: input.finalizedAtMs,
    functionName: "resolve_assignment",
    args: [existing.assignmentId, requestId],
  });
  if (resolutionReceiptAlreadyProjected(existing, finalized)) {
    let projected = existing;
    if (resolutionRequiresSharedObservation(projected)) {
      const rebound = await ensureGenLayerSharedResolutionRepairMarker({
        projectionId: projected.projectionId,
        anchorTransactionHash: finalized.hash,
        snapshotHash: projected.snapshotHash,
      });
      if (!rebound) stateMismatch();
      projected = rebound;
    }
    await updateGenLayerProjectionCursor({
      contractAddress: marketplaceContractAddress(),
      transactionHash: finalized.hash,
      finalizedAt: finalized.finalizedAt * 1_000,
      snapshotHash: projected.snapshotHash,
    });
    const retry = nextGenLayerResolutionProgression({
      assignment: projected,
      previousRequestId: requestId,
      finalizedAtEpoch: finalized.finalizedAt,
    });
    if (retry) await enqueueCampaignProgression(retry);
    if (resolutionRequiresSharedObservation(projected)) {
      await repairSharedObservationBestEffort(projected, finalized);
    }
    return Object.freeze({ assignment: projected, campaign: context.campaign });
  }
  if (existing.resolutionRequestId !== requestId) {
    throw problem(409, "GENLAYER_OPERATOR_BINDING_MISMATCH", "The operator result is not bound to the current projected resolution request.");
  }
  const [rawAssignment, rawCampaign] = await Promise.all([
    readMarketplaceState("get_assignment", [existing.assignmentId]),
    readMarketplaceState("get_campaign", [existing.campaignId]),
  ]);
  const assignment = parseAssignmentState(rawAssignment);
  const campaign = parseCampaignState(rawCampaign);
  if (
    assignment.assignmentId !== existing.assignmentId ||
    assignment.campaignId !== existing.campaignId ||
    campaign.campaignId !== existing.campaignId
  ) stateMismatch();
  assertOperatorAssignmentBinding(existing, assignment, campaign);
  assertOperatorCampaignBinding(context.campaign, campaign);
  deferPendingResolution(existing, assignment, requestId);
  const finalizedAtMs = finalized.finalizedAt * 1_000;
  const assignmentSnapshotHash = canonicalHash(assignment);
  if (!genLayerResolutionAssignmentPostcondition(
    existing,
    assignment,
    context.campaign.feeBps,
  )) stateMismatch();
  const projected = await projectAssignment(
    context,
    assignment,
    campaign,
    finalized,
    existing.selectionTxHash,
    {
      sharedProjectionPending: resolutionRequiresSharedObservation(assignment),
      expectedPreviousSnapshotHash: existing.snapshotHash,
    },
  );
  await updateGenLayerProjectionCursor({
    contractAddress: marketplaceContractAddress(),
    transactionHash: finalized.hash,
    finalizedAt: finalizedAtMs,
    snapshotHash: assignmentSnapshotHash,
  });
  const retry = nextGenLayerResolutionProgression({
    assignment,
    previousRequestId: requestId,
    finalizedAtEpoch: finalized.finalizedAt,
  });
  if (retry) await enqueueCampaignProgression(retry);
  if (resolutionRequiresSharedObservation(projected)) {
    await repairSharedObservationBestEffort(projected, finalized);
  }
  return Object.freeze({ assignment: projected, campaign });
}

export function genLayerResolutionAssignmentPostcondition(
  previous: GenLayerAssignmentProjection,
  assignment: GenLayerAssignmentState,
  feeBps: number,
): boolean {
  if (
    assignment.postId !== previous.postId ||
    assignment.submissionHash !== previous.submissionHash ||
    assignment.submittedAtEpoch !== previous.submittedAtEpoch ||
    assignment.resolutionAttempts !== previous.resolutionAttempts + 1 ||
    assignment.lastResolutionAtEpoch <= previous.lastResolutionAtEpoch ||
    !assignment.evidenceHash ||
    !assignment.outcome
  ) return false;

  if (assignment.status === "UNDETERMINED") {
    if (!previous.submissionHash || !previous.postId) return false;
    const expectedRequestId = deriveResolutionRequestId({
      assignmentId: previous.assignmentId,
      agreementHash: previous.agreementHash,
      submissionHash: previous.submissionHash,
      contentSource: previous.contentSource,
      postId: previous.postId,
      roundIndex: previous.resolutionRound + 1,
    });
    return assignment.outcome === "UNDETERMINED"
      && assignment.resolutionRound === previous.resolutionRound + 1
      && assignment.resolutionRequestId === expectedRequestId
      && assignment.resolutionEligibleAtEpoch > assignment.lastResolutionAtEpoch
      && assignment.creatorCreditAtto === previous.creatorCreditAtto
      && assignment.brandCreditAtto === previous.brandCreditAtto
      && assignment.feeAtto === previous.feeAtto
      && assignment.settledAtEpoch === previous.settledAtEpoch
      && assignment.closedAtEpoch === previous.closedAtEpoch;
  }

  if (assignment.resolutionRound !== previous.resolutionRound
    || assignment.resolutionRequestId !== previous.resolutionRequestId
    || assignment.resolutionEligibleAtEpoch !== previous.resolutionEligibleAtEpoch
    || assignment.settledAtEpoch <= 0
    || assignment.closedAtEpoch !== previous.closedAtEpoch) return false;
  const amount = BigInt(previous.agreedRateAtto);

  if (assignment.status === "SETTLED_PASS" && assignment.outcome === "PASS") {
    const fee = amount * BigInt(feeBps) / 10_000n;
    const creatorCredit = amount - fee;
    return assignment.creatorCreditAtto === creatorCredit.toString()
      && assignment.brandCreditAtto === "0"
      && assignment.feeAtto === fee.toString();
  }
  if (assignment.status === "SETTLED_FAIL" && assignment.outcome === "FAIL") {
    return assignment.creatorCreditAtto === "0"
      && assignment.brandCreditAtto === amount.toString()
      && assignment.feeAtto === "0";
  }
  return false;
}

export function genLayerResolutionPendingPostcondition(
  previous: GenLayerAssignmentProjection,
  assignment: GenLayerAssignmentState,
): boolean {
  return assignment.status === "RESOLVING"
    && assignment.resolutionPending === true
    && assignment.resolutionPendingRequestId === previous.resolutionRequestId
    && assignment.resolutionPendingRound === previous.resolutionRound
    && assignment.resolutionPendingStartedAtEpoch === assignment.lastResolutionAtEpoch
    && assignment.postId === previous.postId
    && assignment.submissionHash === previous.submissionHash
    && assignment.submittedAtEpoch === previous.submittedAtEpoch
    && assignment.resolutionAttempts === previous.resolutionAttempts + 1
    && assignment.lastResolutionAtEpoch > previous.lastResolutionAtEpoch
    && assignment.resolutionRequestId === previous.resolutionRequestId
    && assignment.resolutionRound === previous.resolutionRound
    && assignment.resolutionEligibleAtEpoch === previous.resolutionEligibleAtEpoch
    && assignment.outcome === previous.outcome
    && assignment.evidenceHash === previous.evidenceHash
    && assignment.reasoning === previous.reasoning
    && canonicalHash(assignment.resolutionChecks) === canonicalHash(previous.resolutionChecks)
    && assignment.creatorCreditAtto === previous.creatorCreditAtto
    && assignment.brandCreditAtto === previous.brandCreditAtto
    && assignment.feeAtto === previous.feeAtto
    && assignment.settledAtEpoch === previous.settledAtEpoch
    && assignment.closedAtEpoch === previous.closedAtEpoch;
}

function deferPendingResolution(
  previous: GenLayerAssignmentProjection,
  assignment: GenLayerAssignmentState,
  requestId: string,
): void {
  if (assignment.status !== "RESOLVING") return;
  if (
    previous.resolutionRequestId !== requestId ||
    !genLayerResolutionPendingPostcondition(previous, assignment)
  ) stateMismatch();
  throw problem(
    202,
    "GENLAYER_RESOLUTION_CHILD_PENDING",
    "The bounded resolution child transactions are still finalizing.",
  );
}

export function genLayerResolutionCampaignPostcondition(
  previousAssignment: GenLayerAssignmentProjection,
  assignment: GenLayerAssignmentState,
  previous: GenLayerCampaignProjection,
  campaign: GenLayerCampaignState,
): boolean {
  if (
    campaign.status !== previous.status ||
    campaign.availableAtto !== previous.availableAtto ||
    campaign.applicationCount !== previous.applicationCount ||
    campaign.assignmentCount !== previous.assignmentCount ||
    campaign.closedAtEpoch !== previous.closedAtEpoch
  ) return false;
  if (assignment.status === "UNDETERMINED") {
    return campaign.reservedAtto === previous.reservedAtto
      && campaign.settledAtto === previous.settledAtto
      && campaign.creatorPaidAtto === previous.creatorPaidAtto
      && campaign.brandRefundedAtto === previous.brandRefundedAtto
      && campaign.feeAtto === previous.feeAtto;
  }

  const amount = BigInt(previousAssignment.agreedRateAtto);
  const reservedBefore = BigInt(previous.reservedAtto);
  if (
    reservedBefore < amount ||
    BigInt(campaign.reservedAtto) !== reservedBefore - amount ||
    BigInt(campaign.settledAtto) !== BigInt(previous.settledAtto) + amount
  ) return false;
  if (assignment.status === "SETTLED_PASS") {
    const fee = amount * BigInt(previous.feeBps) / 10_000n;
    const creatorCredit = amount - fee;
    return BigInt(campaign.creatorPaidAtto) === BigInt(previous.creatorPaidAtto) + creatorCredit
      && campaign.brandRefundedAtto === previous.brandRefundedAtto
      && BigInt(campaign.feeAtto) === BigInt(previous.feeAtto) + fee;
  }
  if (assignment.status === "SETTLED_FAIL") {
    return campaign.creatorPaidAtto === previous.creatorPaidAtto
      && BigInt(campaign.brandRefundedAtto) === BigInt(previous.brandRefundedAtto) + amount
      && campaign.feeAtto === previous.feeAtto;
  }
  return false;
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
  const finalized = await loadExactOperatorFinalizedTransaction({
    transactionHash: input.transactionHash,
    finalizedAtMs: input.finalizedAtMs,
    functionName: "expire_assignment",
    args: [existing.assignmentId],
  });
  const observationTicket = await nextGenLayerSharedObservationTicket();
  const [assignment, campaign] = await Promise.all([
    readMarketplaceState("get_assignment", [existing.assignmentId]).then(parseAssignmentState),
    readMarketplaceState("get_campaign", [existing.campaignId]).then(parseCampaignState),
  ]);
  assertOperatorAssignmentBinding(existing, assignment, campaign);
  if (!["EXPIRED", "SETTLED_FAIL"].includes(assignment.status)) stateMismatch();
  const finalizedAtMs = finalized.finalizedAt * 1_000;
  await Promise.all([
    projectCampaign(context.draft, context.campaign, campaign, finalized.hash, finalizedAtMs, observationTicket),
    projectClaimable(context.draft.brandWallet, finalized.hash, finalizedAtMs, observationTicket),
    projectClaimable(context.application.creatorWallet, finalized.hash, finalizedAtMs, observationTicket),
    updateGenLayerProjectionCursor({
      contractAddress: marketplaceContractAddress(),
      transactionHash: finalized.hash,
      finalizedAt: finalizedAtMs,
      snapshotHash: canonicalHash({ assignment, campaign }),
    }),
  ]);
  // Assignment status is the due-scan commit marker. Keep it nonterminal until
  // every shared projection succeeds so a crash is repaired by the next replay.
  const projected = await projectAssignment(
    context,
    assignment,
    campaign,
    finalized,
    existing.selectionTxHash,
    { expectedPreviousSnapshotHash: existing.snapshotHash },
  );
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
  const finalized = await loadExactOperatorFinalizedTransaction({
    transactionHash: input.transactionHash,
    finalizedAtMs: input.finalizedAtMs,
    functionName: "finalize_campaign",
    args: [existing.campaignId],
  });
  const observationTicket = await nextGenLayerSharedObservationTicket();
  const campaign = await readMarketplaceState(
    "get_campaign",
    [existing.campaignId],
  ).then(parseCampaignState);
  assertOperatorCampaignBinding(existing, campaign);
  if (campaign.status !== "CLOSED" || campaign.reservedAtto !== "0" || campaign.availableAtto !== "0") {
    stateMismatch();
  }
  const finalizedAtMs = finalized.finalizedAt * 1_000;
  await Promise.all([
    setGenLayerCampaignDraftStatus({
      id: context.draft.id,
      expectedStatus: context.draft.status,
      status: "CLOSED",
      nowMs: finalizedAtMs,
    }),
    projectClaimable(context.draft.brandWallet, finalized.hash, finalizedAtMs, observationTicket),
    updateGenLayerProjectionCursor({
      contractAddress: marketplaceContractAddress(),
      transactionHash: finalized.hash,
      finalizedAt: finalizedAtMs,
      snapshotHash: canonicalHash(campaign),
    }),
  ]);
  // Campaign status is the due-scan commit marker. Writing CLOSED last makes
  // every earlier partial failure replayable from the durable OPEN projection.
  const projected = await projectCampaign(
    context.draft,
    context.projection,
    campaign,
    finalized.hash,
    finalizedAtMs,
    observationTicket,
  );
  return Object.freeze({ campaign: projected });
}

export async function prepareGenLayerRefundUndetermined(input: ActionInput) {
  assertExactJsonKeys(input.body, []);
  const context = await applicationContext(input);
  if (!context.assignment) invalidState();
  const projectedAssignment = context.assignment;
  if (![context.draft.brandWallet, context.application.creatorWallet].includes(
    input.session.wallet.toLowerCase(),
  )) forbidden();
  const preflightRefundUndetermined = async () => {
    const [authoritativeAssignment, authoritativeCampaign] = await Promise.all([
      readMarketplaceState("get_assignment", [projectedAssignment.assignmentId])
        .then(parseAssignmentState),
      readMarketplaceState("get_campaign", [context.campaign.campaignId])
        .then(parseCampaignState),
    ]);
    assertOperatorCampaignBinding(context.campaign, authoritativeCampaign);
    assertOperatorAssignmentBinding(
      projectedAssignment,
      authoritativeAssignment,
      authoritativeCampaign,
    );
    assertPreparationAssignmentBinding(projectedAssignment, authoritativeAssignment);
    assertResolutionPreparationBinding(projectedAssignment, authoritativeAssignment);
    const refundAvailability = genLayerUndeterminedRefundAvailability(
      authoritativeAssignment,
      authoritativeCampaign,
    );
    if (refundAvailability.reason === "RETRIES_REMAIN") {
      throw problem(409, "RETRIES_REMAIN", "Configured resolution retries remain.");
    }
    if (refundAvailability.reason === "EARLY") {
      throw problem(409, "REFUND_DELAY", `Refund unlocks ${refundAvailability.unlocksAt}.`);
    }
    if (!refundAvailability.canRefund) invalidState();
  };
  const call = callPlan(
    "refund_undetermined",
    [projectedAssignment.assignmentId],
    ["string"],
  );
  const prepared = await prepareAction(
    "REFUND_UNDETERMINED",
    call,
    context,
    input.session.wallet,
    projectedAssignment.assignmentId,
    preflightRefundUndetermined,
    marketplaceRecoveryOnly(input.body),
  );
  return mutationResponse(
    context.draft,
    context.campaign,
    context.application,
    context.assignment,
    prepared,
  );
}

export async function confirmGenLayerRefundUndetermined(input: ActionInput) {
  return confirmAssignmentSimple(input, "REFUND_UNDETERMINED", "refund_undetermined", "REFUNDED", "participant");
}

export async function prepareGenLayerCampaignCancel(input: CampaignActionInput) {
  assertExactJsonKeys(input.body, []);
  const context = await campaignContext(input.campaignId);
  assertBrand(context.draft, input.session.wallet);
  const preflightCancellation = async () => {
    const authoritativeCampaign = parseCampaignState(
      await readMarketplaceState("get_campaign", [context.projection.campaignId]),
    );
    assertOperatorCampaignBinding(context.projection, authoritativeCampaign);
    const availability = genLayerCampaignCancellationAvailability(authoritativeCampaign);
    if (availability.reason === "LATE") {
      throw problem(409, "CANCEL_TOO_LATE", "Cancellation closed when applications closed.");
    }
    if (availability.reason === "RESERVED") {
      throw problem(409, "CAMPAIGN_RESERVED", "Active assignments must be settled first.");
    }
    if (!availability.canCancel) invalidState();
  };
  const call = callPlan(
    "cancel_campaign",
    [context.projection.campaignId],
    ["string"],
  );
  const prepared = await prepareGenLayerMarketplaceTransaction({
    operation: "CANCEL_CAMPAIGN",
    call,
    actorWallet: input.session.wallet,
    localCampaignId: context.draft.id,
    onchainEntityId: context.projection.campaignId,
    recoveryOnly: marketplaceRecoveryOnly(input.body),
    beforeInsert: preflightCancellation,
  });
  return {
    campaign: (await getGenLayerMarketplaceCampaignDetail({
      campaignId: context.draft.id,
      viewerWallet: input.session.wallet,
    })).campaign,
    ...preparedMutationFields(prepared),
  };
}

export async function confirmGenLayerCampaignCancel(input: CampaignActionInput) {
  return confirmCampaignSimple(input, "CANCEL_CAMPAIGN", "cancel_campaign");
}

export async function prepareGenLayerRefundUnallocated(input: CampaignActionInput) {
  assertExactJsonKeys(input.body, []);
  const context = await campaignContext(input.campaignId);
  assertBrand(context.draft, input.session.wallet);
  const preflightRefundUnallocated = async () => {
    const authoritativeCampaign = parseCampaignState(
      await readMarketplaceState("get_campaign", [context.projection.campaignId]),
    );
    assertOperatorCampaignBinding(context.projection, authoritativeCampaign);
    const availability = genLayerUnallocatedRefundAvailability(authoritativeCampaign);
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
  };
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
    recoveryOnly: marketplaceRecoveryOnly(input.body),
    beforeInsert: preflightRefundUnallocated,
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
  return confirmCampaignSimple(input, "REFUND_UNALLOCATED", "refund_unallocated");
}

export function genLayerCampaignActionPostcondition(
  method: "cancel_campaign" | "refund_unallocated",
  state: Pick<GenLayerCampaignState, "status" | "availableAtto" | "reservedAtto">,
): boolean {
  if (method === "refund_unallocated") {
    return ["OPEN", "CLOSED"].includes(state.status) && state.availableAtto === "0";
  }
  return state.status === "CANCELLED"
    && state.availableAtto === "0"
    && state.reservedAtto === "0";
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
      latestWithdrawal!.snapshotHash,
      latestWithdrawal!.lastTxHash,
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
  const prepared = await prepareGenLayerMarketplaceTransaction({
    operation: "REQUEST_WITHDRAWAL",
    call,
    actorWallet: wallet,
    localCampaignId: context.draft.id,
    onchainEntityId: withdrawalId,
    recoveryOnly: marketplaceRecoveryOnly(input.body),
  });
  return { ...(await getGenLayerSettlement(input)), ...preparedMutationFields(prepared), withdrawalId };
}

export async function confirmGenLayerWithdrawal(input: CampaignActionInput) {
  const context = await campaignContext(input.campaignId);
  const prepared = await requirePrepared(input.body.preparedId);
  if (prepared.operation !== "REQUEST_WITHDRAWAL" || prepared.localCampaignId !== context.draft.id || prepared.actorWallet !== input.session.wallet.toLowerCase()) preparedMismatch();
  const call = storedCall(prepared);
  const finalized = await confirmPrepared(input.body, prepared, call, input.session.wallet, input.reconciliationFenceToken);
  const observationTicket = await nextGenLayerSharedObservationTicket();
  const withdrawalId = requireHash(prepared.onchainEntityId, "withdrawalId");
  const withdrawal = parseWithdrawalState(await readMarketplaceState("get_withdrawal", [withdrawalId]));
  if (withdrawal.status !== "PENDING" || withdrawal.account !== input.session.wallet.toLowerCase()) stateMismatch();
  await projectWithdrawal(withdrawal, finalized.hash, finalized.hash, finalized.finalizedAt * 1_000);
  await projectClaimable(withdrawal.account, finalized.hash, finalized.finalizedAt * 1_000, observationTicket);
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
  const prepared = await prepareGenLayerMarketplaceTransaction({
    operation: "EXECUTE_WITHDRAWAL",
    call,
    actorWallet: withdrawal.account,
    localCampaignId: context.draft.id,
    onchainEntityId: withdrawalId,
    recoveryOnly: marketplaceRecoveryOnly(input.body),
  });
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
  await projectWithdrawal(
    withdrawal,
    existing.requestTxHash,
    finalized.hash,
    finalized.finalizedAt * 1_000,
    existing.snapshotHash,
    existing.lastTxHash,
  );
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
  beforeInsert?: () => Promise<void>,
  recoveryOnly = false,
) {
  return prepareGenLayerMarketplaceTransaction({
    operation,
    call,
    actorWallet: actor,
    localCampaignId: context.draft.id,
    localApplicationId: context.application.id,
    onchainEntityId: entityId,
    recoveryOnly,
    beforeInsert,
  });
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
  const prepared = await prepareAction(
    operation,
    call,
    context,
    input.session.wallet,
    context.assignment.assignmentId,
    undefined,
    marketplaceRecoveryOnly(input.body),
  );
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
  const observationTicket = await nextGenLayerSharedObservationTicket();
  const assignment = parseAssignmentState(await readMarketplaceState("get_assignment", [context.assignment.assignmentId]));
  if (assignment.status !== expectedStatus) stateMismatch();
  const campaign = parseCampaignState(await readMarketplaceState("get_campaign", [context.campaign.campaignId]));
  const projected = await projectAssignment(
    context,
    assignment,
    campaign,
    finalized,
    context.assignment.selectionTxHash,
    { expectedPreviousSnapshotHash: context.assignment.snapshotHash },
  );
  if (expectedStatus === "ACCEPTED") await setGenLayerPrivateApplicationStatus({ id: context.application.id, expectedStatuses: ["SELECTED"], status: "ACCEPTED", nowMs: finalized.finalizedAt * 1_000 });
  if (expectedStatus === "DECLINED") await setGenLayerPrivateApplicationStatus({ id: context.application.id, expectedStatuses: ["SELECTED"], status: "DECLINED", nowMs: finalized.finalizedAt * 1_000 });
  await projectCampaign(context.draft, context.campaign, campaign, finalized.hash, finalized.finalizedAt * 1_000, observationTicket);
  if (expectedStatus === "REFUNDED") {
    await projectClaimable(
      context.draft.brandWallet,
      finalized.hash,
      finalized.finalizedAt * 1_000,
      observationTicket,
    );
  }
  await finalizePrepared(input, finalized, canonicalHash({ assignment, campaign }));
  return mutationResponse(context.draft, context.campaign, context.application, projected);
}

async function confirmCampaignSimple(
  input: CampaignActionInput,
  operation: Parameters<typeof prepareGenLayerMarketplaceTransaction>[0]["operation"],
  method: "cancel_campaign" | "refund_unallocated",
) {
  const context = await campaignContext(input.campaignId);
  assertBrand(context.draft, input.session.wallet);
  const call = callPlan(method, [context.projection.campaignId], ["string"]);
  const prepared = await requirePrepared(input.body.preparedId);
  if (prepared.operation !== operation || prepared.localCampaignId !== context.draft.id) preparedMismatch();
  const finalized = await confirmPrepared(input.body, prepared, call, input.session.wallet, input.reconciliationFenceToken);
  const observationTicket = await nextGenLayerSharedObservationTicket();
  const state = parseCampaignState(await readMarketplaceState("get_campaign", [context.projection.campaignId]));
  if (!genLayerCampaignActionPostcondition(method, state)) stateMismatch();
  const projected = await projectCampaign(context.draft, context.projection, state, finalized.hash, finalized.finalizedAt * 1_000, observationTicket);
  if (state.status !== "OPEN") await setGenLayerCampaignDraftStatus({ id: context.draft.id, expectedStatus: context.draft.status, status: state.status, nowMs: finalized.finalizedAt * 1_000 });
  await projectClaimable(context.draft.brandWallet, finalized.hash, finalized.finalizedAt * 1_000, observationTicket);
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
    let classifiedError = error;
    let terminalTransaction: FinalizedMarketplaceTransaction | null = null;
    try {
      terminalTransaction = exactTerminalMarketplaceTransaction(error, {
        call,
        actorWallet: actor,
        transactionHash: txHash,
      });
    } catch (bindingError) {
      classifiedError = bindingError;
    }
    const retryable = classifiedError instanceof MarketplaceGenLayerFinalityError
      && classifiedError.retryable;
    const terminalStatus = terminalTransaction
      ? terminalMarketplaceTransactionStatus(classifiedError)
      : null;
    await recordGenLayerTransactionStatus({
      preparedId: prepared.preparedId,
      status: terminalStatus ?? (retryable ? "ACCEPTED" : "RECONCILIATION_REQUIRED"),
      lifecycleStatus: terminalTransaction?.lifecycleStatus ?? null,
      executionResult: terminalTransaction?.executionResult ?? null,
      errorCode: classifiedError instanceof MarketplaceGenLayerFinalityError
        ? classifiedError.code
        : "GENLAYER_TRANSACTION_MISMATCH",
      retryAtMs: retryable ? Date.now() + 15_000 : 0,
      fenceToken: reconciliationFenceToken,
    });
    if (classifiedError instanceof MarketplaceGenLayerFinalityError) {
      throw new ApiProblem(
        retryable ? 202 : 409,
        classifiedError.code,
        classifiedError.message,
      );
    }
    throw problem(
      409,
      "GENLAYER_TRANSACTION_MISMATCH",
      classifiedError instanceof Error ? classifiedError.message : "Transaction mismatch.",
    );
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
    assignment.creatorHandle !== existing.creatorHandle ||
    assignment.creatorExternalUserId !== existing.creatorExternalUserId ||
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

function assertResolutionPreparationBinding(
  existing: GenLayerAssignmentProjection,
  assignment: GenLayerAssignmentState,
): void {
  if (
    assignment.postId !== existing.postId ||
    assignment.submissionHash !== existing.submissionHash ||
    assignment.resolutionRequestId !== existing.resolutionRequestId ||
    assignment.resolutionRound !== existing.resolutionRound ||
    assignment.resolutionAttempts !== existing.resolutionAttempts ||
    assignment.resolutionEligibleAtEpoch !== existing.resolutionEligibleAtEpoch ||
    assignment.lastResolutionAtEpoch !== existing.lastResolutionAtEpoch
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
    campaign.maxUndeterminedRetries !== existing.maxUndeterminedRetries ||
    campaign.feeBps !== existing.feeBps ||
    campaign.treasury !== existing.treasuryWallet
  ) stateMismatch();
}

async function projectCampaign(
  draft: GenLayerCampaignDraft,
  existing: GenLayerCampaignProjection,
  state: GenLayerCampaignState,
  txHash: string,
  finalizedAt: number,
  observationTicket: number,
) {
  return upsertGenLayerCampaignProjection({
    campaignId: state.campaignId, localCampaignId: draft.id, contractAddress: marketplaceContractAddress(), brandWallet: state.brand, clientNonce: state.clientNonce, contentSource: state.contentSource, termsHash: state.termsHash, budgetAtto: state.budgetAtto, availableAtto: state.availableAtto, reservedAtto: state.reservedAtto, settledAtto: state.settledAtto, creatorPaidAtto: state.creatorPaidAtto, brandRefundedAtto: state.brandRefundedAtto, feeAtto: state.feeAtto, status: state.status, feeBps: state.feeBps, treasuryWallet: state.treasury, applicationCount: state.applicationCount, assignmentCount: state.assignmentCount, maxUndeterminedRetries: state.maxUndeterminedRetries, applicationDeadlineEpoch: state.applicationDeadlineEpoch, selectionDeadlineEpoch: state.selectionDeadlineEpoch, submissionDeadlineEpoch: state.submissionDeadlineEpoch, retentionSeconds: state.retentionSeconds, createdAtEpoch: state.createdAtEpoch, closedAtEpoch: state.closedAtEpoch, creationTxHash: existing.creationTxHash, lastTxHash: txHash, finalizedAt, snapshotHash: campaignSnapshotHash(state), observationTicket, nowMs: finalizedAt,
  });
}

async function projectAssignment(
  context: ActionContext,
  state: GenLayerAssignmentState,
  campaign: GenLayerCampaignState,
  finalized: FinalizedMarketplaceTransaction,
  selectionTxHash: string,
  options: {
    sharedProjectionPending?: boolean;
    expectedPreviousSnapshotHash?: string;
  } = {},
) {
  const sharedProjectionPending = options.sharedProjectionPending ?? false;
  return upsertGenLayerAssignmentProjection({
    contractAddress: marketplaceContractAddress(), assignmentId: state.assignmentId, campaignId: state.campaignId, localApplicationId: context.application.id, brandWallet: state.brand, creatorWallet: state.creator, contentSource: state.contentSource, creatorHandle: state.creatorHandle, creatorExternalUserId: state.creatorExternalUserId, creatorIdentityHash: state.creatorIdentityHash, applicationId: state.applicationId, agreedRateAtto: state.agreedRateAtto, agreementHash: state.agreementHash, status: state.status, selectedAtEpoch: state.selectedAtEpoch, acceptanceDeadlineEpoch: state.acceptanceDeadlineEpoch, acceptedAtEpoch: state.acceptedAtEpoch, postId: state.postId, submissionHash: state.submissionHash, resolutionRequestId: state.resolutionRequestId, resolutionAttempts: state.resolutionAttempts, resolutionEligibleAtEpoch: state.resolutionEligibleAtEpoch, lastResolutionAtEpoch: state.lastResolutionAtEpoch, evidenceHash: state.evidenceHash, outcome: state.outcome, reasoning: state.reasoning, resolutionChecks: state.resolutionChecks, resolutionRound: state.resolutionRound, maxUndeterminedRetries: campaign.maxUndeterminedRetries, creatorCreditAtto: state.creatorCreditAtto, brandCreditAtto: state.brandCreditAtto, feeAtto: state.feeAtto, submittedAtEpoch: state.submittedAtEpoch, settledAtEpoch: state.settledAtEpoch, closedAtEpoch: state.closedAtEpoch, selectionTxHash, lastTxHash: finalized.hash, finalizedAt: finalized.finalizedAt * 1_000, snapshotHash: canonicalHash(state), sharedProjectionPending, sharedProjectionAnchorTxHash: sharedProjectionPending ? finalized.hash : null, expectedPreviousSnapshotHash: options.expectedPreviousSnapshotHash, nowMs: finalized.finalizedAt * 1_000,
  });
}

function resolutionRequiresSharedObservation(
  assignment: Pick<GenLayerAssignmentProjection | GenLayerAssignmentState, "status">,
): boolean {
  return assignment.status === "SETTLED_PASS" || assignment.status === "SETTLED_FAIL";
}

function resolutionReceiptAlreadyProjected(
  assignment: GenLayerAssignmentProjection,
  finalized: FinalizedMarketplaceTransaction,
): boolean {
  return assignment.lastTxHash === finalized.hash
    && assignment.finalizedAt === finalized.finalizedAt * 1_000
    && HASH.test(assignment.snapshotHash)
    && ["UNDETERMINED", "SETTLED_PASS", "SETTLED_FAIL"].includes(assignment.status);
}

function exactFinalizedLoader(
  finalized: FinalizedMarketplaceTransaction,
): typeof loadFinalizedMarketplaceTransaction {
  return async (transactionHash: string) => {
    if (requireHash(transactionHash, "transactionHash") !== finalized.hash) {
      throw new Error("The shared observation requested another receipt.");
    }
    return finalized;
  };
}

async function repairSharedObservationBestEffort(
  assignment: GenLayerAssignmentProjection,
  finalized: FinalizedMarketplaceTransaction,
): Promise<void> {
  try {
    await observeGenLayerResolutionSharedState({
      assignment,
      dependencies: { loadFinalized: exactFinalizedLoader(finalized) },
    });
  } catch {
    // The exact assignment marker is durable; bounded maintenance owns retry.
  }
}

async function projectClaimable(
  wallet: string,
  txHash: string,
  nowMs: number,
  observationTicket: number,
) {
  const state = parseClaimableState(await readMarketplaceState("get_claimable", [marketplaceCalldataAddress(wallet)]));
  await upsertGenLayerClaimableBalance({ contractAddress: marketplaceContractAddress(), wallet: state.account, amountAtto: state.claimableAtto, nextWithdrawalNonce: state.nextWithdrawalNonce, transactionHash: txHash, snapshotHash: canonicalHash(state), observationTicket, nowMs });
}

async function projectWithdrawal(
  state: GenLayerWithdrawalState,
  requestTxHash: string,
  lastTxHash: string,
  finalizedAt: number,
  expectedPreviousSnapshotHash?: string,
  expectedPreviousLastTxHash?: string,
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
    expectedPreviousSnapshotHash,
    expectedPreviousLastTxHash,
    nowMs: finalizedAt,
  });
}

function assertApplicationBinding(state: GenLayerApplicationState, local: GenLayerPrivateApplication, campaignId: string, applicationId: string) {
  if (state.applicationId !== applicationId || state.campaignId !== campaignId || state.creator !== local.creatorWallet || state.requestedRateAtto !== local.requestedRateAtto || state.pitchCommitment !== local.pitchCommitment || state.status !== "APPLIED") stateMismatch();
}

function assertPreparationApplicationBinding(
  state: GenLayerApplicationState,
  context: ActionContext,
  applicationId: string,
): void {
  if (
    context.application.status !== "APPLIED" ||
    state.applicationId !== applicationId ||
    state.campaignId !== context.campaign.campaignId ||
    state.creator !== context.application.creatorWallet ||
    state.contentSource !== context.draft.contentSource ||
    state.requestedRateAtto !== context.application.requestedRateAtto ||
    state.pitchCommitment !== context.application.pitchCommitment ||
    state.status !== "APPLIED"
  ) stateMismatch();
}

function assertApplicationIdentityBinding(
  state: GenLayerApplicationState,
  profile: Readonly<{ identityHash: string; externalUserId: string }>,
): void {
  if (
    state.creatorIdentityHash !== profile.identityHash ||
    state.creatorExternalUserId !== profile.externalUserId
  ) identityBundleMismatch();
}

function assertAssignmentBinding(state: GenLayerAssignmentState, context: ActionContext, assignmentId: string, agreementHash: string) {
  if (state.assignmentId !== assignmentId || state.campaignId !== context.campaign.campaignId || state.creator !== context.application.creatorWallet || state.contentSource !== context.draft.contentSource || state.applicationId !== deriveApplicationId(context.campaign.campaignId, context.application.creatorWallet) || state.agreementHash !== agreementHash || state.agreedRateAtto !== context.application.requestedRateAtto || state.status !== "SELECTED") stateMismatch();
}

function assertPreparationAssignmentBinding(
  existing: GenLayerAssignmentProjection,
  assignment: GenLayerAssignmentState,
): void {
  if (
    assignment.status !== existing.status ||
    assignment.selectedAtEpoch !== existing.selectedAtEpoch ||
    assignment.acceptanceDeadlineEpoch !== existing.acceptanceDeadlineEpoch ||
    assignment.acceptedAtEpoch !== existing.acceptedAtEpoch ||
    assignment.postId !== existing.postId ||
    assignment.submissionHash !== existing.submissionHash ||
    assignment.resolutionRequestId !== existing.resolutionRequestId ||
    assignment.resolutionRound !== existing.resolutionRound ||
    assignment.resolutionAttempts !== existing.resolutionAttempts ||
    assignment.resolutionEligibleAtEpoch !== existing.resolutionEligibleAtEpoch ||
    assignment.lastResolutionAtEpoch !== existing.lastResolutionAtEpoch
  ) stateMismatch();
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
  assignment: Pick<
    GenLayerAssignmentProjection,
    "creatorIdentityHash" | "creatorExternalUserId"
  >,
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
  const dto = applicationDto(application, draft.contentSource, assignment, campaign);
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
  campaign: GenLayerCampaignProjection,
) {
  const undeterminedRefundEligibleAt = assignment?.status === "UNDETERMINED"
    && assignment.resolutionAttempts >= campaign.maxUndeterminedRetries
    ? new Date(genLayerUndeterminedRefundEligibleAtEpoch(assignment, campaign) * 1_000).toISOString()
    : null;
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
    acceptanceDeadline: assignment
      ? new Date(assignment.acceptanceDeadlineEpoch * 1_000).toISOString()
      : null,
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
    resolutionAttempts: assignment?.resolutionAttempts ?? 0,
    resolutionEligibleAt: assignment?.resolutionEligibleAtEpoch
      ? new Date(assignment.resolutionEligibleAtEpoch * 1_000).toISOString()
      : null,
    undeterminedRefundEligibleAt,
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

export async function buildGenLayerSubmissionCall(input: {
  assignmentId: string;
  agreementHash: string;
  creatorIdentityHash: string;
  contentSource: "X" | "FARCASTER";
  submittedContent: unknown;
  expectedUsername: string;
  expectedExternalUserId: string;
}, options: {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}) {
  const contentId = input.contentSource === "FARCASTER"
    ? await resolveFarcasterCastHashFromUrl(
        input.submittedContent,
        {
          expectedUsername: input.expectedUsername,
          expectedFid: input.expectedExternalUserId,
        },
        options,
      )
    : contentIdentifier(input.contentSource, input.submittedContent);
  const submissionHash = canonicalHash({
    protocol: "influencedx-submission-v2",
    assignment_id: input.assignmentId,
    content_source: input.contentSource,
    content_id: contentId,
    creator_identity_hash: input.creatorIdentityHash,
  });
  const requestId = deriveResolutionRequestId({
    assignmentId: input.assignmentId,
    agreementHash: input.agreementHash,
    submissionHash,
    contentSource: input.contentSource,
    postId: contentId,
    roundIndex: 0,
  });
  return Object.freeze({
    contentId,
    submissionHash,
    requestId,
    call: callPlan(
      "submit_evidence",
      [input.assignmentId, requestId, contentId, submissionHash],
      ["string", "string", "string", "string"],
    ),
  });
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
