import {
  parseAssignmentState,
  parseCampaignState,
  parseClaimableState,
  type GenLayerCampaignState,
} from "./marketplace-genlayer-core.ts";
import {
  beginGenLayerSharedResolutionObservationAttempt,
  completeGenLayerSharedResolutionRepair,
  deferGenLayerSharedResolutionRepair,
  findGenLayerCampaignProjectionByOnchainId,
  listPendingGenLayerSharedResolutionRepairs,
  observeGenLayerCampaignProjection,
  observeGenLayerClaimableBalance,
  type GenLayerAssignmentProjection,
  type GenLayerCampaignProjection,
} from "./marketplace-genlayer-repository.ts";
import {
  canonicalHash,
  loadFinalizedMarketplaceTransaction,
  marketplaceCalldataAddress,
  marketplaceContractAddress,
  readMarketplaceState,
  type FinalizedMarketplaceTransaction,
} from "./marketplace-genlayer-rpc.ts";

const TERMINAL_RESOLUTION_STATUSES = new Set(["SETTLED_PASS", "SETTLED_FAIL"]);

export type GenLayerSharedObservationDependencies = Readonly<{
  findCampaign?: typeof findGenLayerCampaignProjectionByOnchainId;
  loadFinalized?: typeof loadFinalizedMarketplaceTransaction;
  readState?: typeof readMarketplaceState;
  observeCampaign?: typeof observeGenLayerCampaignProjection;
  observeClaimable?: typeof observeGenLayerClaimableBalance;
  complete?: typeof completeGenLayerSharedResolutionRepair;
  begin?: typeof beginGenLayerSharedResolutionObservationAttempt;
  defer?: typeof deferGenLayerSharedResolutionRepair;
  listPending?: typeof listPendingGenLayerSharedResolutionRepairs;
}>;

/**
 * Refreshes wallet-shared state as a stable LATEST_FINAL observation made
 * after one exact finalized resolution receipt. The assignment row remains
 * the causal receipt record; campaign and claimable rows are observations.
 */
export async function observeGenLayerResolutionSharedState(input: {
  assignment: GenLayerAssignmentProjection;
  nowMs?: number;
  dependencies?: GenLayerSharedObservationDependencies;
}): Promise<Readonly<{
  status: "OBSERVED" | "ALREADY_OBSERVED";
  walletCount: number;
  observationStartedAt: number;
}>> {
  const marker = input.assignment;
  const dependencies = input.dependencies ?? {};
  const nowMs = input.nowMs ?? Date.now();
  assertMarker(marker, nowMs);
  if (!marker.sharedProjectionPending) {
    return Object.freeze({
      status: "ALREADY_OBSERVED",
      walletCount: 0,
      observationStartedAt: 0,
    });
  }
  const anchorTransactionHash = marker.sharedProjectionAnchorTxHash!;
  let repairMarker = marker;
  try {
    const finalized = await (
      dependencies.loadFinalized ?? loadFinalizedMarketplaceTransaction
    )(anchorTransactionHash);
    assertResolutionAnchor(marker, finalized);
    const attempt = await (
      dependencies.begin ?? beginGenLayerSharedResolutionObservationAttempt
    )({
      projectionId: marker.projectionId,
      anchorTransactionHash,
      assignmentSnapshotHash: marker.snapshotHash,
    });
    if (!attempt?.sharedProjectionObservationTicket) {
      throw new GenLayerSharedObservationRetryError(
        "Another shared-observation attempt advanced this marker.",
      );
    }
    repairMarker = attempt;
    return await runTicketedObservation({
      marker: attempt,
      finalized,
      observationTicket: attempt.sharedProjectionObservationTicket,
      nowMs,
      dependencies,
    });
  } catch (error) {
    await (dependencies.defer ?? deferGenLayerSharedResolutionRepair)({
      projectionId: repairMarker.projectionId,
      anchorTransactionHash,
      snapshotHash: repairMarker.snapshotHash,
      observationTicket: repairMarker.sharedProjectionObservationTicket,
      nowMs,
    }).catch(() => false);
    throw error;
  }
}

async function runTicketedObservation(input: {
  marker: GenLayerAssignmentProjection;
  finalized: FinalizedMarketplaceTransaction;
  observationTicket: number;
  nowMs: number;
  dependencies: GenLayerSharedObservationDependencies;
}): Promise<Readonly<{
  status: "OBSERVED";
  walletCount: number;
  observationStartedAt: number;
}>> {
  const { marker, observationTicket, nowMs, dependencies } = input;
  const anchorTransactionHash = marker.sharedProjectionAnchorTxHash!;

  const campaignProjection = await (
    dependencies.findCampaign ?? findGenLayerCampaignProjectionByOnchainId
  )(marker.campaignId);
  if (!campaignProjection) throw new GenLayerSharedObservationRetryError("Campaign projection is unavailable.");
  assertCampaignProjectionBinding(marker, campaignProjection);

  const wallets = [...new Set([
    marker.creatorWallet,
    marker.brandWallet,
    campaignProjection.treasuryWallet,
  ].map((wallet) => wallet.toLowerCase()))];
  const observationStartedAt = Math.max(nowMs, marker.finalizedAt + 1);
  const readState = dependencies.readState ?? readMarketplaceState;
  const first = await readObservationRound(marker, wallets, readState);
  const second = await readObservationRound(marker, wallets, readState);
  if (canonicalHash(first) !== canonicalHash(second)) {
    throw new GenLayerSharedObservationRetryError(
      "The finalized shared state changed during observation.",
    );
  }

  const assignment = parseAssignmentState(second.assignment);
  const campaign = parseCampaignState(second.campaign);
  const claimables = second.claimables.map(parseClaimableState);
  if (
    assignment.assignmentId !== marker.assignmentId ||
    canonicalHash(assignment) !== marker.snapshotHash
  ) {
    throw new GenLayerSharedObservationRetryError(
      "The exact resolution assignment marker no longer matches finalized state.",
    );
  }
  assertCampaignObservationBinding(marker, campaignProjection, campaign);
  claimables.forEach((claimable, index) => {
    if (claimable.account !== wallets[index]) {
      throw new GenLayerSharedObservationRetryError(
        "A claimable observation returned another wallet.",
      );
    }
  });

  await Promise.all([
    (dependencies.observeCampaign ?? observeGenLayerCampaignProjection)({
      state: campaign,
      anchorTransactionHash,
      anchorFinalizedAt: marker.finalizedAt,
      observationTicket,
      observationStartedAt,
    }),
    ...claimables.map((state) =>
      (dependencies.observeClaimable ?? observeGenLayerClaimableBalance)({
        state,
        anchorTransactionHash,
        anchorFinalizedAt: marker.finalizedAt,
        observationTicket,
        observationStartedAt,
      })),
  ]);
  const completed = await (
    dependencies.complete ?? completeGenLayerSharedResolutionRepair
  )({
    projectionId: marker.projectionId,
    anchorTransactionHash,
    assignmentSnapshotHash: marker.snapshotHash,
    observationTicket,
    anchorFinalizedAt: marker.finalizedAt,
    campaignId: marker.campaignId,
    campaignSnapshotHash: canonicalHash(campaign),
    claimables: claimables.map((state) => ({
      wallet: state.account,
      snapshotHash: canonicalHash(state),
    })),
  });
  if (!completed) {
    throw new GenLayerSharedObservationRetryError(
      "The assignment shared-observation marker advanced before completion.",
    );
  }
  return Object.freeze({
    status: "OBSERVED",
    walletCount: wallets.length,
    observationStartedAt,
  });
}

export async function runGenLayerSharedObservationRepairBatch(options: {
  nowMs?: number;
  limit?: number;
  dependencies?: GenLayerSharedObservationDependencies;
} = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const limit = options.limit ?? 8;
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("The shared observation repair clock is invalid.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("The shared observation repair limit is invalid.");
  }
  const dependencies = options.dependencies ?? {};
  const rows = await (
    dependencies.listPending ?? listPendingGenLayerSharedResolutionRepairs
  )({ nowMs, limit });
  const results = await Promise.allSettled(rows.map((assignment) =>
    observeGenLayerResolutionSharedState({ assignment, nowMs, dependencies })
  ));
  return Object.freeze({
    scanned: rows.length,
    repaired: results.filter((result) => result.status === "fulfilled").length,
    pending: results.filter((result) => result.status === "rejected").length,
  });
}

async function readObservationRound(
  marker: GenLayerAssignmentProjection,
  wallets: string[],
  readState: typeof readMarketplaceState,
): Promise<Readonly<{
  assignment: unknown;
  campaign: unknown;
  claimables: unknown[];
}>> {
  const [assignment, campaign, ...claimables] = await Promise.all([
    readState("get_assignment", [marker.assignmentId]),
    readState("get_campaign", [marker.campaignId]),
    ...wallets.map((wallet) =>
      readState("get_claimable", [marketplaceCalldataAddress(wallet)])),
  ]);
  return Object.freeze({ assignment, campaign, claimables });
}

function assertMarker(marker: GenLayerAssignmentProjection, nowMs: number): void {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs <= 0 ||
    !TERMINAL_RESOLUTION_STATUSES.has(marker.status) ||
    !marker.resolutionRequestId ||
    !marker.lastTxHash ||
    marker.finalizedAt <= 0 ||
    (marker.sharedProjectionPending &&
      marker.sharedProjectionAnchorTxHash !== marker.lastTxHash) ||
    (!marker.sharedProjectionPending &&
      marker.sharedProjectionAnchorTxHash !== null &&
      marker.sharedProjectionAnchorTxHash !== marker.lastTxHash)
  ) {
    throw new GenLayerSharedObservationRetryError(
      "The assignment shared-observation marker is invalid.",
    );
  }
}

function assertResolutionAnchor(
  marker: GenLayerAssignmentProjection,
  finalized: FinalizedMarketplaceTransaction,
): void {
  if (
    finalized.hash !== marker.lastTxHash ||
    finalized.recipient !== marketplaceContractAddress() ||
    finalized.functionName !== "resolve_assignment" ||
    finalized.valueAtto !== "0" ||
    finalized.args === null ||
    finalized.args.length !== 2 ||
    finalized.args[0] !== marker.assignmentId ||
    finalized.args[1] !== marker.resolutionRequestId ||
    finalized.finalizedAt * 1_000 !== marker.finalizedAt
  ) {
    throw new GenLayerSharedObservationRetryError(
      "The shared-observation anchor is not the exact resolution receipt.",
    );
  }
}

function assertCampaignProjectionBinding(
  marker: GenLayerAssignmentProjection,
  campaign: GenLayerCampaignProjection,
): void {
  if (
    campaign.campaignId !== marker.campaignId ||
    campaign.contractAddress !== marketplaceContractAddress() ||
    campaign.brandWallet !== marker.brandWallet ||
    campaign.contentSource !== marker.contentSource ||
    campaign.maxUndeterminedRetries !== marker.maxUndeterminedRetries
  ) {
    throw new GenLayerSharedObservationRetryError(
      "The shared campaign projection is not bound to the assignment marker.",
    );
  }
}

function assertCampaignObservationBinding(
  marker: GenLayerAssignmentProjection,
  projected: GenLayerCampaignProjection,
  observed: GenLayerCampaignState,
): void {
  if (
    observed.campaignId !== marker.campaignId ||
    observed.brand !== marker.brandWallet ||
    observed.contentSource !== marker.contentSource ||
    observed.maxUndeterminedRetries !== marker.maxUndeterminedRetries ||
    observed.clientNonce !== projected.clientNonce ||
    observed.termsHash !== projected.termsHash ||
    observed.budgetAtto !== projected.budgetAtto ||
    observed.feeBps !== projected.feeBps ||
    observed.treasury !== projected.treasuryWallet ||
    observed.applicationDeadlineEpoch !== projected.applicationDeadlineEpoch ||
    observed.selectionDeadlineEpoch !== projected.selectionDeadlineEpoch ||
    observed.submissionDeadlineEpoch !== projected.submissionDeadlineEpoch ||
    observed.retentionSeconds !== projected.retentionSeconds ||
    observed.createdAtEpoch !== projected.createdAtEpoch
  ) {
    throw new GenLayerSharedObservationRetryError(
      "The finalized shared campaign observation changed immutable terms.",
    );
  }
}

export class GenLayerSharedObservationRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenLayerSharedObservationRetryError";
  }
}
