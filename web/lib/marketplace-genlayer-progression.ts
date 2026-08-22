import { timingSafeEqual } from "node:crypto";

import { enqueueCampaignProgression } from "./campaign-progression-queue.ts";
import {
  parseAssignmentState,
  parseCampaignState,
  type GenLayerAssignmentState,
  type GenLayerCampaignState,
} from "./marketplace-genlayer-core.ts";
import {
  reconcileGenLayerOperatorCampaignFinalization,
  reconcileGenLayerOperatorExpiry,
  reconcileGenLayerOperatorResolution,
} from "./marketplace-genlayer-actions.ts";
import {
  createGenLayerOperatorClient,
  loadGenLayerOperatorConfig,
  type GenLayerOperatorAction,
  type GenLayerOperatorProjection,
  type GenLayerOperatorRequest,
} from "./marketplace-genlayer-operator-client.ts";
import {
  findGenLayerAssignmentProjectionByAssignmentId,
  listDueGenLayerAssignmentExpiryProjections,
  listDueGenLayerCampaignFinalizationProjections,
  listDueGenLayerResolutionProjections,
  type GenLayerAssignmentExpiryCandidate,
  type GenLayerAssignmentProjection,
  type GenLayerCampaignProjection,
} from "./marketplace-genlayer-repository.ts";
import {
  marketplaceContractAddress,
  readMarketplaceState,
} from "./marketplace-genlayer-rpc.ts";

const TERMINAL_FAILURES = new Set([
  "EXECUTION_FAILED",
  "NETWORK_TERMINATED",
  "RECONCILIATION_REQUIRED",
  "POLLING_EXHAUSTED",
  "POISONED",
]);
const V2_FINALIZATION_REFUND_DELAY_SECONDS = 24 * 60 * 60;

type OperatorSubmit = (
  request: GenLayerOperatorRequest,
) => Promise<{ replayed: boolean; operation: GenLayerOperatorProjection }>;

export type GenLayerProgressionDependencies = Readonly<{
  listResolutions?: typeof listDueGenLayerResolutionProjections;
  listExpiries?: typeof listDueGenLayerAssignmentExpiryProjections;
  listFinalizations?: typeof listDueGenLayerCampaignFinalizationProjections;
  enqueueResolution?: typeof enqueueCampaignProgression;
  readAssignment?: (assignmentId: string) => Promise<GenLayerAssignmentState>;
  readCampaign?: (campaignId: string) => Promise<GenLayerCampaignState>;
  findAssignment?: typeof findGenLayerAssignmentProjectionByAssignmentId;
  submit?: OperatorSubmit;
  reconcileResolution?: typeof reconcileGenLayerOperatorResolution;
  reconcileExpiry?: typeof reconcileGenLayerOperatorExpiry;
  reconcileFinalization?: typeof reconcileGenLayerOperatorCampaignFinalization;
}>;

type LifecycleResult = Readonly<{
  status: "FINALIZED" | "STALE";
  operationId: string | null;
}>;

function completeOrRetry(
  operation: GenLayerOperatorProjection,
  expectedAction: GenLayerOperatorAction,
): Readonly<{ status: "FINALIZED"; operationId: string }> {
  assertOperatorProjectionBinding(operation, expectedAction);
  if (operation.status === "FINALIZED") {
    if (!operation.txHash || !operation.finalizedAt) {
      throw new GenLayerProgressionPoisonError("Finalized operator result is incomplete.");
    }
    return Object.freeze({ status: "FINALIZED", operationId: operation.operationId });
  }
  // PRECHECK_FAILED is retryable. Operator ingress can replay the deterministic
  // operation after transient RPC, retention, or deadline failures; the
  // queue/cron supplies bounded backoff.
  if (TERMINAL_FAILURES.has(operation.status)) {
    throw new GenLayerProgressionPoisonError(
      `Automatic StudioNet progression stopped with ${operation.status}.`,
    );
  }
  throw new GenLayerProgressionRetryError(
    `Automatic StudioNet progression is ${operation.status}.`,
  );
}

export async function reconcileQueuedGenLayerProgression(input: {
  assignmentId: string;
  requestId: string;
  dependencies?: GenLayerProgressionDependencies;
}): Promise<Readonly<{ status: "FINALIZED" | "STALE"; operationId: string }>> {
  const dependencies = input.dependencies ?? {};
  const existing = await (
    dependencies.findAssignment ?? findGenLayerAssignmentProjectionByAssignmentId
  )(input.assignmentId);
  if (!existing) {
    throw new GenLayerProgressionPoisonError(
      "The queue message no longer matches its projected resolution request.",
    );
  }
  const submit = dependencies.submit ?? await defaultSubmitter();
  const { operation } = await submit({
    schemaVersion: 1,
    action: "resolve_assignment",
    assignmentId: input.assignmentId,
    requestId: input.requestId,
  });
  assertOperatorProjectionBinding(operation, "resolve_assignment");
  if (operation.status === "FINALIZED") {
    const complete = completeOrRetry(operation, "resolve_assignment");
    await (dependencies.reconcileResolution ?? reconcileGenLayerOperatorResolution)({
      assignmentId: input.assignmentId,
      requestId: input.requestId,
      transactionHash: operation.txHash!,
      finalizedAtMs: Date.parse(operation.finalizedAt!),
    });
    return complete;
  }
  if (existing.resolutionRequestId !== input.requestId) {
    if (
      operation.status === "PRECHECK_FAILED" &&
      operation.txHash === null &&
      operation.broadcastStartedAt === null &&
      operation.submittedAt === null
    ) {
      return Object.freeze({ status: "STALE" as const, operationId: operation.operationId });
    }
    throw new GenLayerProgressionPoisonError(
      "The queue message no longer matches its projected resolution request.",
    );
  }
  const authoritative = await readAssignment(
    existing.assignmentId,
    dependencies.readAssignment,
  );
  assertResolutionBinding(existing, authoritative, input.requestId);
  if (
    operation.status === "PRECHECK_FAILED" &&
    authoritative.resolutionRequestId !== input.requestId &&
    operation.txHash === null &&
    operation.broadcastStartedAt === null &&
    operation.submittedAt === null
  ) {
    return Object.freeze({ status: "STALE" as const, operationId: operation.operationId });
  }
  return completeOrRetry(operation, "resolve_assignment");
}

/**
 * Repairs queue-publication gaps and advances permissionless V2 deadlines.
 * Candidates are projection-bound. Deterministic operator records are replayed
 * before any current-state check; only an unbroadcast precheck failure uses a
 * fresh StudioNet read to prove that the projected candidate became stale.
 */
export async function runGenLayerProgressionBatch(options: {
  nowMs?: number;
  limit?: number;
  dependencies?: GenLayerProgressionDependencies;
} = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const limit = options.limit ?? 8;
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("The GenLayer progression clock is invalid.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("The GenLayer progression limit is invalid.");
  }
  const dependencies = options.dependencies ?? {};
  const nowEpoch = Math.floor(nowMs / 1_000);
  const [resolutions, expiries, finalizations] = await Promise.all([
    (dependencies.listResolutions ?? listDueGenLayerResolutionProjections)({ nowEpoch, limit }),
    (dependencies.listExpiries ?? listDueGenLayerAssignmentExpiryProjections)({ nowEpoch, limit }),
    (dependencies.listFinalizations ?? listDueGenLayerCampaignFinalizationProjections)({ nowEpoch, limit }),
  ]);

  const resolutionResults = await Promise.allSettled(resolutions.map((row) =>
    (dependencies.enqueueResolution ?? enqueueCampaignProgression)({
      assignmentId: row.assignmentId,
      requestId: row.resolutionRequestId!,
      delaySeconds: 0,
    })));

  let submit: OperatorSubmit | null = dependencies.submit ?? null;
  if ((expiries.length > 0 || finalizations.length > 0) && !submit) {
    submit = await defaultSubmitter();
  }
  const lifecycleResults = await Promise.allSettled([
    ...expiries.map((candidate) => processExpiryCandidate(
      candidate,
      nowEpoch,
      submit!,
      dependencies,
    )),
    ...finalizations.map((candidate) => processFinalizationCandidate(
      candidate,
      nowEpoch,
      submit!,
      dependencies,
    )),
  ]);

  const rejected = lifecycleResults.filter((result) => result.status === "rejected");
  return Object.freeze({
    scanned: resolutions.length + expiries.length + finalizations.length,
    resolutionScanned: resolutions.length,
    expiryScanned: expiries.length,
    finalizationScanned: finalizations.length,
    queued: resolutionResults.filter((result) => result.status === "fulfilled").length,
    finalized: lifecycleResults.filter((result) =>
      result.status === "fulfilled" && result.value.status === "FINALIZED").length,
    stale: lifecycleResults.filter((result) =>
      result.status === "fulfilled" && result.value.status === "STALE").length,
    pending: rejected.filter((result) =>
      result.reason instanceof GenLayerProgressionRetryError).length,
    failed:
      resolutionResults.filter((result) => result.status === "rejected").length +
      rejected.filter((result) =>
        !(result.reason instanceof GenLayerProgressionRetryError)).length,
  });
}

async function processExpiryCandidate(
  candidate: GenLayerAssignmentExpiryCandidate,
  nowEpoch: number,
  submit: OperatorSubmit,
  dependencies: GenLayerProgressionDependencies,
): Promise<LifecycleResult> {
  const { operation } = await submit({
    schemaVersion: 1,
    action: "expire_assignment",
    assignmentId: candidate.assignment.assignmentId,
  });
  assertOperatorProjectionBinding(operation, "expire_assignment");
  if (operation.status === "FINALIZED") {
    const complete = completeOrRetry(operation, "expire_assignment");
    await (dependencies.reconcileExpiry ?? reconcileGenLayerOperatorExpiry)({
      assignmentId: candidate.assignment.assignmentId,
      transactionHash: operation.txHash!,
      finalizedAtMs: Date.parse(operation.finalizedAt!),
    });
    return complete;
  }
  if (operatorPrecheckProvesNoBroadcast(operation)) {
    const [assignment, campaign] = await Promise.all([
      readAssignment(candidate.assignment.assignmentId, dependencies.readAssignment),
      readCampaign(candidate.campaign.campaignId, dependencies.readCampaign),
    ]);
    assertAssignmentCandidateBinding(candidate, assignment, campaign);
    if (!assignmentExpiryIsDue(assignment, campaign, nowEpoch)) {
      return Object.freeze({ status: "STALE", operationId: operation.operationId });
    }
  }
  return completeOrRetry(operation, "expire_assignment");
}

async function processFinalizationCandidate(
  candidate: GenLayerCampaignProjection,
  nowEpoch: number,
  submit: OperatorSubmit,
  dependencies: GenLayerProgressionDependencies,
): Promise<LifecycleResult> {
  const { operation } = await submit({
    schemaVersion: 1,
    action: "finalize_campaign",
    campaignId: candidate.campaignId,
  });
  assertOperatorProjectionBinding(operation, "finalize_campaign");
  if (operation.status === "FINALIZED") {
    const complete = completeOrRetry(operation, "finalize_campaign");
    await (dependencies.reconcileFinalization ?? reconcileGenLayerOperatorCampaignFinalization)({
      campaignId: candidate.campaignId,
      transactionHash: operation.txHash!,
      finalizedAtMs: Date.parse(operation.finalizedAt!),
    });
    return complete;
  }
  if (operatorPrecheckProvesNoBroadcast(operation)) {
    const campaign = await readCampaign(candidate.campaignId, dependencies.readCampaign);
    assertCampaignCandidateBinding(candidate, campaign);
    if (!campaignFinalizationIsDue(campaign, nowEpoch)) {
      return Object.freeze({ status: "STALE", operationId: operation.operationId });
    }
  }
  return completeOrRetry(operation, "finalize_campaign");
}

function operatorPrecheckProvesNoBroadcast(
  operation: GenLayerOperatorProjection,
): boolean {
  return operation.status === "PRECHECK_FAILED"
    && operation.txHash === null
    && operation.broadcastStartedAt === null
    && operation.submittedAt === null;
}

export function assignmentExpiryIsDue(
  assignment: Pick<GenLayerAssignmentState, "status" | "acceptanceDeadlineEpoch">,
  campaign: Pick<GenLayerCampaignState, "submissionDeadlineEpoch">,
  nowEpoch: number,
): boolean {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch <= 0) return false;
  return (
    (assignment.status === "SELECTED" && nowEpoch > assignment.acceptanceDeadlineEpoch) ||
    (assignment.status === "ACCEPTED" && nowEpoch > campaign.submissionDeadlineEpoch)
  );
}

export function campaignFinalizationIsDue(
  campaign: Pick<
    GenLayerCampaignState,
    "status" | "reservedAtto" | "submissionDeadlineEpoch" | "retentionSeconds"
  >,
  nowEpoch: number,
): boolean {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch <= 0) return false;
  return (
    campaign.status === "OPEN" &&
    campaign.reservedAtto === "0" &&
    nowEpoch >= campaign.submissionDeadlineEpoch +
      campaign.retentionSeconds +
      V2_FINALIZATION_REFUND_DELAY_SECONDS
  );
}

async function defaultSubmitter(): Promise<OperatorSubmit> {
  const config = await loadGenLayerOperatorConfig();
  if (!config) throw new GenLayerProgressionConfigurationError();
  return createGenLayerOperatorClient(config).submit;
}

async function readAssignment(
  assignmentId: string,
  implementation?: (assignmentId: string) => Promise<GenLayerAssignmentState>,
): Promise<GenLayerAssignmentState> {
  return implementation
    ? implementation(assignmentId)
    : parseAssignmentState(await readMarketplaceState("get_assignment", [assignmentId]));
}

async function readCampaign(
  campaignId: string,
  implementation?: (campaignId: string) => Promise<GenLayerCampaignState>,
): Promise<GenLayerCampaignState> {
  return implementation
    ? implementation(campaignId)
    : parseCampaignState(await readMarketplaceState("get_campaign", [campaignId]));
}

function assertOperatorProjectionBinding(
  operation: GenLayerOperatorProjection,
  expectedAction: GenLayerOperatorAction,
): void {
  if (
    operation.action !== expectedAction ||
    operation.functionName !== expectedAction ||
    operation.valueAtto !== "0" ||
    operation.contractAddress !== marketplaceContractAddress()
  ) {
    throw new GenLayerProgressionPoisonError(
      "The operator response is not bound to the expected V2 zero-value action.",
    );
  }
}

function assertResolutionBinding(
  projected: GenLayerAssignmentProjection,
  authoritative: GenLayerAssignmentState,
  requestId: string,
): void {
  if (
    projected.assignmentId !== authoritative.assignmentId ||
    projected.campaignId !== authoritative.campaignId ||
    projected.contentSource !== authoritative.contentSource ||
    projected.creatorWallet !== authoritative.creator ||
    projected.creatorIdentityHash !== authoritative.creatorIdentityHash ||
    projected.applicationId !== authoritative.applicationId ||
    projected.agreementHash !== authoritative.agreementHash ||
    projected.resolutionRequestId !== requestId
  ) {
    throw new GenLayerProgressionPoisonError(
      "The authoritative StudioNet resolution binding changed.",
    );
  }
}

function assertAssignmentCandidateBinding(
  candidate: GenLayerAssignmentExpiryCandidate,
  assignment: GenLayerAssignmentState,
  campaign: GenLayerCampaignState,
): void {
  if (
    candidate.assignment.assignmentId !== assignment.assignmentId ||
    candidate.assignment.campaignId !== assignment.campaignId ||
    candidate.assignment.campaignId !== campaign.campaignId ||
    candidate.assignment.creatorWallet !== assignment.creator ||
    candidate.assignment.creatorIdentityHash !== assignment.creatorIdentityHash ||
    candidate.assignment.contentSource !== assignment.contentSource ||
    candidate.assignment.applicationId !== assignment.applicationId ||
    candidate.assignment.agreementHash !== assignment.agreementHash ||
    candidate.campaign.brandWallet !== campaign.brand ||
    candidate.campaign.contentSource !== campaign.contentSource ||
    candidate.campaign.termsHash !== campaign.termsHash
  ) {
    throw new GenLayerProgressionPoisonError(
      "The authoritative StudioNet assignment expiry binding changed.",
    );
  }
}

function assertCampaignCandidateBinding(
  candidate: GenLayerCampaignProjection,
  campaign: GenLayerCampaignState,
): void {
  if (
    candidate.campaignId !== campaign.campaignId ||
    candidate.brandWallet !== campaign.brand ||
    candidate.clientNonce !== campaign.clientNonce ||
    candidate.contentSource !== campaign.contentSource ||
    candidate.termsHash !== campaign.termsHash ||
    candidate.budgetAtto !== campaign.budgetAtto ||
    candidate.submissionDeadlineEpoch !== campaign.submissionDeadlineEpoch ||
    candidate.retentionSeconds !== campaign.retentionSeconds
  ) {
    throw new GenLayerProgressionPoisonError(
      "The authoritative StudioNet campaign finalization binding changed.",
    );
  }
}

export function genLayerProgressionRequestIsAuthorized(
  request: Request,
  secret: string,
): boolean {
  if (Buffer.byteLength(secret, "utf8") < 32) return false;
  const provided = request.headers.get("authorization");
  if (!provided) return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(provided, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class GenLayerProgressionRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenLayerProgressionRetryError";
  }
}

export class GenLayerProgressionPoisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenLayerProgressionPoisonError";
  }
}

export class GenLayerProgressionConfigurationError extends Error {
  constructor() {
    super("Automatic StudioNet progression is not configured.");
    this.name = "GenLayerProgressionConfigurationError";
  }
}

export function genLayerProgressionRetryDelaySeconds(deliveryCount: number): number {
  if (!Number.isSafeInteger(deliveryCount) || deliveryCount < 1) return 60;
  return Math.min(15 * 60, 60 * 2 ** Math.min(deliveryCount - 1, 4));
}
