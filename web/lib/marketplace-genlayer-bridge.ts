import {
  BradburySubmitterProblem,
  createBradburySubmitterClient,
  loadBradburySubmitterConfig,
} from "./bradbury-submitter-client.ts";
import {
  buildCampaignSubmissionEnvelope,
  type CampaignSubmitterSubmission,
} from "./campaign-submission.ts";
import {
  findApplication,
  findCampaign,
  findMarketplaceResolutionContextByRequestId,
  recordGenLayerSubmissionProjection,
} from "./marketplace-repository.ts";
import { readVerifiedMarketplaceCampaignBinding } from "./marketplace-resolution-binding.ts";
import { ApiProblem } from "./verification-api.ts";
import type { AuthenticatedWalletSession } from "./wallet-session.ts";
import {
  CampaignRelayClientProblem,
  createCampaignRelayClient,
  loadCampaignRelayConfig,
  type CampaignRelayResult,
} from "./campaign-relay-client.ts";

export async function advanceMarketplaceGenLayerResolution(input: {
  campaignId: string;
  applicationId: string;
  session: AuthenticatedWalletSession;
  nowMs?: number;
}): Promise<{
  submission: CampaignSubmitterSubmission;
  settlement: CampaignRelayResult | null;
}> {
  const nowMs = input.nowMs ?? Date.now();
  const context = await authorizedResolutionContext(input);
  const requestId = requiredHash(context.application.requestId, "requestId");
  const config = await loadBradburySubmitterConfig();
  const client = createBradburySubmitterClient(config);

  let remote: CampaignSubmitterSubmission | null;
  if (context.application.genlayerSubmitterStatus === null) {
    const binding = await readVerifiedMarketplaceCampaignBinding({
      context,
      nowEpoch: Math.floor(nowMs / 1_000),
    });
    const envelope = buildCampaignSubmissionEnvelope({
      ...binding,
      assignmentId: binding.assignmentId,
      nowEpoch: Math.floor(nowMs / 1_000),
    });
    try {
      remote = (await client.submitCampaign(envelope)).submission;
    } catch (error) {
      throw bridgeFailure(error);
    }
  } else {
    try {
      remote = await client.campaignStatus(requestId);
    } catch (error) {
      throw bridgeFailure(error);
    }
    if (!remote) {
      throw new ApiProblem(
        503,
        "GENLAYER_SUBMISSION_MISSING",
        "The durable GenLayer submission cannot currently be found.",
      );
    }
  }
  if (remote.requestId !== requestId || remote.functionName !== "resolve_submission") {
    throw new ApiProblem(
      502,
      "GENLAYER_SUBMITTER_MISMATCH",
      "The GenLayer submitter returned another campaign job.",
    );
  }
  await recordGenLayerSubmissionProjection({
    applicationId: context.application.id,
    requestId,
    status: remote.status,
    txHash: remote.txHash,
    resultOutcome: remote.resultOutcome,
    lifecycleStatus: remote.lifecycleStatus,
    executionResult: remote.executionResult,
    errorCode: remote.errorCode,
    submittedAt: timestampMs(remote.submittedAt),
    finalizedAt: timestampMs(remote.finalizedAt),
    nowMs,
  });
  let settlement: CampaignRelayResult | null = null;
  if (remote.status === "FINALIZED" && remote.resultOutcome !== null) {
    const relayConfig = await loadCampaignRelayConfig();
    if (relayConfig) {
      try {
        settlement = await createCampaignRelayClient(relayConfig).settle(requestId);
      } catch (error) {
        throw relayFailure(error);
      }
      if (settlement.outcome !== remote.resultOutcome) {
        throw new ApiProblem(
          502,
          "BASE_RELAY_OUTCOME_MISMATCH",
          "The Base relay returned another finalized GenLayer outcome.",
        );
      }
    }
  }
  return Object.freeze({ submission: remote, settlement });
}

async function authorizedResolutionContext(input: {
  campaignId: string;
  applicationId: string;
  session: AuthenticatedWalletSession;
}) {
  if (!uuid(input.campaignId) || !uuid(input.applicationId)) {
    throw new ApiProblem(400, "INVALID_REQUEST", "Campaign or application ID is invalid.");
  }
  const [campaign, application] = await Promise.all([
    findCampaign(input.campaignId),
    findApplication(input.campaignId, input.applicationId),
  ]);
  if (!campaign || !application) {
    throw new ApiProblem(404, "RESOLUTION_NOT_FOUND", "Campaign resolution not found.");
  }
  if (
    input.session.wallet !== campaign.brandWallet &&
    input.session.wallet !== application.creatorWallet
  ) {
    throw new ApiProblem(
      403,
      "CAMPAIGN_PARTICIPANT_REQUIRED",
      "Only the campaign brand or accepted creator can advance resolution.",
    );
  }
  const requestId = requiredHash(application.requestId, "requestId");
  const exact = await findMarketplaceResolutionContextByRequestId(requestId);
  if (
    !exact ||
    exact.campaign.id !== campaign.id ||
    exact.application.id !== application.id
  ) {
    throw new ApiProblem(
      409,
      "RESOLUTION_NOT_READY",
      "The persisted campaign is not awaiting GenLayer resolution.",
    );
  }
  return exact;
}

function bridgeFailure(error: unknown): ApiProblem {
  if (error instanceof BradburySubmitterProblem) {
    return new ApiProblem(
      503,
      error.ambiguous
        ? "GENLAYER_SUBMISSION_OUTCOME_UNKNOWN"
        : error.code,
      error.ambiguous
        ? "The submission outcome is unknown; retrying this exact request is safe."
        : error.message,
    );
  }
  return new ApiProblem(
    503,
    "GENLAYER_SUBMITTER_UNAVAILABLE",
    "GenLayer campaign resolution is temporarily unavailable.",
  );
}

function relayFailure(error: unknown): ApiProblem {
  if (error instanceof CampaignRelayClientProblem) {
    return new ApiProblem(
      503,
      error.ambiguous ? "BASE_RELAY_OUTCOME_UNKNOWN" : error.code,
      error.ambiguous
        ? "Base settlement may be in progress; retry this exact request to reconcile it."
        : error.message,
    );
  }
  return new ApiProblem(
    503,
    "BASE_RELAY_UNAVAILABLE",
    "Automatic Base settlement is temporarily unavailable.",
  );
}

function requiredHash(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Persisted ${label} is invalid.`);
  }
  return value as `0x${string}`;
}

function timestampMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("The GenLayer submitter timestamp is invalid.");
  }
  return parsed;
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
