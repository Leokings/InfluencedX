import {
  confirmGenLayerAccept,
  confirmGenLayerApplication,
  confirmGenLayerApplicationWithdrawal,
  confirmGenLayerCampaignCancel,
  confirmGenLayerDecline,
  confirmGenLayerRefundUnallocated,
  confirmGenLayerRefundUndetermined,
  confirmGenLayerResolution,
  confirmGenLayerSelection,
  confirmGenLayerSubmission,
  confirmGenLayerWithdrawal,
  confirmGenLayerWithdrawalExecution,
} from "./marketplace-genlayer-actions.ts";
import { reconcileGenLayerCreatorActivationJournal } from "./marketplace-genlayer-activation.ts";
import {
  MAX_GENLAYER_RECONCILIATION_ATTEMPTS,
  claimDueGenLayerReconciliation,
  exactGenLayerJournalCall,
  findGenLayerPreparedTransaction,
  recordGenLayerTransactionStatus,
  type GenLayerTransactionRow,
} from "./marketplace-genlayer-repository.ts";
import {
  MarketplaceGenLayerFinalityError,
  assertTransactionMatchesPreparedCall,
  loadFinalizedMarketplaceTransaction,
  terminalMarketplaceTransactionStatus,
} from "./marketplace-genlayer-rpc.ts";
import { confirmGenLayerCampaignFunding } from "./marketplace-genlayer-service.ts";
import { ApiProblem } from "./verification-api.ts";
import type { AuthenticatedWalletSession } from "./wallet-session.ts";

const JOURNAL_LEASE_MS = 4 * 60_000;
const MAX_BATCH_SIZE = 25;
const JOURNAL_SUBJECT = "A".repeat(43);

type JournalClaim = GenLayerTransactionRow & { fenceToken: string };

export type GenLayerJournalDependencies = Readonly<{
  claim?: typeof claimDueGenLayerReconciliation;
  find?: typeof findGenLayerPreparedTransaction;
  record?: typeof recordGenLayerTransactionStatus;
  loadFinalized?: typeof loadFinalizedMarketplaceTransaction;
  dispatch?: typeof dispatchGenLayerJournalClaim;
}>;

/**
 * Claims a bounded set of durable direct-write journals. Each claim is fenced,
 * revalidates the exact stored call against its finalized receipt, and projects
 * authoritative state before FINALIZED becomes absorbing.
 */
export async function runGenLayerJournalReconciliationBatch(options: {
  nowMs?: number;
  limit?: number;
  dependencies?: GenLayerJournalDependencies;
} = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const limit = options.limit ?? 8;
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("The GenLayer journal reconciliation clock is invalid.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    throw new Error("The GenLayer journal reconciliation limit is invalid.");
  }
  const dependencies = options.dependencies ?? {};
  const claim = dependencies.claim ?? claimDueGenLayerReconciliation;
  let claimed = 0;
  let finalized = 0;
  let retryScheduled = 0;
  let terminal = 0;
  let manual = 0;

  while (claimed < limit) {
    const row = await claim({
      nowMs,
      leaseMs: JOURNAL_LEASE_MS,
      maxAttempts: MAX_GENLAYER_RECONCILIATION_ATTEMPTS,
    });
    if (!row) break;
    claimed += 1;
    try {
      await (dependencies.dispatch ?? dispatchGenLayerJournalClaim)(row, {
        nowMs,
        loadFinalized: dependencies.loadFinalized,
      });
      const current = await (dependencies.find ?? findGenLayerPreparedTransaction)(
        row.preparedId,
      );
      if (current?.status !== "FINALIZED") {
        throw new GenLayerJournalRetryError(
          "The direct-write journal did not reach its absorbing final state.",
        );
      }
      finalized += 1;
    } catch (error) {
      const current = await (dependencies.find ?? findGenLayerPreparedTransaction)(
        row.preparedId,
      );
      if (current?.status === "FINALIZED") {
        finalized += 1;
        continue;
      }
      if (current?.fenceToken !== row.fenceToken) {
        if (current?.status === "ACCEPTED") retryScheduled += 1;
        else manual += 1;
        continue;
      }
      const retryable = journalErrorIsRetryable(error);
      const terminalStatus = terminalMarketplaceTransactionStatus(error);
      const recorded = await (dependencies.record ?? recordGenLayerTransactionStatus)({
        preparedId: row.preparedId,
        status: terminalStatus ?? (retryable ? "ACCEPTED" : "RECONCILIATION_REQUIRED"),
        lifecycleStatus: null,
        executionResult: null,
        errorCode: journalErrorCode(error),
        retryAtMs: retryable
          ? nowMs + journalRetryDelayMs(row.reconciliationAttempts)
          : 0,
        nowMs,
        fenceToken: row.fenceToken,
      });
      if (recorded?.status === "FINALIZED") finalized += 1;
      else if (recorded?.status === "EXECUTION_FAILED" || recorded?.status === "NETWORK_TERMINATED") terminal += 1;
      else if (retryable) retryScheduled += 1;
      else manual += 1;
    }
  }

  return Object.freeze({
    claimed,
    finalized,
    retryScheduled,
    terminal,
    manual,
    capped: claimed === limit,
  });
}

/**
 * Dispatches from the claimed DB row only. Queue messages contain no call,
 * actor, campaign, application, value, or transaction-hash authority.
 */
export async function dispatchGenLayerJournalClaim(
  row: JournalClaim,
  options: {
    nowMs?: number;
    loadFinalized?: typeof loadFinalizedMarketplaceTransaction;
  } = {},
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  if (
    !row.transactionHash ||
    !row.fenceToken ||
    !["SUBMITTED", "ACCEPTED", "RECONCILIATION_REQUIRED"].includes(row.status)
  ) {
    throw new GenLayerJournalPoisonError("The claimed journal binding is incomplete.");
  }
  const call = exactGenLayerJournalCall(row);
  const finalized = await (options.loadFinalized ?? loadFinalizedMarketplaceTransaction)(
    row.transactionHash,
  );
  try {
    assertTransactionMatchesPreparedCall({
      transaction: finalized,
      call,
      actorWallet: row.actorWallet,
    });
  } catch {
    throw new GenLayerJournalPoisonError(
      "The finalized transaction does not match the immutable journal call.",
    );
  }

  const session = journalSession(row.actorWallet, nowMs);
  const body = { preparedId: row.preparedId, txHash: row.transactionHash };
  if (
    row.operation === "ACTIVATE_CREATOR" ||
    row.operation === "ACTIVATE_IDENTITY_BUNDLE"
  ) {
    await reconcileGenLayerCreatorActivationJournal({
      preparedId: row.preparedId,
      transactionHash: row.transactionHash,
      actorWallet: row.actorWallet,
      fenceToken: row.fenceToken,
      nowMs,
    });
    return;
  }
  const campaignId = requiredLocalId(row.localCampaignId, "campaign");
  const common = {
    campaignId,
    session,
    body,
    reconciliationFenceToken: row.fenceToken,
  };

  switch (row.operation) {
    case "CREATE_CAMPAIGN":
      await confirmGenLayerCampaignFunding({ ...common, nowMs });
      return;
    case "APPLY":
      await confirmGenLayerApplication({
        ...common,
        applicationId: requiredLocalId(row.localApplicationId, "application"),
      });
      return;
    case "WITHDRAW_APPLICATION":
      await confirmGenLayerApplicationWithdrawal(applicationInput(row, common));
      return;
    case "SELECT_CREATOR":
      await confirmGenLayerSelection(applicationInput(row, common));
      return;
    case "ACCEPT_ASSIGNMENT":
      await confirmGenLayerAccept(applicationInput(row, common));
      return;
    case "DECLINE_ASSIGNMENT":
      await confirmGenLayerDecline(applicationInput(row, common));
      return;
    case "SUBMIT_EVIDENCE":
      await confirmGenLayerSubmission(applicationInput(row, common));
      return;
    case "RESOLVE_ASSIGNMENT":
      await confirmGenLayerResolution(applicationInput(row, common));
      return;
    case "REFUND_UNDETERMINED":
      await confirmGenLayerRefundUndetermined(applicationInput(row, common));
      return;
    case "REFUND_UNALLOCATED":
      await confirmGenLayerRefundUnallocated(common);
      return;
    case "CANCEL_CAMPAIGN":
      await confirmGenLayerCampaignCancel(common);
      return;
    case "REQUEST_WITHDRAWAL":
      await confirmGenLayerWithdrawal(common);
      return;
    case "EXECUTE_WITHDRAWAL":
      await confirmGenLayerWithdrawalExecution(common);
      return;
    case "EXPIRE_ASSIGNMENT":
    case "FINALIZE_CAMPAIGN":
    case "RECAPITALIZE_FAILED_WITHDRAWAL":
      throw new GenLayerJournalPoisonError(
        "This journal operation is not a user-signed direct-write action.",
      );
  }
}

function applicationInput(
  row: JournalClaim,
  common: {
    campaignId: string;
    session: AuthenticatedWalletSession;
    body: Record<string, unknown>;
    reconciliationFenceToken: string;
  },
) {
  return {
    ...common,
    applicationId: requiredLocalId(row.localApplicationId, "application"),
  };
}

function journalSession(wallet: string, nowMs: number): AuthenticatedWalletSession {
  const nowEpoch = Math.floor(nowMs / 1_000);
  return Object.freeze({
    version: 1,
    subject: JOURNAL_SUBJECT,
    stage: "authenticated",
    wallet,
    issuedAt: nowEpoch,
    expiresAt: nowEpoch + 15 * 60,
  });
}

function requiredLocalId(value: string | null, label: string): string {
  if (!value) {
    throw new GenLayerJournalPoisonError(
      `The direct-write journal has no ${label} binding.`,
    );
  }
  return value;
}

function journalErrorIsRetryable(error: unknown): boolean {
  return (
    (error instanceof MarketplaceGenLayerFinalityError && error.retryable) ||
    error instanceof GenLayerJournalRetryError ||
    (error instanceof ApiProblem && (error.status === 202 || error.status >= 500))
  );
}

function journalErrorCode(error: unknown): string {
  const value =
    error instanceof MarketplaceGenLayerFinalityError || error instanceof ApiProblem
      ? error.code
      : error instanceof GenLayerJournalPoisonError
        ? "GENLAYER_JOURNAL_POISONED"
        : error instanceof GenLayerJournalRetryError
          ? "GENLAYER_JOURNAL_RETRY_REQUIRED"
          : "GENLAYER_JOURNAL_RECONCILIATION_FAILED";
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(value)
    ? value
    : "GENLAYER_JOURNAL_RECONCILIATION_FAILED";
}

export function journalRetryDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) return 60_000;
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.min(attempt - 1, 6));
}

export class GenLayerJournalRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenLayerJournalRetryError";
  }
}

export class GenLayerJournalPoisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenLayerJournalPoisonError";
  }
}
