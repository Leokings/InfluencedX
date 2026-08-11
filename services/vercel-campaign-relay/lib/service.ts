import type { Hex } from "viem";
import type { RelayConfig } from "./config";
import {
  createBaseSettlementTransport,
  type BaseSettlementTransport,
} from "./base-settlement";
import { RelayProblem } from "./problem";
import { verifyWatcherQuorum } from "./quorum";
import {
  independentlyResolveCampaign,
  type RevalidationDependencies,
} from "./revalidation";
import {
  createResolutionRepository,
  type ResolutionRepository,
} from "./repository";
import type { ResolutionOutcome, WatcherSignature } from "./types";
import {
  buildWatcherRequest,
  requestWatcherSignatures,
} from "./watcher-client";

export type RelayServiceDependencies = Readonly<{
  repository?: ResolutionRepository;
  transport?: BaseSettlementTransport;
  requestSignatures?: (input: {
    request: ReturnType<typeof buildWatcherRequest>;
    config: RelayConfig;
  }) => Promise<readonly WatcherSignature[]>;
  revalidate?: typeof independentlyResolveCampaign;
  revalidationDependencies?: RevalidationDependencies;
  nowMs?: () => number;
}>;

export async function settleFinalizedCampaignResolution(input: {
  requestId: Hex;
  config: RelayConfig;
  dependencies?: RelayServiceDependencies;
}): Promise<Readonly<{
  requestId: Hex;
  status: "CONFIRMED" | "SIMULATED";
  broadcast: boolean;
  txHash: Hex | null;
  outcome: ResolutionOutcome;
}>> {
  const dependencies = input.dependencies ?? {};
  const repository = dependencies.repository ?? createResolutionRepository(input.config);
  const transport = dependencies.transport ?? createBaseSettlementTransport(input.config);
  const now = dependencies.nowMs ?? Date.now;
  const claim = await repository.claim(input.requestId, now());
  if (claim.kind === "CONFIRMED") {
    return Object.freeze({
      requestId: input.requestId,
      status: "CONFIRMED",
      broadcast: true,
      txHash: claim.job.baseTxHash,
      outcome: claim.job.expectedOutcome,
    });
  }
  const { context, fenceToken } = claim.value;
  const watcherRequest = buildWatcherRequest(context, input.config.escrow);
  let phase: "PREBROADCAST" | "BROADCAST" | "RECEIPT" = "PREBROADCAST";
  let txHash: Hex | null = null;
  try {
    const responses = await (dependencies.requestSignatures ?? requestWatcherSignatures)({
      request: watcherRequest,
      config: input.config,
    });
    const revalidated = await (dependencies.revalidate ?? independentlyResolveCampaign)({
      request: watcherRequest,
      config: input.config,
      dependencies: dependencies.revalidationDependencies,
    });
    if (revalidated.alreadyUsed) {
      await repository.markReconciliation({
        requestId: input.requestId,
        fenceToken,
        errorCode: "REQUEST_ALREADY_USED",
        nowMs: now(),
      });
      throw new RelayProblem(409, "RECONCILIATION_REQUIRED", "The Base request was consumed outside this fenced relay job.");
    }
    const quorum = await verifyWatcherQuorum({
      responses,
      context,
      independentMessage: revalidated.message,
      enabledWatchers: revalidated.enabledWatchers,
      threshold: revalidated.threshold,
      config: input.config,
      nowEpoch: Math.floor(now() / 1_000),
    });
    await repository.recordQuorum({
      requestId: input.requestId,
      fenceToken,
      digest: quorum.digest,
      signers: quorum.signers,
      evidenceHash: quorum.message.evidenceHash,
      resolvedAt: Number(quorum.message.resolvedAt) * 1_000,
      relayDeadline: Number(quorum.message.relayDeadline) * 1_000,
      nowMs: now(),
    });
    const prepared = await transport.simulate(quorum, context.expectedOutcome);
    await repository.recordSimulated({ requestId: input.requestId, fenceToken, nowMs: now() });
    if (!input.config.broadcastEnabled) {
      return Object.freeze({ requestId: input.requestId, status: "SIMULATED", broadcast: false, txHash: null, outcome: context.expectedOutcome });
    }

    await repository.markBroadcasting({ requestId: input.requestId, fenceToken, nowMs: now() });
    phase = "BROADCAST";
    try { txHash = await transport.broadcast(prepared); }
    catch {
      await repository.markReconciliation({ requestId: input.requestId, fenceToken, errorCode: "BROADCAST_RESULT_UNKNOWN", nowMs: now() });
      throw new RelayProblem(409, "RECONCILIATION_REQUIRED", "Base broadcast returned no trustworthy transaction hash.");
    }
    try {
      await repository.recordBroadcastHash({ requestId: input.requestId, fenceToken, txHash, nowMs: now() });
    } catch {
      await repository.markReconciliation({
        requestId: input.requestId,
        fenceToken,
        errorCode: "BROADCAST_HASH_PERSIST_FAILED",
        txHash,
        nowMs: now(),
      }).catch(() => undefined);
      throw new RelayProblem(
        409,
        "RECONCILIATION_REQUIRED",
        "Base returned a transaction hash that could not be durably fenced.",
      );
    }
    phase = "RECEIPT";
    let receipt;
    try { receipt = await transport.waitAndVerify(prepared, txHash); }
    catch (error) {
      if (error instanceof RelayProblem && error.code === "BASE_TRANSACTION_REVERTED") {
        await repository.markFailed({ requestId: input.requestId, fenceToken, errorCode: error.code, nowMs: now() });
      } else {
        await repository.markReconciliation({ requestId: input.requestId, fenceToken, errorCode: errorCode(error), txHash, nowMs: now() });
      }
      throw error;
    }
    try {
      await repository.recordConfirmed({
        requestId: input.requestId,
        fenceToken,
        txHash,
        blockNumber: receipt.blockNumber,
        outcome: context.expectedOutcome,
        evidenceHash: quorum.message.evidenceHash,
        nowMs: now(),
      });
    } catch (error) {
      await repository.markReconciliation({ requestId: input.requestId, fenceToken, errorCode: "MIRROR_RECONCILIATION_REQUIRED", txHash, nowMs: now() }).catch(() => undefined);
      throw error;
    }
    return Object.freeze({ requestId: input.requestId, status: "CONFIRMED", broadcast: true, txHash, outcome: context.expectedOutcome });
  } catch (error) {
    if (phase === "PREBROADCAST" && !(error instanceof RelayProblem && ["RECONCILIATION_REQUIRED", "RELAY_FENCE_LOST"].includes(error.code))) {
      const retryable = error instanceof RelayProblem && error.retryable;
      const mutation = retryable ? repository.markRetryable.bind(repository) : repository.markFailed.bind(repository);
      await mutation({ requestId: input.requestId, fenceToken, errorCode: errorCode(error), nowMs: now() }).catch(() => undefined);
    }
    throw error;
  }
}

function errorCode(error: unknown): string {
  const code = error instanceof RelayProblem ? error.code : "RELAY_FAILED";
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : "RELAY_FAILED";
}
