import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  isNotNull,
  lt,
  lte,
  or,
  sql,
  type InferSelectModel,
} from "drizzle-orm";
import { getDb } from "../db/index.ts";
import {
  marketplaceGenLayerApplicationsPrivate,
  marketplaceGenLayerAssignments,
  marketplaceGenLayerCampaignDrafts,
  marketplaceGenLayerCampaigns,
  marketplaceGenLayerClaimableBalances,
  marketplaceGenLayerProfiles,
  marketplaceGenLayerProjectionCursors,
  marketplaceGenLayerTransactions,
  marketplaceGenLayerWithdrawals,
  type MarketplaceGenLayerOperation,
  type MarketplaceGenLayerTransactionStatus,
  type MarketplaceResolutionOutcome,
} from "../db/postgres-schema.ts";
import {
  MARKETPLACE_GENLAYER_CHAIN_ID,
  MARKETPLACE_GENLAYER_ARG_TYPES,
  MARKETPLACE_GENLAYER_NETWORK,
  canonicalHash,
  marketplaceContractAddress,
  marketplaceRpcContractAddress,
  marketplaceContractVersion,
  type MarketplaceGenLayerCall,
} from "./marketplace-genlayer-rpc.ts";
import {
  deriveProjectionId,
  type GenLayerCampaignState,
  type GenLayerClaimableState,
  type GenLayerContentSource,
} from "./marketplace-genlayer-core.ts";
import { enqueueMarketplaceMaintenanceHeartbeat } from "./marketplace-genlayer-maintenance-queue.ts";
import { ApiProblem } from "./verification-api.ts";

export type GenLayerCampaignProjection = InferSelectModel<
  typeof marketplaceGenLayerCampaigns
>;
export type GenLayerCampaignDraft = InferSelectModel<
  typeof marketplaceGenLayerCampaignDrafts
>;
export type GenLayerPrivateApplication = InferSelectModel<
  typeof marketplaceGenLayerApplicationsPrivate
>;
export type GenLayerAssignmentProjection = InferSelectModel<
  typeof marketplaceGenLayerAssignments
>;
export type GenLayerTransactionRow = InferSelectModel<
  typeof marketplaceGenLayerTransactions
>;
export type GenLayerClaimableBalance = InferSelectModel<
  typeof marketplaceGenLayerClaimableBalances
>;
export type GenLayerWithdrawalProjection = InferSelectModel<
  typeof marketplaceGenLayerWithdrawals
>;

export type PreparedMarketplaceTransaction = Readonly<{
  preparedId: string;
  operation: MarketplaceGenLayerOperation;
  call: MarketplaceGenLayerCall;
  recovery: Readonly<{
    preparedId: string;
    transactionHash: string;
  }> | null;
}>;

export const MAX_GENLAYER_RECONCILIATION_ATTEMPTS = 12;

export async function nextGenLayerSharedObservationTicket(): Promise<number> {
  const result = await getDb().execute(sql`
    select nextval('marketplace_genlayer_shared_observation_ticket_seq')::bigint as observation_ticket
  `);
  const raw = firstRawRow(result)?.observation_ticket;
  const ticket = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(ticket) || ticket <= 0) {
    throw new Error("The shared observation ticket is invalid.");
  }
  return ticket;
}

export async function insertGenLayerCampaignDraft(input: {
  id?: string;
  brandWallet: string;
  brandName: string;
  contentSource: GenLayerContentSource;
  title: string;
  description: string;
  category: string;
  format: string;
  deliverables: string[];
  requiredPhrases: string[];
  forbiddenPhrases: string[];
  requireAdDisclosure: boolean;
  semanticBrief: string;
  termsDocument: Record<string, unknown>;
  termsHash: string;
  clientNonce: string;
  budgetAtto: string;
  applicationDeadlineAt: number;
  selectionDeadlineAt: number;
  submissionDeadlineAt: number;
  retentionSeconds: number;
  maxUndeterminedRetries: number;
  nowMs?: number;
}): Promise<GenLayerCampaignDraft> {
  const nowMs = input.nowMs ?? Date.now();
  const [row] = await getDb()
    .insert(marketplaceGenLayerCampaignDrafts)
    .values({
      ...input,
      id: input.id ?? randomUUID(),
      brandWallet: normalizeAddress(input.brandWallet),
      status: "FUNDING",
      revision: 0,
      createdAt: nowMs,
      updatedAt: nowMs,
    })
    .returning();
  if (!row) throw new Error("GenLayer campaign draft insertion returned no row.");
  return row;
}

export async function findGenLayerCampaignDraft(
  id: string,
): Promise<GenLayerCampaignDraft | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceGenLayerCampaignDrafts)
    .where(eq(marketplaceGenLayerCampaignDrafts.id, id))
    .limit(1);
  return row ?? null;
}

export async function listGenLayerCampaignDraftRows(input: {
  viewerWallet?: string | null;
  limit?: number;
} = {}): Promise<
  Array<{
    draft: GenLayerCampaignDraft;
    projection: GenLayerCampaignProjection | null;
    applicationCount: number;
  }>
> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 100));
  const rows = await getDb()
    .select({
      draft: marketplaceGenLayerCampaignDrafts,
      projection: marketplaceGenLayerCampaigns,
    })
    .from(marketplaceGenLayerCampaignDrafts)
    .leftJoin(
      marketplaceGenLayerCampaigns,
      eq(
        marketplaceGenLayerCampaigns.localCampaignId,
        marketplaceGenLayerCampaignDrafts.id,
      ),
    )
    .where(
      input.viewerWallet
        ? or(
            eq(
              marketplaceGenLayerCampaignDrafts.brandWallet,
              normalizeAddress(input.viewerWallet),
            ),
            inArray(marketplaceGenLayerCampaignDrafts.status, [
              "OPEN",
              "CANCELLED",
              "CLOSED",
            ]),
          )
        : inArray(marketplaceGenLayerCampaignDrafts.status, [
            "OPEN",
            "CANCELLED",
            "CLOSED",
          ]),
    )
    .orderBy(desc(marketplaceGenLayerCampaignDrafts.createdAt))
    .limit(limit);
  const campaignIds = rows.map(({ draft }) => draft.id);
  const countRows = campaignIds.length
    ? await getDb()
        .select({
          campaignId: marketplaceGenLayerApplicationsPrivate.localCampaignId,
          count: sql<number>`count(*)::int`,
        })
        .from(marketplaceGenLayerApplicationsPrivate)
        .where(
          inArray(
            marketplaceGenLayerApplicationsPrivate.localCampaignId,
            campaignIds,
          ),
        )
        .groupBy(marketplaceGenLayerApplicationsPrivate.localCampaignId)
    : [];
  const counts = new Map(countRows.map((row) => [row.campaignId, row.count]));
  return rows.map((row) => ({
    draft: row.draft,
    projection: row.projection,
    applicationCount: counts.get(row.draft.id) ?? 0,
  }));
}

export async function listGenLayerPrivateApplicationsForCampaign(
  localCampaignId: string,
): Promise<GenLayerPrivateApplication[]> {
  return getDb()
    .select()
    .from(marketplaceGenLayerApplicationsPrivate)
    .where(
      eq(
        marketplaceGenLayerApplicationsPrivate.localCampaignId,
        localCampaignId,
      ),
    )
    .orderBy(desc(marketplaceGenLayerApplicationsPrivate.createdAt));
}

export async function setGenLayerCampaignDraftStatus(input: {
  id: string;
  expectedStatus: GenLayerCampaignDraft["status"];
  status: GenLayerCampaignDraft["status"];
  nowMs?: number;
}): Promise<boolean> {
  const nowMs = input.nowMs ?? Date.now();
  const [row] = await getDb()
    .update(marketplaceGenLayerCampaignDrafts)
    .set({
      status: input.status,
      revision: sql`${marketplaceGenLayerCampaignDrafts.revision} + 1`,
      updatedAt: nowMs,
    })
    .where(
      and(
        eq(marketplaceGenLayerCampaignDrafts.id, input.id),
        eq(marketplaceGenLayerCampaignDrafts.status, input.expectedStatus),
      ),
    )
    .returning({ id: marketplaceGenLayerCampaignDrafts.id });
  return row?.id === input.id;
}

export async function findGenLayerProfileByWallet(
  wallet: string,
  source: GenLayerContentSource,
): Promise<InferSelectModel<typeof marketplaceGenLayerProfiles> | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceGenLayerProfiles)
    .where(
      and(
        eq(marketplaceGenLayerProfiles.network, MARKETPLACE_GENLAYER_NETWORK),
        eq(marketplaceGenLayerProfiles.chainId, MARKETPLACE_GENLAYER_CHAIN_ID),
        eq(marketplaceGenLayerProfiles.contractAddress, marketplaceContractAddress()),
        eq(marketplaceGenLayerProfiles.ownerWallet, normalizeAddress(wallet)),
        eq(marketplaceGenLayerProfiles.source, source),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertGenLayerPrivateApplication(input: {
  id?: string;
  localCampaignId: string;
  creatorProfileProjectionId: string;
  creatorWallet: string;
  requestedRateAtto: string;
  pitch: string;
  pitchCommitment: string;
  nowMs?: number;
}): Promise<GenLayerPrivateApplication> {
  const nowMs = input.nowMs ?? Date.now();
  const [row] = await getDb()
    .insert(marketplaceGenLayerApplicationsPrivate)
    .values({
      ...input,
      id: input.id ?? randomUUID(),
      creatorWallet: normalizeAddress(input.creatorWallet),
      status: "PENDING_ONCHAIN",
      revision: 0,
      createdAt: nowMs,
      updatedAt: nowMs,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const existing = await findGenLayerPrivateApplicationForCreator(
    input.localCampaignId,
    input.creatorWallet,
  );
  if (!existing || existing.pitchCommitment !== input.pitchCommitment) {
    throw new Error("A different application already exists for this campaign.");
  }
  return existing;
}

export async function findGenLayerPrivateApplication(
  id: string,
): Promise<GenLayerPrivateApplication | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceGenLayerApplicationsPrivate)
    .where(eq(marketplaceGenLayerApplicationsPrivate.id, id))
    .limit(1);
  return row ?? null;
}

export async function findGenLayerPrivateApplicationForCreator(
  localCampaignId: string,
  creatorWallet: string,
): Promise<GenLayerPrivateApplication | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceGenLayerApplicationsPrivate)
    .where(
      and(
        eq(
          marketplaceGenLayerApplicationsPrivate.localCampaignId,
          localCampaignId,
        ),
        eq(
          marketplaceGenLayerApplicationsPrivate.creatorWallet,
          normalizeAddress(creatorWallet),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function setGenLayerPrivateApplicationStatus(input: {
  id: string;
  status: GenLayerPrivateApplication["status"];
  expectedStatuses: GenLayerPrivateApplication["status"][];
  nowMs?: number;
}): Promise<boolean> {
  const nowMs = input.nowMs ?? Date.now();
  const [row] = await getDb()
    .update(marketplaceGenLayerApplicationsPrivate)
    .set({
      status: input.status,
      revision: sql`${marketplaceGenLayerApplicationsPrivate.revision} + 1`,
      updatedAt: nowMs,
    })
    .where(
      and(
        eq(marketplaceGenLayerApplicationsPrivate.id, input.id),
        inArray(
          marketplaceGenLayerApplicationsPrivate.status,
          input.expectedStatuses,
        ),
      ),
    )
    .returning({ id: marketplaceGenLayerApplicationsPrivate.id });
  return row?.id === input.id;
}

export async function prepareGenLayerMarketplaceTransaction(input: {
  preparedId?: string;
  operation: MarketplaceGenLayerOperation;
  call: MarketplaceGenLayerCall;
  actorWallet: string;
  localCampaignId?: string | null;
  localApplicationId?: string | null;
  onchainEntityId?: string | null;
  reuseFinalized?: boolean;
  recoveryOnly?: boolean;
  beforeInsert?: () => Promise<void>;
  nowMs?: number;
}): Promise<PreparedMarketplaceTransaction> {
  validateCall(input.call);
  const actorWallet = normalizeAddress(input.actorWallet);
  const nowMs = input.nowMs ?? Date.now();
  const args = jsonSafeArgs(input.call.args);
  const argsHash = canonicalHash(args);
  const intentBinding = {
    operation: input.operation,
    functionName: input.call.functionName,
    contractAddress: input.call.contractAddress,
    actorWallet,
    argsHash,
    valueAtto: input.call.value,
    localCampaignId: input.localCampaignId ?? null,
    localApplicationId: input.localApplicationId ?? null,
    onchainEntityId: input.onchainEntityId ?? null,
  };
  const intentBaseKey = marketplaceTransactionIntentBaseKey(intentBinding);
  if (input.preparedId !== undefined && !uuidPattern.test(input.preparedId)) {
    throw new Error("The reserved GenLayer prepared ID is invalid.");
  }
  let existing: GenLayerTransactionRow | null;
  if (input.preparedId) {
    existing = await findGenLayerPreparedTransaction(input.preparedId);
    if (existing) {
      assertReservedPreparedTransaction(existing, {
        ...input,
        actorWallet,
        argsHash,
      });
    }
  } else {
    existing = await findReusablePreparedTransaction({
      ...intentBinding,
      reuseFinalized: input.reuseFinalized ?? true,
    });
  }
  const recovery = await recoverPreparedMarketplaceTransactionBeforePreflight({
    row: existing,
    recoveryOnly: input.recoveryOnly,
    beforeInsert: input.beforeInsert,
  });
  if (recovery) return recovery;

  const retryPredecessor = await findGenLayerTransactionRetryPredecessor({
    ...intentBinding,
    includeFinalized: input.reuseFinalized === false,
  });
  const intentKey = marketplaceTransactionAttemptKey(
    intentBaseKey,
    retryPredecessor,
  );
  const preparedId = input.preparedId ?? randomUUID();
  const [created] = await getDb()
    .insert(marketplaceGenLayerTransactions)
    .values({
      preparedId,
      network: MARKETPLACE_GENLAYER_NETWORK,
      chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
      contractAddress: input.call.contractAddress.toLowerCase(),
      operation: input.operation,
      functionName: input.call.functionName,
      args,
      argTypes: [...input.call.argTypes],
      argsHash,
      intentKey,
      valueAtto: input.call.value,
      actorWallet,
      localCampaignId: input.localCampaignId ?? null,
      localApplicationId: input.localApplicationId ?? null,
      onchainEntityId: input.onchainEntityId ?? null,
      status: "PREPARED",
      reconciliationAttempts: 0,
      nextReconcileAt: 0,
      createdAt: nowMs,
      updatedAt: nowMs,
    })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    const conflict = (
      input.preparedId
        ? await findGenLayerPreparedTransaction(input.preparedId)
        : null
    ) ?? await findGenLayerPreparedTransactionByIntentKey(intentKey);
    if (!conflict) {
      throw new Error("Prepared transaction intent conflict returned no row.");
    }
    assertReservedPreparedTransaction(conflict, {
      ...input,
      actorWallet,
      argsHash,
      intentKey,
    });
    return recoverOrRejectExistingPreparedTransaction(conflict);
  }
  return preparedDto(created);
}

export async function recoverPreparedMarketplaceTransactionBeforePreflight(input: {
  row: GenLayerTransactionRow | null;
  recoveryOnly?: boolean;
  beforeInsert?: () => Promise<void>;
}): Promise<PreparedMarketplaceTransaction | null> {
  if (input.row) return recoverOrRejectExistingPreparedTransaction(input.row);
  if (input.recoveryOnly) {
    throw new ApiProblem(
      409,
      "MARKETPLACE_RECOVERY_NOT_FOUND",
      "No submitted transaction is pending.",
    );
  }
  await input.beforeInsert?.();
  return null;
}

function assertReservedPreparedTransaction(
  row: GenLayerTransactionRow,
  input: {
    operation: MarketplaceGenLayerOperation;
    call: MarketplaceGenLayerCall;
    actorWallet: string;
    argsHash: string;
    intentKey?: string;
    localCampaignId?: string | null;
    localApplicationId?: string | null;
    onchainEntityId?: string | null;
  },
): void {
  if (
    row.network !== MARKETPLACE_GENLAYER_NETWORK
    || row.chainId !== MARKETPLACE_GENLAYER_CHAIN_ID
    || row.contractAddress !== input.call.contractAddress.toLowerCase()
    || row.operation !== input.operation
    || row.functionName !== input.call.functionName
    || row.argsHash !== input.argsHash
    || (input.intentKey !== undefined
      && row.intentKey !== null
      && row.intentKey !== input.intentKey)
    || row.valueAtto !== input.call.value
    || row.actorWallet !== input.actorWallet
    || row.localCampaignId !== (input.localCampaignId ?? null)
    || row.localApplicationId !== (input.localApplicationId ?? null)
    || row.onchainEntityId !== (input.onchainEntityId ?? null)
    || JSON.stringify(row.argTypes) !== JSON.stringify(input.call.argTypes)
  ) {
    throw new Error("The reserved GenLayer transaction binding changed.");
  }
}

function recoverOrRejectExistingPreparedTransaction(
  row: GenLayerTransactionRow,
): PreparedMarketplaceTransaction {
  const disposition = existingPreparedMarketplaceTransactionDisposition(row);
  if (disposition === "RETRY") {
    throw new ApiProblem(
      409,
      "MARKETPLACE_TRANSACTION_RETRY_REQUIRED",
      "The prior transaction failed. Prepare a new attempt.",
    );
  }
  if (disposition === "RECOVERY") return preparedDto(row);
  throw new ApiProblem(
    409,
    "MARKETPLACE_TRANSACTION_STATE_UNKNOWN",
    "Transaction status unknown. Do not resend. Contact support.",
  );
}

export function existingPreparedMarketplaceTransactionDisposition(
  row: Pick<GenLayerTransactionRow, "status" | "transactionHash">,
): "RECOVERY" | "RETRY" | "UNKNOWN" {
  if (
    row.status === "EXECUTION_FAILED"
    || row.status === "NETWORK_TERMINATED"
  ) return "RETRY";
  return row.transactionHash ? "RECOVERY" : "UNKNOWN";
}

async function findGenLayerPreparedTransactionByIntentKey(
  intentKey: string,
): Promise<GenLayerTransactionRow | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceGenLayerTransactions)
    .where(
      and(
        eq(marketplaceGenLayerTransactions.network, MARKETPLACE_GENLAYER_NETWORK),
        eq(marketplaceGenLayerTransactions.chainId, MARKETPLACE_GENLAYER_CHAIN_ID),
        eq(
          marketplaceGenLayerTransactions.contractAddress,
          marketplaceContractAddress(),
        ),
        eq(marketplaceGenLayerTransactions.intentKey, intentKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findGenLayerPreparedTransaction(
  preparedId: string,
): Promise<GenLayerTransactionRow | null> {
  if (!uuidPattern.test(preparedId)) return null;
  const [row] = await getDb()
    .select()
    .from(marketplaceGenLayerTransactions)
    .where(eq(marketplaceGenLayerTransactions.preparedId, preparedId))
    .limit(1);
  return row ?? null;
}

export async function findBoundGenLayerApplicationRecovery(input: {
  localApplicationId: string;
  actorWallet: string;
}): Promise<{ preparedId: string; transactionHash: string } | null> {
  const [row] = await getDb()
    .select({
      preparedId: marketplaceGenLayerTransactions.preparedId,
      transactionHash: marketplaceGenLayerTransactions.transactionHash,
    })
    .from(marketplaceGenLayerTransactions)
    .where(
      and(
        eq(marketplaceGenLayerTransactions.network, MARKETPLACE_GENLAYER_NETWORK),
        eq(marketplaceGenLayerTransactions.chainId, MARKETPLACE_GENLAYER_CHAIN_ID),
        eq(
          marketplaceGenLayerTransactions.contractAddress,
          marketplaceContractAddress().toLowerCase(),
        ),
        eq(marketplaceGenLayerTransactions.operation, "APPLY"),
        eq(marketplaceGenLayerTransactions.functionName, "apply_to_campaign"),
        eq(
          marketplaceGenLayerTransactions.localApplicationId,
          input.localApplicationId,
        ),
        eq(
          marketplaceGenLayerTransactions.actorWallet,
          normalizeAddress(input.actorWallet),
        ),
        isNotNull(marketplaceGenLayerTransactions.transactionHash),
        inArray(marketplaceGenLayerTransactions.status, [
          "SUBMITTED",
          "ACCEPTED",
          "FINALIZED",
          "RECONCILIATION_REQUIRED",
        ]),
      ),
    )
    .orderBy(desc(marketplaceGenLayerTransactions.createdAt))
    .limit(1);
  if (!row?.transactionHash) return null;
  return {
    preparedId: row.preparedId,
    transactionHash: row.transactionHash,
  };
}

export async function findBoundGenLayerSubmissionTransaction(input: {
  localCampaignId: string;
  localApplicationId: string;
  assignmentId: string;
  actorWallet: string;
}): Promise<GenLayerTransactionRow | null> {
  const rows = await getDb()
    .select()
    .from(marketplaceGenLayerTransactions)
    .where(
      and(
        eq(marketplaceGenLayerTransactions.network, MARKETPLACE_GENLAYER_NETWORK),
        eq(marketplaceGenLayerTransactions.chainId, MARKETPLACE_GENLAYER_CHAIN_ID),
        eq(
          marketplaceGenLayerTransactions.contractAddress,
          marketplaceContractAddress().toLowerCase(),
        ),
        eq(marketplaceGenLayerTransactions.operation, "SUBMIT_EVIDENCE"),
        eq(marketplaceGenLayerTransactions.functionName, "submit_evidence"),
        eq(
          marketplaceGenLayerTransactions.localCampaignId,
          input.localCampaignId,
        ),
        eq(
          marketplaceGenLayerTransactions.localApplicationId,
          input.localApplicationId,
        ),
        eq(
          marketplaceGenLayerTransactions.onchainEntityId,
          input.assignmentId,
        ),
        eq(
          marketplaceGenLayerTransactions.actorWallet,
          normalizeAddress(input.actorWallet),
        ),
        isNotNull(marketplaceGenLayerTransactions.transactionHash),
        inArray(marketplaceGenLayerTransactions.status, [
          "SUBMITTED",
          "ACCEPTED",
          "FINALIZED",
          "RECONCILIATION_REQUIRED",
        ]),
      ),
    )
    .orderBy(desc(marketplaceGenLayerTransactions.createdAt))
    .limit(2);
  if (rows.length > 1) {
    throw new ApiProblem(
      409,
      "MARKETPLACE_TRANSACTION_STATE_UNKNOWN",
      "Multiple bound submission transactions require reconciliation. Do not resend.",
    );
  }
  const [row] = rows;
  if (!row) return null;
  const call = exactGenLayerJournalCall(row);
  if (
    call.functionName !== "submit_evidence"
    || call.value !== "0"
    || call.args.length !== 4
    || call.args[0] !== input.assignmentId
    || JSON.stringify(call.argTypes)
      !== JSON.stringify(["string", "string", "string", "string"])
  ) {
    throw new Error("The bound GenLayer submission recovery is corrupt.");
  }
  return row;
}

/**
 * Rehydrates only the immutable call committed by a journal row. This is the
 * reconciliation boundary: workers never accept method, args, value, actor,
 * or deployment data from a queue payload.
 */
export function exactGenLayerJournalCall(
  row: GenLayerTransactionRow,
): MarketplaceGenLayerCall {
  const call: MarketplaceGenLayerCall = {
    network: MARKETPLACE_GENLAYER_NETWORK,
    chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
    contractAddress: row.contractAddress as `0x${string}`,
    functionName: row.functionName,
    args: row.args as never[],
    argTypes: row.argTypes,
    value: row.valueAtto,
  };
  validateCall(call);
  if (
    row.network !== MARKETPLACE_GENLAYER_NETWORK ||
    row.chainId !== MARKETPLACE_GENLAYER_CHAIN_ID ||
    row.contractAddress !== marketplaceContractAddress() ||
    row.argsHash !== canonicalHash(row.args)
  ) {
    throw new Error("The GenLayer journal call binding is corrupt.");
  }
  return Object.freeze(call);
}

export async function bindGenLayerTransactionHash(input: {
  preparedId: string;
  actorWallet: string;
  transactionHash: string;
  nowMs?: number;
}): Promise<GenLayerTransactionRow | null> {
  const nowMs = input.nowMs ?? Date.now();
  const transactionHash = normalizeHash(input.transactionHash);
  const actorWallet = normalizeAddress(input.actorWallet);
  const current = await findGenLayerPreparedTransaction(input.preparedId);
  if (!current || current.actorWallet !== actorWallet) return null;
  if (current.transactionHash) {
    if (current.transactionHash !== transactionHash) return null;
    if (current.status !== "FINALIZED") {
      await seedGenLayerJournalMaintenance(nowMs);
    }
    return current;
  }
  const [updated] = await getDb()
    .update(marketplaceGenLayerTransactions)
    .set({
      transactionHash,
      status: "SUBMITTED",
      submittedAt: nowMs,
      lastCheckedAt: nowMs,
      nextReconcileAt: nowMs + 60_000,
      updatedAt: nowMs,
    })
    .where(
      and(
        eq(marketplaceGenLayerTransactions.preparedId, input.preparedId),
        eq(marketplaceGenLayerTransactions.actorWallet, actorWallet),
        eq(marketplaceGenLayerTransactions.status, "PREPARED"),
        sql`${marketplaceGenLayerTransactions.transactionHash} is null`,
      ),
    )
    .returning();
  if (updated) await seedGenLayerJournalMaintenance(nowMs);
  return updated ?? null;
}

export async function recordGenLayerTransactionStatus(input: {
  preparedId: string;
  status: MarketplaceGenLayerTransactionStatus;
  lifecycleStatus: string | null;
  executionResult: string | null;
  errorCode: string | null;
  finalizedAt?: number | null;
  nowMs?: number;
  retryAtMs?: number;
  fenceToken?: string;
}): Promise<GenLayerTransactionRow | null> {
  const nowMs = input.nowMs ?? Date.now();
  if (input.fenceToken !== undefined && !uuidPattern.test(input.fenceToken)) {
    throw new Error("The GenLayer reconciliation fence is invalid.");
  }
  const [updated] = await getDb()
    .update(marketplaceGenLayerTransactions)
    .set({
      status: input.status,
      lifecycleStatus: input.lifecycleStatus,
      executionResult: input.executionResult,
      errorCode: input.errorCode,
      acceptedAt:
        input.status === "ACCEPTED" || input.status === "FINALIZED"
          ? nowMs
          : undefined,
      finalizedAt:
        input.status === "FINALIZED"
          ? (input.finalizedAt ?? nowMs)
          : undefined,
      lastCheckedAt: nowMs,
      nextReconcileAt:
        input.status === "SUBMITTED" ||
        input.status === "ACCEPTED" ||
        input.status === "RECONCILIATION_REQUIRED"
          ? (input.retryAtMs ?? nowMs + 15_000)
          : 0,
      fenceToken: null,
      fenceExpiresAt: null,
      updatedAt: nowMs,
    })
    .where(and(
      eq(marketplaceGenLayerTransactions.preparedId, input.preparedId),
      sql`${marketplaceGenLayerTransactions.status} <> 'FINALIZED'`,
      inArray(
        marketplaceGenLayerTransactions.status,
        input.status === "PREPARED"
          ? ["PREPARED"]
          : input.status === "SUBMITTED"
            ? ["PREPARED"]
            : ["SUBMITTED", "ACCEPTED", "RECONCILIATION_REQUIRED"],
      ),
      input.fenceToken === undefined
        ? isNull(marketplaceGenLayerTransactions.fenceToken)
        : eq(marketplaceGenLayerTransactions.fenceToken, input.fenceToken),
    ))
    .returning();
  if (updated) return updated;
  const current = await findGenLayerPreparedTransaction(input.preparedId);
  return current?.status === "FINALIZED" ? current : null;
}

export async function claimDueGenLayerReconciliation(input: {
  nowMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
} = {}): Promise<(GenLayerTransactionRow & { fenceToken: string }) | null> {
  const nowMs = input.nowMs ?? Date.now();
  const leaseMs = input.leaseMs ?? 30_000;
  const maxAttempts = input.maxAttempts ?? MAX_GENLAYER_RECONCILIATION_ATTEMPTS;
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("The GenLayer reconciliation clock is invalid.");
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 10 * 60_000) {
    throw new Error("The GenLayer reconciliation lease is invalid.");
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error("The GenLayer reconciliation attempt limit is invalid.");
  }
  const fenceToken = randomUUID();
  const result = await getDb().execute(sql`
    with candidate as (
      select prepared_id
      from ${marketplaceGenLayerTransactions}
      where status in ('SUBMITTED', 'ACCEPTED', 'RECONCILIATION_REQUIRED')
        and transaction_hash is not null
        and next_reconcile_at > 0
        and next_reconcile_at <= ${nowMs}
        and reconciliation_attempts < ${maxAttempts}
        and (fence_expires_at is null or fence_expires_at <= ${nowMs})
      order by next_reconcile_at asc, created_at asc
      limit 1
      for update skip locked
    )
    update ${marketplaceGenLayerTransactions} as target
    set
      fence_token = ${fenceToken},
      fence_expires_at = ${nowMs + leaseMs},
      reconciliation_attempts = target.reconciliation_attempts + 1,
      last_checked_at = ${nowMs},
      updated_at = ${nowMs}
    from candidate
    where target.prepared_id = candidate.prepared_id
      and target.status in ('SUBMITTED', 'ACCEPTED', 'RECONCILIATION_REQUIRED')
      and target.transaction_hash is not null
      and target.reconciliation_attempts < ${maxAttempts}
      and (target.fence_expires_at is null or target.fence_expires_at <= ${nowMs})
    returning target.*
  `);
  const row = firstRawRow(result);
  return row ? (snakeTransactionRow(row) as GenLayerTransactionRow & { fenceToken: string }) : null;
}

export async function upsertGenLayerProfileProjection(input: {
  contractAddress: string;
  ownerWallet: string;
  identityHash: string;
  source: GenLayerContentSource;
  handle: string;
  externalUserId: string;
  ownershipRequestId: string;
  activationTxHash: string;
  publicHandle?: string | null;
  displayName?: string | null;
  bio?: string | null;
  categories?: string[];
  visibility?: "PUBLIC" | "UNLISTED" | "PRIVATE";
  active: boolean;
  verifiedAt: number;
  expiresAt: number;
  finalizedAt: number;
  snapshotHash: string;
  nowMs?: number;
}): Promise<void> {
  const nowMs = input.nowMs ?? Date.now();
  const projectionId = deriveProjectionId({
    network: MARKETPLACE_GENLAYER_NETWORK,
    chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
    contractAddress: input.contractAddress,
    entityId: input.identityHash,
  });
  await getDb()
    .insert(marketplaceGenLayerProfiles)
    .values({
      projectionId,
      identityHash: normalizeHash(input.identityHash),
      network: MARKETPLACE_GENLAYER_NETWORK,
      chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
      contractAddress: input.contractAddress.toLowerCase(),
      ownerWallet: normalizeAddress(input.ownerWallet),
      source: input.source,
      handle: input.handle,
      externalUserId: input.externalUserId,
      ownershipRequestId: normalizeHash(input.ownershipRequestId),
      activationTxHash: normalizeHash(input.activationTxHash),
      publicHandle: input.publicHandle ?? null,
      displayName: input.displayName ?? null,
      bio: input.bio ?? null,
      categories: input.categories ?? [],
      visibility: input.visibility ?? "PUBLIC",
      active: input.active,
      verifiedAt: input.verifiedAt,
      expiresAt: input.expiresAt,
      finalizedAt: input.finalizedAt,
      snapshotHash: normalizeHash(input.snapshotHash),
      projectedAt: nowMs,
    })
    .onConflictDoUpdate({
      target: marketplaceGenLayerProfiles.projectionId,
      set: {
        contractAddress: input.contractAddress.toLowerCase(),
        ownerWallet: normalizeAddress(input.ownerWallet),
        source: input.source,
        handle: input.handle,
        externalUserId: input.externalUserId,
        ownershipRequestId: normalizeHash(input.ownershipRequestId),
        activationTxHash: normalizeHash(input.activationTxHash),
        active: input.active,
        verifiedAt: input.verifiedAt,
        expiresAt: input.expiresAt,
        finalizedAt: input.finalizedAt,
        snapshotHash: normalizeHash(input.snapshotHash),
        projectedAt: nowMs,
      },
      setWhere: sql`${marketplaceGenLayerProfiles.finalizedAt} < ${input.finalizedAt}`,
    });
}

export async function upsertGenLayerCampaignProjection(input: {
  campaignId: string;
  localCampaignId: string;
  contractAddress: string;
  brandWallet: string;
  clientNonce: string;
  contentSource: GenLayerContentSource;
  termsHash: string;
  budgetAtto: string;
  availableAtto: string;
  reservedAtto: string;
  settledAtto: string;
  creatorPaidAtto: string;
  brandRefundedAtto: string;
  feeAtto: string;
  status: string;
  feeBps: number;
  treasuryWallet: string;
  applicationCount: number;
  assignmentCount: number;
  maxUndeterminedRetries: number;
  applicationDeadlineEpoch: number;
  selectionDeadlineEpoch: number;
  submissionDeadlineEpoch: number;
  retentionSeconds: number;
  createdAtEpoch: number;
  closedAtEpoch: number;
  creationTxHash: string;
  lastTxHash: string;
  finalizedAt: number;
  snapshotHash: string;
  observationTicket: number;
  nowMs?: number;
}): Promise<GenLayerCampaignProjection> {
  assertCampaignMoney(input);
  if (!Number.isSafeInteger(input.observationTicket) || input.observationTicket <= 0) {
    throw new Error("The campaign observation ticket is invalid.");
  }
  const nowMs = Math.max(input.nowMs ?? Date.now(), input.finalizedAt);
  const normalizedSnapshotHash = normalizeHash(input.snapshotHash);
  const mayReplaceObservation = sql`
    (${marketplaceGenLayerCampaigns.observationTicket} is null
      or ${marketplaceGenLayerCampaigns.observationTicket} < ${input.observationTicket})
    and ${marketplaceGenLayerCampaigns.settledAtto} <= ${input.settledAtto}
    and ${marketplaceGenLayerCampaigns.creatorPaidAtto} <= ${input.creatorPaidAtto}
    and ${marketplaceGenLayerCampaigns.brandRefundedAtto} <= ${input.brandRefundedAtto}
    and ${marketplaceGenLayerCampaigns.feeAtto} <= ${input.feeAtto}
    and ${marketplaceGenLayerCampaigns.applicationCount} <= ${input.applicationCount}
    and ${marketplaceGenLayerCampaigns.assignmentCount} <= ${input.assignmentCount}
    and (${marketplaceGenLayerCampaigns.status} = 'OPEN' or ${marketplaceGenLayerCampaigns.status} = ${input.status})
    and (
      ${marketplaceGenLayerCampaigns.status} <> ${input.status}
      or ${marketplaceGenLayerCampaigns.applicationCount} <> ${input.applicationCount}
      or ${marketplaceGenLayerCampaigns.assignmentCount} <> ${input.assignmentCount}
      or ${marketplaceGenLayerCampaigns.settledAtto} <> ${input.settledAtto}
      or ${marketplaceGenLayerCampaigns.creatorPaidAtto} <> ${input.creatorPaidAtto}
      or ${marketplaceGenLayerCampaigns.brandRefundedAtto} <> ${input.brandRefundedAtto}
      or ${marketplaceGenLayerCampaigns.feeAtto} <> ${input.feeAtto}
      or (
        ${marketplaceGenLayerCampaigns.availableAtto} <= ${input.availableAtto}
        and ${marketplaceGenLayerCampaigns.reservedAtto} >= ${input.reservedAtto}
      )
    )
    and ${input.settledAtto} >= (
      select coalesce(sum(known_assignment.agreed_rate_atto), 0)
      from ${marketplaceGenLayerAssignments} as known_assignment
      where known_assignment.network = ${MARKETPLACE_GENLAYER_NETWORK}
        and known_assignment.chain_id = ${MARKETPLACE_GENLAYER_CHAIN_ID}
        and known_assignment.contract_address = ${marketplaceContractAddress()}
        and known_assignment.campaign_id = ${normalizeHash(input.campaignId)}
        and known_assignment.status in ('SETTLED_PASS', 'SETTLED_FAIL', 'REFUNDED')
    )
    and ${input.creatorPaidAtto} >= (
      select coalesce(sum(known_assignment.creator_credit_atto), 0)
      from ${marketplaceGenLayerAssignments} as known_assignment
      where known_assignment.network = ${MARKETPLACE_GENLAYER_NETWORK}
        and known_assignment.chain_id = ${MARKETPLACE_GENLAYER_CHAIN_ID}
        and known_assignment.contract_address = ${marketplaceContractAddress()}
        and known_assignment.campaign_id = ${normalizeHash(input.campaignId)}
        and known_assignment.status in ('SETTLED_PASS', 'SETTLED_FAIL', 'REFUNDED')
    )
    and ${input.brandRefundedAtto} >= (
      select coalesce(sum(known_assignment.brand_credit_atto), 0)
      from ${marketplaceGenLayerAssignments} as known_assignment
      where known_assignment.network = ${MARKETPLACE_GENLAYER_NETWORK}
        and known_assignment.chain_id = ${MARKETPLACE_GENLAYER_CHAIN_ID}
        and known_assignment.contract_address = ${marketplaceContractAddress()}
        and known_assignment.campaign_id = ${normalizeHash(input.campaignId)}
        and known_assignment.status in ('SETTLED_PASS', 'SETTLED_FAIL', 'REFUNDED')
    )
    and ${input.feeAtto} >= (
      select coalesce(sum(known_assignment.fee_atto), 0)
      from ${marketplaceGenLayerAssignments} as known_assignment
      where known_assignment.network = ${MARKETPLACE_GENLAYER_NETWORK}
        and known_assignment.chain_id = ${MARKETPLACE_GENLAYER_CHAIN_ID}
        and known_assignment.contract_address = ${marketplaceContractAddress()}
        and known_assignment.campaign_id = ${normalizeHash(input.campaignId)}
        and known_assignment.status in ('SETTLED_PASS', 'SETTLED_FAIL', 'REFUNDED')
    )
  `;
  const projectionId = deriveProjectionId({
    network: MARKETPLACE_GENLAYER_NETWORK,
    chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
    contractAddress: input.contractAddress,
    entityId: input.campaignId,
  });
  const [row] = await getDb()
    .insert(marketplaceGenLayerCampaigns)
    .values({
      projectionId,
      campaignId: normalizeHash(input.campaignId),
      localCampaignId: input.localCampaignId,
      network: MARKETPLACE_GENLAYER_NETWORK,
      chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
      contractAddress: input.contractAddress.toLowerCase(),
      contractVersion: marketplaceContractVersion(),
      brandWallet: normalizeAddress(input.brandWallet),
      clientNonce: input.clientNonce,
      contentSource: input.contentSource,
      treasuryWallet: normalizeAddress(input.treasuryWallet),
      termsHash: normalizeHash(input.termsHash),
      budgetAtto: input.budgetAtto,
      availableAtto: input.availableAtto,
      reservedAtto: input.reservedAtto,
      settledAtto: input.settledAtto,
      creatorPaidAtto: input.creatorPaidAtto,
      brandRefundedAtto: input.brandRefundedAtto,
      feeAtto: input.feeAtto,
      status: input.status,
      feeBps: input.feeBps,
      applicationCount: input.applicationCount,
      assignmentCount: input.assignmentCount,
      maxUndeterminedRetries: input.maxUndeterminedRetries,
      applicationDeadlineEpoch: input.applicationDeadlineEpoch,
      selectionDeadlineEpoch: input.selectionDeadlineEpoch,
      submissionDeadlineEpoch: input.submissionDeadlineEpoch,
      retentionSeconds: input.retentionSeconds,
      createdAtEpoch: input.createdAtEpoch,
      closedAtEpoch: input.closedAtEpoch,
      creationTxHash: normalizeHash(input.creationTxHash),
      lastTxHash: normalizeHash(input.lastTxHash),
      finalizedAt: input.finalizedAt,
      snapshotHash: normalizedSnapshotHash,
      observedAfterTxHash: normalizeHash(input.lastTxHash),
      observedAfterFinalizedAt: input.finalizedAt,
      observationTicket: input.observationTicket,
      observationRevision: 1,
      observedAt: nowMs,
      projectedAt: nowMs,
    })
    .onConflictDoUpdate({
      target: marketplaceGenLayerCampaigns.projectionId,
      set: {
        budgetAtto: input.budgetAtto,
        availableAtto: sql`case when ${mayReplaceObservation} then ${input.availableAtto} else ${marketplaceGenLayerCampaigns.availableAtto} end`,
        reservedAtto: sql`case when ${mayReplaceObservation} then ${input.reservedAtto} else ${marketplaceGenLayerCampaigns.reservedAtto} end`,
        settledAtto: sql`case when ${mayReplaceObservation} then ${input.settledAtto} else ${marketplaceGenLayerCampaigns.settledAtto} end`,
        creatorPaidAtto: sql`case when ${mayReplaceObservation} then ${input.creatorPaidAtto} else ${marketplaceGenLayerCampaigns.creatorPaidAtto} end`,
        brandRefundedAtto: sql`case when ${mayReplaceObservation} then ${input.brandRefundedAtto} else ${marketplaceGenLayerCampaigns.brandRefundedAtto} end`,
        feeAtto: sql`case when ${mayReplaceObservation} then ${input.feeAtto} else ${marketplaceGenLayerCampaigns.feeAtto} end`,
        status: sql`case when ${mayReplaceObservation} then ${input.status} else ${marketplaceGenLayerCampaigns.status} end`,
        feeBps: input.feeBps,
        treasuryWallet: normalizeAddress(input.treasuryWallet),
        applicationCount: sql`case when ${mayReplaceObservation} then ${input.applicationCount} else ${marketplaceGenLayerCampaigns.applicationCount} end`,
        assignmentCount: sql`case when ${mayReplaceObservation} then ${input.assignmentCount} else ${marketplaceGenLayerCampaigns.assignmentCount} end`,
        maxUndeterminedRetries: input.maxUndeterminedRetries,
        applicationDeadlineEpoch: input.applicationDeadlineEpoch,
        selectionDeadlineEpoch: input.selectionDeadlineEpoch,
        submissionDeadlineEpoch: input.submissionDeadlineEpoch,
        retentionSeconds: input.retentionSeconds,
        createdAtEpoch: input.createdAtEpoch,
        closedAtEpoch: sql`case when ${mayReplaceObservation} then ${input.closedAtEpoch} else ${marketplaceGenLayerCampaigns.closedAtEpoch} end`,
        creationTxHash: normalizeHash(input.creationTxHash),
        snapshotHash: sql`case when ${mayReplaceObservation} then ${normalizedSnapshotHash} else ${marketplaceGenLayerCampaigns.snapshotHash} end`,
        observedAfterTxHash: sql`case when ${mayReplaceObservation} then ${normalizeHash(input.lastTxHash)} else ${marketplaceGenLayerCampaigns.observedAfterTxHash} end`,
        observedAfterFinalizedAt: sql`case when ${mayReplaceObservation} then ${input.finalizedAt} else ${marketplaceGenLayerCampaigns.observedAfterFinalizedAt} end`,
        observationTicket: sql`case when ${mayReplaceObservation} then ${input.observationTicket} else ${marketplaceGenLayerCampaigns.observationTicket} end`,
        observationRevision: sql`case when ${mayReplaceObservation} then ${marketplaceGenLayerCampaigns.observationRevision} + 1 else ${marketplaceGenLayerCampaigns.observationRevision} end`,
        observedAt: sql`case when ${mayReplaceObservation} then ${nowMs} else ${marketplaceGenLayerCampaigns.observedAt} end`,
        projectedAt: sql`case when ${mayReplaceObservation} then ${nowMs} else ${marketplaceGenLayerCampaigns.projectedAt} end`,
      },
      setWhere: mayReplaceObservation,
    })
    .returning();
  if (row) return row;
  const [current] = await getDb()
    .select()
    .from(marketplaceGenLayerCampaigns)
    .where(eq(marketplaceGenLayerCampaigns.projectionId, projectionId))
    .limit(1);
  if (
    !current ||
    !(
      (current.observationTicket ?? 0) > input.observationTicket ||
      (
        current.observationTicket === input.observationTicket &&
        current.snapshotHash === normalizedSnapshotHash
      )
    )
  ) {
    throw new Error("Campaign projection ordering could not be preserved.");
  }
  return current;
}

export async function upsertGenLayerAssignmentProjection(input: {
  contractAddress: string;
  assignmentId: string;
  campaignId: string;
  localApplicationId: string;
  brandWallet: string;
  creatorWallet: string;
  contentSource: GenLayerContentSource;
  creatorHandle: string;
  creatorExternalUserId: string;
  creatorIdentityHash: string;
  applicationId: string;
  agreedRateAtto: string;
  agreementHash: string;
  status: string;
  selectedAtEpoch: number;
  acceptanceDeadlineEpoch: number;
  acceptedAtEpoch: number;
  postId: string;
  submissionHash: string | null;
  resolutionRequestId: string | null;
  resolutionAttempts: number;
  resolutionEligibleAtEpoch: number;
  lastResolutionAtEpoch: number;
  evidenceHash: string | null;
  outcome: MarketplaceResolutionOutcome | null;
  reasoning: string;
  resolutionChecks: Record<string, unknown>;
  resolutionRound: number;
  maxUndeterminedRetries: number;
  creatorCreditAtto: string;
  brandCreditAtto: string;
  feeAtto: string;
  submittedAtEpoch: number;
  settledAtEpoch: number;
  closedAtEpoch: number;
  selectionTxHash: string;
  lastTxHash: string;
  finalizedAt: number;
  snapshotHash: string;
  sharedProjectionPending?: boolean;
  sharedProjectionAnchorTxHash?: string | null;
  sharedProjectionObservationTicket?: number | null;
  sharedProjectionAttempts?: number;
  sharedProjectionNextRepairAt?: number;
  expectedPreviousSnapshotHash?: string;
  nowMs?: number;
}): Promise<GenLayerAssignmentProjection> {
  assertAssignmentMoney(input);
  const sharedProjectionPending = input.sharedProjectionPending ?? false;
  const sharedProjectionAnchorTxHash = input.sharedProjectionAnchorTxHash
    ? normalizeHash(input.sharedProjectionAnchorTxHash)
    : null;
  const sharedProjectionAttempts = input.sharedProjectionAttempts ?? 0;
  const sharedProjectionNextRepairAt = input.sharedProjectionNextRepairAt ?? 0;
  const sharedProjectionObservationTicket = input.sharedProjectionObservationTicket ?? null;
  const expectedPreviousSnapshotHash = input.expectedPreviousSnapshotHash
    ? normalizeHash(input.expectedPreviousSnapshotHash)
    : null;
  const normalizedLastTxHash = normalizeHash(input.lastTxHash);
  const normalizedSnapshotHash = normalizeHash(input.snapshotHash);
  if (
    sharedProjectionPending &&
    sharedProjectionAnchorTxHash !== normalizeHash(input.lastTxHash)
  ) {
    throw new Error("The shared projection marker is not bound to the assignment receipt.");
  }
  if (
    !Number.isSafeInteger(sharedProjectionAttempts) ||
    sharedProjectionAttempts < 0 ||
    !Number.isSafeInteger(sharedProjectionNextRepairAt) ||
    sharedProjectionNextRepairAt < 0 ||
    (
      sharedProjectionObservationTicket !== null &&
      (!Number.isSafeInteger(sharedProjectionObservationTicket) || sharedProjectionObservationTicket <= 0)
    )
  ) {
    throw new Error("The shared projection repair schedule is invalid.");
  }
  const nowMs = input.nowMs ?? Date.now();
  const projectionId = deriveProjectionId({
    network: MARKETPLACE_GENLAYER_NETWORK,
    chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
    contractAddress: input.contractAddress,
    entityId: input.assignmentId,
  });
  const campaignProjectionId = deriveProjectionId({
    network: MARKETPLACE_GENLAYER_NETWORK,
    chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
    contractAddress: input.contractAddress,
    entityId: input.campaignId,
  });
  const [row] = await getDb()
    .insert(marketplaceGenLayerAssignments)
    .values({
      projectionId,
      assignmentId: normalizeHash(input.assignmentId),
      network: MARKETPLACE_GENLAYER_NETWORK,
      chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
      contractAddress: input.contractAddress.toLowerCase(),
      contractVersion: marketplaceContractVersion(),
      campaignProjectionId,
      campaignId: normalizeHash(input.campaignId),
      localApplicationId: input.localApplicationId,
      brandWallet: normalizeAddress(input.brandWallet),
      creatorWallet: normalizeAddress(input.creatorWallet),
      contentSource: input.contentSource,
      creatorHandle: input.creatorHandle,
      creatorExternalUserId: input.creatorExternalUserId,
      creatorIdentityHash: normalizeHash(input.creatorIdentityHash),
      applicationId: normalizeHash(input.applicationId),
      agreedRateAtto: input.agreedRateAtto,
      agreementHash: normalizeHash(input.agreementHash),
      status: input.status,
      selectedAtEpoch: input.selectedAtEpoch,
      acceptanceDeadlineEpoch: input.acceptanceDeadlineEpoch,
      acceptedAtEpoch: input.acceptedAtEpoch,
      postId: input.postId,
      submissionHash: input.submissionHash,
      resolutionRequestId: input.resolutionRequestId,
      resolutionAttempts: input.resolutionAttempts,
      resolutionEligibleAtEpoch: input.resolutionEligibleAtEpoch,
      lastResolutionAtEpoch: input.lastResolutionAtEpoch,
      evidenceHash: input.evidenceHash,
      outcome: input.outcome,
      reasoning: input.reasoning,
      resolutionChecks: input.resolutionChecks,
      resolutionRound: input.resolutionRound,
      maxUndeterminedRetries: input.maxUndeterminedRetries,
      creatorCreditAtto: input.creatorCreditAtto,
      brandCreditAtto: input.brandCreditAtto,
      feeAtto: input.feeAtto,
      submittedAtEpoch: input.submittedAtEpoch,
      settledAtEpoch: input.settledAtEpoch,
      closedAtEpoch: input.closedAtEpoch,
      selectionTxHash: normalizeHash(input.selectionTxHash),
      lastTxHash: normalizedLastTxHash,
      finalizedAt: input.finalizedAt,
      snapshotHash: normalizedSnapshotHash,
      sharedProjectionPending,
      sharedProjectionAnchorTxHash,
      sharedProjectionObservationTicket,
      sharedProjectionAttempts,
      sharedProjectionNextRepairAt,
      projectedAt: nowMs,
    })
    .onConflictDoUpdate({
      target: marketplaceGenLayerAssignments.projectionId,
      set: {
        contractAddress: input.contractAddress.toLowerCase(),
        contractVersion: marketplaceContractVersion(),
        status: input.status,
        acceptedAtEpoch: input.acceptedAtEpoch,
        postId: input.postId,
        submissionHash: input.submissionHash,
        resolutionRequestId: input.resolutionRequestId,
        resolutionAttempts: input.resolutionAttempts,
        resolutionEligibleAtEpoch: input.resolutionEligibleAtEpoch,
        lastResolutionAtEpoch: input.lastResolutionAtEpoch,
        evidenceHash: input.evidenceHash,
        outcome: input.outcome,
        reasoning: input.reasoning,
        resolutionChecks: input.resolutionChecks,
        resolutionRound: input.resolutionRound,
        maxUndeterminedRetries: input.maxUndeterminedRetries,
        creatorCreditAtto: input.creatorCreditAtto,
        brandCreditAtto: input.brandCreditAtto,
        feeAtto: input.feeAtto,
        submittedAtEpoch: input.submittedAtEpoch,
        settledAtEpoch: input.settledAtEpoch,
        closedAtEpoch: input.closedAtEpoch,
        lastTxHash: normalizedLastTxHash,
        finalizedAt: input.finalizedAt,
        snapshotHash: normalizedSnapshotHash,
        sharedProjectionPending,
        sharedProjectionAnchorTxHash,
        sharedProjectionObservationTicket,
        sharedProjectionAttempts,
        sharedProjectionNextRepairAt,
        projectedAt: nowMs,
      },
      setWhere: expectedPreviousSnapshotHash === null
        ? sql`${marketplaceGenLayerAssignments.finalizedAt} < ${input.finalizedAt}`
        : sql`${marketplaceGenLayerAssignments.snapshotHash} = ${expectedPreviousSnapshotHash}`,
    })
    .returning();
  if (row) return row;
  const [current] = await getDb()
    .select()
    .from(marketplaceGenLayerAssignments)
    .where(eq(marketplaceGenLayerAssignments.projectionId, projectionId))
    .limit(1);
  if (!current || current.finalizedAt < input.finalizedAt) {
    throw new Error("Assignment projection ordering could not be preserved.");
  }
  if (
    expectedPreviousSnapshotHash !== null &&
    !(
      current.lastTxHash === normalizedLastTxHash &&
      current.snapshotHash === normalizedSnapshotHash &&
      current.finalizedAt === input.finalizedAt
    )
  ) {
    throw new Error("Assignment projection compare-and-set could not be preserved.");
  }
  return current;
}

export async function upsertGenLayerClaimableBalance(input: {
  contractAddress: string;
  wallet: string;
  amountAtto: string;
  nextWithdrawalNonce: number;
  transactionHash: string;
  snapshotHash: string;
  observationTicket: number;
  nowMs?: number;
}): Promise<void> {
  if (!decimalPattern.test(input.amountAtto)) {
    throw new Error("Claimable GEN amount is invalid.");
  }
  if (!Number.isSafeInteger(input.observationTicket) || input.observationTicket <= 0) {
    throw new Error("The claimable observation ticket is invalid.");
  }
  const nowMs = input.nowMs ?? Date.now();
  const [updated] = await getDb()
    .insert(marketplaceGenLayerClaimableBalances)
    .values({
      network: MARKETPLACE_GENLAYER_NETWORK,
      chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
      contractAddress: input.contractAddress.toLowerCase(),
      wallet: normalizeAddress(input.wallet),
      amountAtto: input.amountAtto,
      nextWithdrawalNonce: input.nextWithdrawalNonce,
      lastTransactionHash: normalizeHash(input.transactionHash),
      snapshotHash: normalizeHash(input.snapshotHash),
      observedAfterTxHash: normalizeHash(input.transactionHash),
      observedAfterFinalizedAt: nowMs,
      observationTicket: input.observationTicket,
      observationRevision: 1,
      observedAt: nowMs,
      projectedAt: nowMs,
    })
    .onConflictDoUpdate({
      target: [
        marketplaceGenLayerClaimableBalances.network,
        marketplaceGenLayerClaimableBalances.chainId,
        marketplaceGenLayerClaimableBalances.contractAddress,
        marketplaceGenLayerClaimableBalances.wallet,
      ],
      set: {
        amountAtto: input.amountAtto,
        nextWithdrawalNonce: input.nextWithdrawalNonce,
        snapshotHash: normalizeHash(input.snapshotHash),
        observedAfterTxHash: normalizeHash(input.transactionHash),
        observedAfterFinalizedAt: nowMs,
        observationTicket: input.observationTicket,
        observationRevision: sql`${marketplaceGenLayerClaimableBalances.observationRevision} + 1`,
        observedAt: nowMs,
        projectedAt: nowMs,
      },
      setWhere: and(
        or(
          isNull(marketplaceGenLayerClaimableBalances.observationTicket),
          lt(marketplaceGenLayerClaimableBalances.observationTicket, input.observationTicket),
        ),
        or(
          lt(
            marketplaceGenLayerClaimableBalances.nextWithdrawalNonce,
            input.nextWithdrawalNonce,
          ),
          and(
            eq(
              marketplaceGenLayerClaimableBalances.nextWithdrawalNonce,
              input.nextWithdrawalNonce,
            ),
            lte(marketplaceGenLayerClaimableBalances.amountAtto, input.amountAtto),
          ),
        ),
      ),
    })
    .returning();
  if (updated) return;
  const [current] = await getDb()
    .select()
    .from(marketplaceGenLayerClaimableBalances)
    .where(and(
      eq(marketplaceGenLayerClaimableBalances.network, MARKETPLACE_GENLAYER_NETWORK),
      eq(marketplaceGenLayerClaimableBalances.chainId, MARKETPLACE_GENLAYER_CHAIN_ID),
      eq(marketplaceGenLayerClaimableBalances.contractAddress, input.contractAddress.toLowerCase()),
      eq(marketplaceGenLayerClaimableBalances.wallet, normalizeAddress(input.wallet)),
    ))
    .limit(1);
  if (
    !current ||
    !(
      (current.observationTicket ?? 0) > input.observationTicket ||
      (
        current.observationTicket === input.observationTicket &&
        current.snapshotHash === normalizeHash(input.snapshotHash)
      )
    )
  ) {
    throw new Error("Claimable projection ordering could not be preserved.");
  }
}

/**
 * Stores a stable LATEST_FINAL campaign observation made after a verified
 * receipt. The receipt is an observation anchor, not a claim that it alone
 * caused every value in this wallet-shared snapshot.
 */
export async function observeGenLayerCampaignProjection(input: {
  state: GenLayerCampaignState;
  anchorTransactionHash: string;
  anchorFinalizedAt: number;
  observationTicket: number;
  observationStartedAt: number;
}): Promise<GenLayerCampaignProjection> {
  assertCampaignMoney(input.state);
  if (
    !Number.isSafeInteger(input.anchorFinalizedAt) ||
    input.anchorFinalizedAt <= 0 ||
    !Number.isSafeInteger(input.observationTicket) ||
    input.observationTicket <= 0 ||
    !Number.isSafeInteger(input.observationStartedAt) ||
    input.observationStartedAt <= input.anchorFinalizedAt
  ) {
    throw new Error("The campaign observation clock is invalid.");
  }
  const projectionId = deriveProjectionId({
    network: MARKETPLACE_GENLAYER_NETWORK,
    chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
    contractAddress: marketplaceContractAddress(),
    entityId: input.state.campaignId,
  });
  const anchorTransactionHash = normalizeHash(input.anchorTransactionHash);
  const snapshotHash = canonicalHash(input.state);
  const [before] = await getDb()
    .select()
    .from(marketplaceGenLayerCampaigns)
    .where(eq(marketplaceGenLayerCampaigns.projectionId, projectionId))
    .limit(1);
  if (!before) throw new Error("The campaign observation target is unavailable.");
  if (
    before.observationTicket === input.observationTicket &&
    before.snapshotHash === snapshotHash
  ) return before;
  if (
    before.observationTicket !== null &&
    before.observationTicket >= input.observationTicket
  ) throw new Error("The campaign observation ticket was superseded.");
  const knownTerminal = await knownTerminalCampaignAccounting(input.state.campaignId);
  assertGenLayerCampaignObservationFloors(before, input.state, knownTerminal);
  const [updated] = await getDb()
    .update(marketplaceGenLayerCampaigns)
    .set({
      availableAtto: input.state.availableAtto,
      reservedAtto: input.state.reservedAtto,
      settledAtto: input.state.settledAtto,
      creatorPaidAtto: input.state.creatorPaidAtto,
      brandRefundedAtto: input.state.brandRefundedAtto,
      feeAtto: input.state.feeAtto,
      status: input.state.status,
      applicationCount: input.state.applicationCount,
      assignmentCount: input.state.assignmentCount,
      closedAtEpoch: input.state.closedAtEpoch,
      snapshotHash,
      observedAfterTxHash: anchorTransactionHash,
      observedAfterFinalizedAt: input.anchorFinalizedAt,
      observationTicket: input.observationTicket,
      observationRevision: before.observationRevision + 1,
      observedAt: input.observationStartedAt,
      projectedAt: input.observationStartedAt,
    })
    .where(and(
      eq(marketplaceGenLayerCampaigns.projectionId, projectionId),
      eq(marketplaceGenLayerCampaigns.observationRevision, before.observationRevision),
      or(
        isNull(marketplaceGenLayerCampaigns.observationTicket),
        lt(marketplaceGenLayerCampaigns.observationTicket, input.observationTicket),
      ),
    ))
    .returning();
  if (updated) return updated;
  const [current] = await getDb()
    .select()
    .from(marketplaceGenLayerCampaigns)
    .where(eq(marketplaceGenLayerCampaigns.projectionId, projectionId))
    .limit(1);
  if (
    !current ||
    current.observationTicket !== input.observationTicket ||
    current.snapshotHash !== snapshotHash
  ) {
    throw new Error("The campaign observation ordering could not be preserved.");
  }
  return current;
}

/** Same start-time CAS as campaign observation, scoped to one wallet. */
export async function observeGenLayerClaimableBalance(input: {
  state: GenLayerClaimableState;
  anchorTransactionHash: string;
  anchorFinalizedAt: number;
  observationTicket: number;
  observationStartedAt: number;
}): Promise<GenLayerClaimableBalance> {
  if (!decimalPattern.test(input.state.claimableAtto)) {
    throw new Error("Claimable GEN observation contains an invalid amount.");
  }
  if (
    !Number.isSafeInteger(input.anchorFinalizedAt) ||
    input.anchorFinalizedAt <= 0 ||
    !Number.isSafeInteger(input.observationTicket) ||
    input.observationTicket <= 0 ||
    !Number.isSafeInteger(input.observationStartedAt) ||
    input.observationStartedAt <= input.anchorFinalizedAt
  ) {
    throw new Error("The claimable observation clock is invalid.");
  }
  const wallet = normalizeAddress(input.state.account);
  const anchorTransactionHash = normalizeHash(input.anchorTransactionHash);
  const snapshotHash = canonicalHash(input.state);
  const key = and(
    eq(marketplaceGenLayerClaimableBalances.network, MARKETPLACE_GENLAYER_NETWORK),
    eq(marketplaceGenLayerClaimableBalances.chainId, MARKETPLACE_GENLAYER_CHAIN_ID),
    eq(marketplaceGenLayerClaimableBalances.contractAddress, marketplaceContractAddress()),
    eq(marketplaceGenLayerClaimableBalances.wallet, wallet),
  );
  let [before] = await getDb()
    .select()
    .from(marketplaceGenLayerClaimableBalances)
    .where(key)
    .limit(1);
  if (!before) {
    const [inserted] = await getDb()
    .insert(marketplaceGenLayerClaimableBalances)
    .values({
      network: MARKETPLACE_GENLAYER_NETWORK,
      chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
      contractAddress: marketplaceContractAddress(),
      wallet,
      amountAtto: input.state.claimableAtto,
      nextWithdrawalNonce: input.state.nextWithdrawalNonce,
      lastTransactionHash: anchorTransactionHash,
      snapshotHash,
      observedAfterTxHash: anchorTransactionHash,
      observedAfterFinalizedAt: input.anchorFinalizedAt,
      observationTicket: input.observationTicket,
      observationRevision: 1,
      observedAt: input.observationStartedAt,
      projectedAt: input.observationStartedAt,
    })
    .onConflictDoNothing({
      target: [
        marketplaceGenLayerClaimableBalances.network,
        marketplaceGenLayerClaimableBalances.chainId,
        marketplaceGenLayerClaimableBalances.contractAddress,
        marketplaceGenLayerClaimableBalances.wallet,
      ],
    })
    .returning();
    if (inserted) return inserted;
    [before] = await getDb()
      .select()
      .from(marketplaceGenLayerClaimableBalances)
      .where(key)
      .limit(1);
  }
  if (!before) throw new Error("The claimable observation target is unavailable.");
  if (
    before.observationTicket === input.observationTicket &&
    before.snapshotHash === snapshotHash
  ) return before;
  if (
    before.observationTicket !== null &&
    before.observationTicket >= input.observationTicket
  ) throw new Error("The claimable observation ticket was superseded.");
  if (
    before.snapshotHash !== snapshotHash &&
    (
      input.state.nextWithdrawalNonce < before.nextWithdrawalNonce ||
      (
        input.state.nextWithdrawalNonce === before.nextWithdrawalNonce &&
        BigInt(input.state.claimableAtto) < BigInt(before.amountAtto)
      )
    )
  ) {
    throw new Error("The claimable observation regresses wallet state.");
  }
  const [updated] = await getDb()
    .update(marketplaceGenLayerClaimableBalances)
    .set({
      amountAtto: input.state.claimableAtto,
      nextWithdrawalNonce: input.state.nextWithdrawalNonce,
      snapshotHash,
      observedAfterTxHash: anchorTransactionHash,
      observedAfterFinalizedAt: input.anchorFinalizedAt,
      observationTicket: input.observationTicket,
      observationRevision: before.observationRevision + 1,
      observedAt: input.observationStartedAt,
      projectedAt: input.observationStartedAt,
    })
    .where(and(
      key,
      eq(
        marketplaceGenLayerClaimableBalances.observationRevision,
        before.observationRevision,
      ),
      or(
        isNull(marketplaceGenLayerClaimableBalances.observationTicket),
        lt(
          marketplaceGenLayerClaimableBalances.observationTicket,
          input.observationTicket,
        ),
      ),
    ))
    .returning();
  if (updated) return updated;
  const [current] = await getDb()
    .select()
    .from(marketplaceGenLayerClaimableBalances)
    .where(key)
    .limit(1);
  if (
    !current ||
    current.observationTicket !== input.observationTicket ||
    current.snapshotHash !== snapshotHash
  ) {
    throw new Error("The claimable observation ordering could not be preserved.");
  }
  return current;
}

export async function listPendingGenLayerSharedResolutionRepairs(input: {
  nowMs: number;
  limit: number;
}): Promise<GenLayerAssignmentProjection[]> {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs <= 0) {
    throw new Error("The shared projection repair clock is invalid.");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 25) {
    throw new Error("The shared projection repair limit is invalid.");
  }
  return getDb()
    .select()
    .from(marketplaceGenLayerAssignments)
    .where(and(
      eq(marketplaceGenLayerAssignments.network, MARKETPLACE_GENLAYER_NETWORK),
      eq(marketplaceGenLayerAssignments.chainId, MARKETPLACE_GENLAYER_CHAIN_ID),
      eq(marketplaceGenLayerAssignments.contractAddress, marketplaceContractAddress()),
      eq(marketplaceGenLayerAssignments.sharedProjectionPending, true),
      inArray(marketplaceGenLayerAssignments.status, ["SETTLED_PASS", "SETTLED_FAIL"]),
      lte(marketplaceGenLayerAssignments.sharedProjectionNextRepairAt, input.nowMs),
    ))
    .orderBy(
      marketplaceGenLayerAssignments.sharedProjectionNextRepairAt,
      marketplaceGenLayerAssignments.projectedAt,
      marketplaceGenLayerAssignments.projectionId,
    )
    .limit(input.limit);
}

export async function ensureGenLayerSharedResolutionRepairMarker(input: {
  projectionId: string;
  anchorTransactionHash: string;
  snapshotHash: string;
}): Promise<GenLayerAssignmentProjection | null> {
  const projectionId = normalizeHash(input.projectionId);
  const anchorTransactionHash = normalizeHash(input.anchorTransactionHash);
  const snapshotHash = normalizeHash(input.snapshotHash);
  const [updated] = await getDb()
    .update(marketplaceGenLayerAssignments)
    .set({
      sharedProjectionPending: true,
      sharedProjectionAnchorTxHash: anchorTransactionHash,
      sharedProjectionObservationTicket: null,
      sharedProjectionAttempts: 0,
      sharedProjectionNextRepairAt: 0,
    })
    .where(and(
      eq(marketplaceGenLayerAssignments.projectionId, projectionId),
      eq(marketplaceGenLayerAssignments.lastTxHash, anchorTransactionHash),
      eq(marketplaceGenLayerAssignments.snapshotHash, snapshotHash),
      eq(marketplaceGenLayerAssignments.sharedProjectionPending, false),
      isNull(marketplaceGenLayerAssignments.sharedProjectionAnchorTxHash),
      inArray(marketplaceGenLayerAssignments.status, ["SETTLED_PASS", "SETTLED_FAIL"]),
    ))
    .returning();
  if (updated) return updated;
  const [current] = await getDb()
    .select()
    .from(marketplaceGenLayerAssignments)
    .where(eq(marketplaceGenLayerAssignments.projectionId, projectionId))
    .limit(1);
  if (
    !current ||
    current.lastTxHash !== anchorTransactionHash ||
    current.snapshotHash !== snapshotHash ||
    current.sharedProjectionAnchorTxHash !== anchorTransactionHash
  ) return null;
  return current;
}

export async function beginGenLayerSharedResolutionObservationAttempt(input: {
  projectionId: string;
  anchorTransactionHash: string;
  assignmentSnapshotHash: string;
}): Promise<GenLayerAssignmentProjection | null> {
  const projectionId = normalizeHash(input.projectionId);
  const anchorTransactionHash = normalizeHash(input.anchorTransactionHash);
  const assignmentSnapshotHash = normalizeHash(input.assignmentSnapshotHash);
  const observationTicket = await nextGenLayerSharedObservationTicket();
  const [updated] = await getDb()
    .update(marketplaceGenLayerAssignments)
    .set({ sharedProjectionObservationTicket: observationTicket })
    .where(and(
      eq(marketplaceGenLayerAssignments.projectionId, projectionId),
      eq(marketplaceGenLayerAssignments.sharedProjectionPending, true),
      eq(marketplaceGenLayerAssignments.sharedProjectionAnchorTxHash, anchorTransactionHash),
      eq(marketplaceGenLayerAssignments.lastTxHash, anchorTransactionHash),
      eq(marketplaceGenLayerAssignments.snapshotHash, assignmentSnapshotHash),
      or(
        isNull(marketplaceGenLayerAssignments.sharedProjectionObservationTicket),
        lt(
          marketplaceGenLayerAssignments.sharedProjectionObservationTicket,
          observationTicket,
        ),
      ),
    ))
    .returning();
  return updated ?? null;
}

export async function completeGenLayerSharedResolutionRepair(input: {
  projectionId: string;
  anchorTransactionHash: string;
  assignmentSnapshotHash: string;
  observationTicket: number;
  anchorFinalizedAt: number;
  campaignId: string;
  campaignSnapshotHash: string;
  claimables: ReadonlyArray<Readonly<{ wallet: string; snapshotHash: string }>>;
}): Promise<boolean> {
  const anchorTransactionHash = normalizeHash(input.anchorTransactionHash);
  const projectionId = normalizeHash(input.projectionId);
  const campaignId = normalizeHash(input.campaignId);
  const campaignSnapshotHash = normalizeHash(input.campaignSnapshotHash);
  if (!Number.isSafeInteger(input.anchorFinalizedAt) || input.anchorFinalizedAt <= 0) {
    throw new Error("The shared repair anchor time is invalid.");
  }
  if (!Number.isSafeInteger(input.observationTicket) || input.observationTicket <= 0) {
    throw new Error("The shared repair observation ticket is invalid.");
  }
  const claimables = [...new Map(input.claimables.map((claimable) => [
    normalizeAddress(claimable.wallet),
    normalizeHash(claimable.snapshotHash),
  ])).entries()];
  const claimableEvidence = claimables.map(([wallet, snapshotHash]) => sql`exists (
    select 1
    from ${marketplaceGenLayerClaimableBalances} as observed_claimable
    where observed_claimable.network = ${MARKETPLACE_GENLAYER_NETWORK}
      and observed_claimable.chain_id = ${MARKETPLACE_GENLAYER_CHAIN_ID}
      and observed_claimable.contract_address = ${marketplaceContractAddress()}
      and observed_claimable.wallet = ${wallet}
      and observed_claimable.observation_ticket = ${input.observationTicket}
      and observed_claimable.snapshot_hash = ${snapshotHash}
  )`);
  const [updated] = await getDb()
    .update(marketplaceGenLayerAssignments)
    .set({
      sharedProjectionPending: false,
      sharedProjectionAttempts: 0,
      sharedProjectionNextRepairAt: 0,
    })
    .where(and(
      eq(marketplaceGenLayerAssignments.projectionId, projectionId),
      eq(marketplaceGenLayerAssignments.sharedProjectionPending, true),
      eq(marketplaceGenLayerAssignments.sharedProjectionAnchorTxHash, anchorTransactionHash),
      eq(marketplaceGenLayerAssignments.lastTxHash, anchorTransactionHash),
      eq(marketplaceGenLayerAssignments.snapshotHash, normalizeHash(input.assignmentSnapshotHash)),
      eq(
        marketplaceGenLayerAssignments.sharedProjectionObservationTicket,
        input.observationTicket,
      ),
      sql`exists (
        select 1
        from ${marketplaceGenLayerCampaigns}
        where ${marketplaceGenLayerCampaigns.network} = ${MARKETPLACE_GENLAYER_NETWORK}
          and ${marketplaceGenLayerCampaigns.chainId} = ${MARKETPLACE_GENLAYER_CHAIN_ID}
          and ${marketplaceGenLayerCampaigns.contractAddress} = ${marketplaceContractAddress()}
          and ${marketplaceGenLayerCampaigns.campaignId} = ${campaignId}
          and ${marketplaceGenLayerCampaigns.observationTicket} = ${input.observationTicket}
          and ${marketplaceGenLayerCampaigns.snapshotHash} = ${campaignSnapshotHash}
      )`,
      ...claimableEvidence,
    ))
    .returning({ projectionId: marketplaceGenLayerAssignments.projectionId });
  if (updated) return true;
  const [current] = await getDb()
    .select({
      lastTxHash: marketplaceGenLayerAssignments.lastTxHash,
      pending: marketplaceGenLayerAssignments.sharedProjectionPending,
      anchor: marketplaceGenLayerAssignments.sharedProjectionAnchorTxHash,
    })
    .from(marketplaceGenLayerAssignments)
    .where(eq(marketplaceGenLayerAssignments.projectionId, projectionId))
    .limit(1);
  return Boolean(
    current &&
    current.lastTxHash === anchorTransactionHash &&
    current.anchor === anchorTransactionHash &&
    current.pending === false
  );
}

export async function deferGenLayerSharedResolutionRepair(input: {
  projectionId: string;
  anchorTransactionHash: string;
  snapshotHash: string;
  observationTicket: number | null;
  nowMs: number;
}): Promise<boolean> {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs <= 0) {
    throw new Error("The shared repair deferral clock is invalid.");
  }
  const projectionId = normalizeHash(input.projectionId);
  const anchorTransactionHash = normalizeHash(input.anchorTransactionHash);
  const snapshotHash = normalizeHash(input.snapshotHash);
  const [updated] = await getDb()
    .update(marketplaceGenLayerAssignments)
    .set({
      sharedProjectionAttempts: sql`${marketplaceGenLayerAssignments.sharedProjectionAttempts} + 1`,
      sharedProjectionNextRepairAt: sql`${input.nowMs} + case
        when ${marketplaceGenLayerAssignments.sharedProjectionAttempts} = 0 then 15000
        when ${marketplaceGenLayerAssignments.sharedProjectionAttempts} = 1 then 30000
        when ${marketplaceGenLayerAssignments.sharedProjectionAttempts} = 2 then 60000
        when ${marketplaceGenLayerAssignments.sharedProjectionAttempts} = 3 then 120000
        else 300000
      end`,
    })
    .where(and(
      eq(marketplaceGenLayerAssignments.projectionId, projectionId),
      eq(marketplaceGenLayerAssignments.sharedProjectionPending, true),
      eq(marketplaceGenLayerAssignments.sharedProjectionAnchorTxHash, anchorTransactionHash),
      eq(marketplaceGenLayerAssignments.lastTxHash, anchorTransactionHash),
      eq(marketplaceGenLayerAssignments.snapshotHash, snapshotHash),
      input.observationTicket === null
        ? isNull(marketplaceGenLayerAssignments.sharedProjectionObservationTicket)
        : eq(
          marketplaceGenLayerAssignments.sharedProjectionObservationTicket,
          input.observationTicket,
        ),
    ))
    .returning({ projectionId: marketplaceGenLayerAssignments.projectionId });
  return Boolean(updated);
}

export function assertGenLayerCampaignObservationFloors(
  current: GenLayerCampaignProjection,
  observed: GenLayerCampaignState,
  knownTerminal: Readonly<{
    settledAtto: string;
    creatorPaidAtto: string;
    brandRefundedAtto: string;
    feeAtto: string;
  }>,
): void {
  const cumulative = [
    [observed.settledAtto, current.settledAtto],
    [observed.creatorPaidAtto, current.creatorPaidAtto],
    [observed.brandRefundedAtto, current.brandRefundedAtto],
    [observed.feeAtto, current.feeAtto],
  ] as const;
  const sharedCountersUnchanged =
    observed.status === current.status &&
    observed.applicationCount === current.applicationCount &&
    observed.assignmentCount === current.assignmentCount &&
    cumulative.every(([next, before]) => next === before);
  if (
    cumulative.some(([next, before]) => BigInt(next) < BigInt(before)) ||
    observed.applicationCount < current.applicationCount ||
    observed.assignmentCount < current.assignmentCount ||
    (current.status !== "OPEN" && observed.status !== current.status) ||
    BigInt(observed.settledAtto) < BigInt(knownTerminal.settledAtto) ||
    BigInt(observed.creatorPaidAtto) < BigInt(knownTerminal.creatorPaidAtto) ||
    BigInt(observed.brandRefundedAtto) < BigInt(knownTerminal.brandRefundedAtto) ||
    BigInt(observed.feeAtto) < BigInt(knownTerminal.feeAtto) ||
    (
      sharedCountersUnchanged &&
      (
        BigInt(observed.availableAtto) < BigInt(current.availableAtto) ||
        BigInt(observed.reservedAtto) > BigInt(current.reservedAtto)
      )
    )
  ) {
    throw new Error("The campaign observation regresses durable accounting.");
  }
}

async function knownTerminalCampaignAccounting(campaignId: string): Promise<Readonly<{
  settledAtto: string;
  creatorPaidAtto: string;
  brandRefundedAtto: string;
  feeAtto: string;
}>> {
  const [row] = await getDb()
    .select({
      settledAtto: sql<string>`coalesce(sum(${marketplaceGenLayerAssignments.agreedRateAtto}), 0)`,
      creatorPaidAtto: sql<string>`coalesce(sum(${marketplaceGenLayerAssignments.creatorCreditAtto}), 0)`,
      brandRefundedAtto: sql<string>`coalesce(sum(${marketplaceGenLayerAssignments.brandCreditAtto}), 0)`,
      feeAtto: sql<string>`coalesce(sum(${marketplaceGenLayerAssignments.feeAtto}), 0)`,
    })
    .from(marketplaceGenLayerAssignments)
    .where(and(
      eq(marketplaceGenLayerAssignments.network, MARKETPLACE_GENLAYER_NETWORK),
      eq(marketplaceGenLayerAssignments.chainId, MARKETPLACE_GENLAYER_CHAIN_ID),
      eq(marketplaceGenLayerAssignments.contractAddress, marketplaceContractAddress()),
      eq(marketplaceGenLayerAssignments.campaignId, normalizeHash(campaignId)),
      inArray(marketplaceGenLayerAssignments.status, ["SETTLED_PASS", "SETTLED_FAIL", "REFUNDED"]),
    ));
  if (!row) throw new Error("Known terminal campaign accounting is unavailable.");
  return Object.freeze(row);
}

export async function upsertGenLayerWithdrawalProjection(input: {
  contractAddress: string;
  withdrawalId: string;
  account: string;
  nonce: number;
  amountAtto: string;
  status: "PENDING" | "EMITTED_UNCONFIRMED" | "CONFIRMED" | "RESTORED_FAILED";
  requestedAtEpoch: number;
  emittedAtEpoch: number;
  reconciledAtEpoch: number;
  evidenceHash: string;
  recapitalizedAtto: string;
  requestTxHash: string;
  lastTxHash: string;
  finalizedAt: number;
  snapshotHash: string;
  expectedPreviousSnapshotHash?: string;
  expectedPreviousLastTxHash?: string;
  nowMs?: number;
}): Promise<GenLayerWithdrawalProjection> {
  const nowMs = input.nowMs ?? Date.now();
  const expectedPreviousSnapshotHash = input.expectedPreviousSnapshotHash
    ? normalizeHash(input.expectedPreviousSnapshotHash)
    : null;
  const expectedPreviousLastTxHash = input.expectedPreviousLastTxHash
    ? normalizeHash(input.expectedPreviousLastTxHash)
    : null;
  if ((expectedPreviousSnapshotHash === null) !== (expectedPreviousLastTxHash === null)) {
    throw new Error("The withdrawal compare-and-set binding is incomplete.");
  }
  const normalizedLastTxHash = normalizeHash(input.lastTxHash);
  const normalizedSnapshotHash = normalizeHash(input.snapshotHash);
  const projectionId = deriveProjectionId({
    network: MARKETPLACE_GENLAYER_NETWORK,
    chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
    contractAddress: input.contractAddress,
    entityId: input.withdrawalId,
  });
  const [row] = await getDb()
    .insert(marketplaceGenLayerWithdrawals)
    .values({
      projectionId,
      withdrawalId: normalizeHash(input.withdrawalId),
      network: MARKETPLACE_GENLAYER_NETWORK,
      chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
      contractAddress: normalizeAddress(input.contractAddress),
      contractVersion: marketplaceContractVersion(),
      account: normalizeAddress(input.account),
      nonce: input.nonce,
      amountAtto: input.amountAtto,
      status: input.status,
      requestedAtEpoch: input.requestedAtEpoch,
      emittedAtEpoch: input.emittedAtEpoch,
      reconciledAtEpoch: input.reconciledAtEpoch,
      evidenceHash: normalizeHash(input.evidenceHash),
      recapitalizedAtto: input.recapitalizedAtto,
      requestTxHash: normalizeHash(input.requestTxHash),
      lastTxHash: normalizedLastTxHash,
      finalizedAt: input.finalizedAt,
      snapshotHash: normalizedSnapshotHash,
      projectedAt: nowMs,
    })
    .onConflictDoUpdate({
      target: marketplaceGenLayerWithdrawals.projectionId,
      set: {
        contractAddress: normalizeAddress(input.contractAddress),
        contractVersion: marketplaceContractVersion(),
        status: input.status,
        emittedAtEpoch: input.emittedAtEpoch,
        reconciledAtEpoch: input.reconciledAtEpoch,
        evidenceHash: normalizeHash(input.evidenceHash),
        recapitalizedAtto: input.recapitalizedAtto,
        lastTxHash: normalizedLastTxHash,
        finalizedAt: input.finalizedAt,
        snapshotHash: normalizedSnapshotHash,
        projectedAt: nowMs,
      },
      setWhere: expectedPreviousSnapshotHash === null
        ? sql`${marketplaceGenLayerWithdrawals.finalizedAt} < ${input.finalizedAt}`
        : sql`(
          ${marketplaceGenLayerWithdrawals.snapshotHash} = ${expectedPreviousSnapshotHash}
          and ${marketplaceGenLayerWithdrawals.lastTxHash} = ${expectedPreviousLastTxHash}
        )`,
    })
    .returning();
  if (row) return row;
  const [current] = await getDb()
    .select()
    .from(marketplaceGenLayerWithdrawals)
    .where(eq(marketplaceGenLayerWithdrawals.projectionId, projectionId))
    .limit(1);
  if (!current || current.finalizedAt < input.finalizedAt) {
    throw new Error("Withdrawal projection ordering could not be preserved.");
  }
  if (
    expectedPreviousSnapshotHash !== null &&
    !(
      current.lastTxHash === normalizedLastTxHash &&
      current.snapshotHash === normalizedSnapshotHash &&
      current.finalizedAt === input.finalizedAt
    )
  ) {
    throw new Error("Withdrawal projection compare-and-set could not be preserved.");
  }
  return current;
}

export async function findGenLayerWithdrawalProjectionById(
  withdrawalId: string,
): Promise<GenLayerWithdrawalProjection | null> {
  const projectionId = deriveProjectionId({
    network: MARKETPLACE_GENLAYER_NETWORK,
    chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
    contractAddress: marketplaceContractAddress(),
    entityId: normalizeHash(withdrawalId),
  });
  const [row] = await getDb()
    .select()
    .from(marketplaceGenLayerWithdrawals)
    .where(eq(marketplaceGenLayerWithdrawals.projectionId, projectionId))
    .limit(1);
  return row ?? null;
}

export async function findLatestGenLayerWithdrawalProjection(
  wallet: string,
): Promise<GenLayerWithdrawalProjection | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceGenLayerWithdrawals)
    .where(and(
      eq(marketplaceGenLayerWithdrawals.network, MARKETPLACE_GENLAYER_NETWORK),
      eq(marketplaceGenLayerWithdrawals.chainId, MARKETPLACE_GENLAYER_CHAIN_ID),
      eq(marketplaceGenLayerWithdrawals.contractAddress, marketplaceContractAddress()),
      eq(marketplaceGenLayerWithdrawals.account, normalizeAddress(wallet)),
    ))
    .orderBy(desc(marketplaceGenLayerWithdrawals.projectedAt))
    .limit(1);
  return row ?? null;
}

export async function updateGenLayerProjectionCursor(input: {
  contractAddress: string;
  transactionHash: string;
  finalizedAt: number;
  snapshotHash: string;
  nowMs?: number;
}): Promise<void> {
  const nowMs = input.nowMs ?? Date.now();
  await getDb()
    .insert(marketplaceGenLayerProjectionCursors)
    .values({
      network: MARKETPLACE_GENLAYER_NETWORK,
      chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
      contractAddress: input.contractAddress.toLowerCase(),
      contractVersion: marketplaceContractVersion(),
      lastTransactionHash: normalizeHash(input.transactionHash),
      lastFinalizedAt: input.finalizedAt,
      snapshotHash: normalizeHash(input.snapshotHash),
      revision: 1,
      updatedAt: nowMs,
    })
    .onConflictDoUpdate({
      target: [
        marketplaceGenLayerProjectionCursors.network,
        marketplaceGenLayerProjectionCursors.chainId,
        marketplaceGenLayerProjectionCursors.contractAddress,
      ],
      set: {
        contractVersion: marketplaceContractVersion(),
        lastTransactionHash: normalizeHash(input.transactionHash),
        lastFinalizedAt: input.finalizedAt,
        snapshotHash: normalizeHash(input.snapshotHash),
        revision: sql`${marketplaceGenLayerProjectionCursors.revision} + 1`,
        updatedAt: nowMs,
      },
      setWhere: sql`${marketplaceGenLayerProjectionCursors.lastFinalizedAt} < ${input.finalizedAt}`,
    });
}

export async function findGenLayerCampaignProjectionByLocalId(
  localCampaignId: string,
): Promise<GenLayerCampaignProjection | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceGenLayerCampaigns)
    .where(eq(marketplaceGenLayerCampaigns.localCampaignId, localCampaignId))
    .limit(1);
  return row ?? null;
}

export async function findGenLayerCampaignProjectionByOnchainId(
  campaignId: string,
): Promise<GenLayerCampaignProjection | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceGenLayerCampaigns)
    .where(and(
      eq(marketplaceGenLayerCampaigns.network, MARKETPLACE_GENLAYER_NETWORK),
      eq(marketplaceGenLayerCampaigns.chainId, MARKETPLACE_GENLAYER_CHAIN_ID),
      eq(marketplaceGenLayerCampaigns.contractAddress, marketplaceContractAddress()),
      eq(marketplaceGenLayerCampaigns.campaignId, normalizeHash(campaignId)),
    ))
    .limit(1);
  return row ?? null;
}

export async function findGenLayerAssignmentProjectionByApplicationId(
  localApplicationId: string,
): Promise<GenLayerAssignmentProjection | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceGenLayerAssignments)
    .where(
      eq(marketplaceGenLayerAssignments.localApplicationId, localApplicationId),
    )
    .limit(1);
  return row ?? null;
}

export async function findGenLayerAssignmentProjectionByAssignmentId(
  assignmentId: string,
): Promise<GenLayerAssignmentProjection | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceGenLayerAssignments)
    .where(eq(
      marketplaceGenLayerAssignments.projectionId,
      deriveProjectionId({
        network: MARKETPLACE_GENLAYER_NETWORK,
        chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
        contractAddress: marketplaceContractAddress(),
        entityId: normalizeHash(assignmentId),
      }),
    ))
    .limit(1);
  return row ?? null;
}

export async function listDueGenLayerResolutionProjections(input: {
  nowEpoch: number;
  limit: number;
}): Promise<GenLayerAssignmentProjection[]> {
  if (!Number.isSafeInteger(input.nowEpoch) || input.nowEpoch <= 0) {
    throw new Error("Resolution scan time is invalid.");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 25) {
    throw new Error("Resolution scan limit is invalid.");
  }
  return getDb()
    .select()
    .from(marketplaceGenLayerAssignments)
    .where(and(
      eq(marketplaceGenLayerAssignments.network, MARKETPLACE_GENLAYER_NETWORK),
      eq(marketplaceGenLayerAssignments.chainId, MARKETPLACE_GENLAYER_CHAIN_ID),
      eq(marketplaceGenLayerAssignments.contractAddress, marketplaceContractAddress()),
      inArray(marketplaceGenLayerAssignments.status, ["SUBMITTED", "UNDETERMINED"]),
      isNotNull(marketplaceGenLayerAssignments.resolutionRequestId),
      lte(marketplaceGenLayerAssignments.resolutionEligibleAtEpoch, input.nowEpoch),
      sql`${marketplaceGenLayerAssignments.resolutionAttempts} < ${marketplaceGenLayerAssignments.maxUndeterminedRetries}`,
    ))
    .orderBy(marketplaceGenLayerAssignments.resolutionEligibleAtEpoch)
    .limit(input.limit);
}

export type GenLayerAssignmentExpiryCandidate = Readonly<{
  assignment: GenLayerAssignmentProjection;
  campaign: GenLayerCampaignProjection;
}>;

/**
 * Returns only projection-bound expiry candidates. The automatic caller still
 * re-reads StudioNet immediately before dispatch because these rows are a
 * durable repair index, not the authority for contract state.
 */
export async function listDueGenLayerAssignmentExpiryProjections(input: {
  nowEpoch: number;
  limit: number;
}): Promise<GenLayerAssignmentExpiryCandidate[]> {
  assertProgressionScan(input, "Assignment expiry");
  return getDb()
    .select({
      assignment: marketplaceGenLayerAssignments,
      campaign: marketplaceGenLayerCampaigns,
    })
    .from(marketplaceGenLayerAssignments)
    .innerJoin(
      marketplaceGenLayerCampaigns,
      eq(
        marketplaceGenLayerAssignments.campaignProjectionId,
        marketplaceGenLayerCampaigns.projectionId,
      ),
    )
    .where(and(
      eq(marketplaceGenLayerAssignments.network, MARKETPLACE_GENLAYER_NETWORK),
      eq(marketplaceGenLayerAssignments.chainId, MARKETPLACE_GENLAYER_CHAIN_ID),
      eq(marketplaceGenLayerAssignments.contractAddress, marketplaceContractAddress()),
      eq(marketplaceGenLayerCampaigns.contractAddress, marketplaceContractAddress()),
      or(
        and(
          eq(marketplaceGenLayerAssignments.status, "SELECTED"),
          lt(marketplaceGenLayerAssignments.acceptanceDeadlineEpoch, input.nowEpoch),
        ),
        and(
          eq(marketplaceGenLayerAssignments.status, "ACCEPTED"),
          lt(marketplaceGenLayerCampaigns.submissionDeadlineEpoch, input.nowEpoch),
        ),
      ),
    ))
    .orderBy(marketplaceGenLayerAssignments.acceptanceDeadlineEpoch)
    .limit(input.limit);
}

/** Returns open, unreserved campaigns at the exact V2 finalization boundary. */
export async function listDueGenLayerCampaignFinalizationProjections(input: {
  nowEpoch: number;
  limit: number;
}): Promise<GenLayerCampaignProjection[]> {
  assertProgressionScan(input, "Campaign finalization");
  return getDb()
    .select()
    .from(marketplaceGenLayerCampaigns)
    .where(and(
      eq(marketplaceGenLayerCampaigns.network, MARKETPLACE_GENLAYER_NETWORK),
      eq(marketplaceGenLayerCampaigns.chainId, MARKETPLACE_GENLAYER_CHAIN_ID),
      eq(marketplaceGenLayerCampaigns.contractAddress, marketplaceContractAddress()),
      eq(marketplaceGenLayerCampaigns.status, "OPEN"),
      eq(marketplaceGenLayerCampaigns.reservedAtto, "0"),
      sql`${marketplaceGenLayerCampaigns.submissionDeadlineEpoch} + ${marketplaceGenLayerCampaigns.retentionSeconds} + 86400 <= ${input.nowEpoch}`,
    ))
    .orderBy(marketplaceGenLayerCampaigns.submissionDeadlineEpoch)
    .limit(input.limit);
}

function assertProgressionScan(
  input: Readonly<{ nowEpoch: number; limit: number }>,
  label: string,
): void {
  if (!Number.isSafeInteger(input.nowEpoch) || input.nowEpoch <= 0) {
    throw new Error(`${label} scan time is invalid.`);
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 25) {
    throw new Error(`${label} scan limit is invalid.`);
  }
}

export async function getGenLayerDashboardRows(wallet: string): Promise<{
  brandCampaigns: Array<{
    localCampaignId: string;
    campaignId: string;
    status: string;
    budgetAtto: string;
    availableAtto: string;
  }>;
  creatorApplications: Array<{
    localApplicationId: string;
    localCampaignId: string;
    assignmentId: string | null;
    status: string;
    agreedRateAtto: string | null;
  }>;
  claimableAtto: string;
}> {
  const normalizedWallet = normalizeAddress(wallet);
  const [brandRows, applicationRows, claimableRows] = await Promise.all([
    getDb()
      .select({
        localCampaignId: marketplaceGenLayerCampaigns.localCampaignId,
        campaignId: marketplaceGenLayerCampaigns.campaignId,
        status: marketplaceGenLayerCampaigns.status,
        budgetAtto: marketplaceGenLayerCampaigns.budgetAtto,
        availableAtto: marketplaceGenLayerCampaigns.availableAtto,
      })
      .from(marketplaceGenLayerCampaigns)
      .where(eq(marketplaceGenLayerCampaigns.brandWallet, normalizedWallet))
      .orderBy(desc(marketplaceGenLayerCampaigns.projectedAt)),
    getDb()
      .select({
        localApplicationId: marketplaceGenLayerApplicationsPrivate.id,
        localCampaignId:
          marketplaceGenLayerApplicationsPrivate.localCampaignId,
        assignmentId: marketplaceGenLayerAssignments.assignmentId,
        status: marketplaceGenLayerApplicationsPrivate.status,
        agreedRateAtto: marketplaceGenLayerAssignments.agreedRateAtto,
      })
      .from(marketplaceGenLayerApplicationsPrivate)
      .leftJoin(
        marketplaceGenLayerAssignments,
        eq(
          marketplaceGenLayerAssignments.localApplicationId,
          marketplaceGenLayerApplicationsPrivate.id,
        ),
      )
      .where(
        eq(
          marketplaceGenLayerApplicationsPrivate.creatorWallet,
          normalizedWallet,
        ),
      )
      .orderBy(desc(marketplaceGenLayerApplicationsPrivate.createdAt)),
    getDb()
      .select({ amountAtto: marketplaceGenLayerClaimableBalances.amountAtto })
      .from(marketplaceGenLayerClaimableBalances)
      .where(and(
        eq(marketplaceGenLayerClaimableBalances.network, MARKETPLACE_GENLAYER_NETWORK),
        eq(marketplaceGenLayerClaimableBalances.chainId, MARKETPLACE_GENLAYER_CHAIN_ID),
        eq(marketplaceGenLayerClaimableBalances.contractAddress, marketplaceContractAddress()),
        eq(marketplaceGenLayerClaimableBalances.wallet, normalizedWallet),
      )),
  ]);
  const claimableAtto = claimableRows.reduce(
    (total, row) => total + BigInt(row.amountAtto),
    0n,
  );
  return {
    brandCampaigns: brandRows,
    creatorApplications: applicationRows.map((row) => ({
      ...row,
      status: row.assignmentId ? "ONCHAIN" : row.status,
    })),
    claimableAtto: claimableAtto.toString(),
  };
}

type MarketplaceTransactionIntentBinding = {
  operation: MarketplaceGenLayerOperation;
  functionName: string;
  contractAddress: string;
  actorWallet: string;
  argsHash: string;
  valueAtto: string;
  localCampaignId: string | null;
  localApplicationId: string | null;
  onchainEntityId: string | null;
};

async function findReusablePreparedTransaction(
  input: MarketplaceTransactionIntentBinding & { reuseFinalized: boolean },
): Promise<GenLayerTransactionRow | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceGenLayerTransactions)
    .where(
      and(
        eq(marketplaceGenLayerTransactions.network, MARKETPLACE_GENLAYER_NETWORK),
        eq(marketplaceGenLayerTransactions.chainId, MARKETPLACE_GENLAYER_CHAIN_ID),
        eq(marketplaceGenLayerTransactions.operation, input.operation),
        eq(marketplaceGenLayerTransactions.functionName, input.functionName),
        eq(
          marketplaceGenLayerTransactions.contractAddress,
          input.contractAddress.toLowerCase(),
        ),
        eq(marketplaceGenLayerTransactions.actorWallet, input.actorWallet),
        eq(marketplaceGenLayerTransactions.argsHash, input.argsHash),
        eq(marketplaceGenLayerTransactions.valueAtto, input.valueAtto),
        input.localCampaignId === null
          ? sql`${marketplaceGenLayerTransactions.localCampaignId} is null`
          : eq(
              marketplaceGenLayerTransactions.localCampaignId,
              input.localCampaignId,
            ),
        input.localApplicationId === null
          ? sql`${marketplaceGenLayerTransactions.localApplicationId} is null`
          : eq(
              marketplaceGenLayerTransactions.localApplicationId,
              input.localApplicationId,
            ),
        input.onchainEntityId === null
          ? sql`${marketplaceGenLayerTransactions.onchainEntityId} is null`
          : eq(
              marketplaceGenLayerTransactions.onchainEntityId,
              input.onchainEntityId,
            ),
        inArray(
          marketplaceGenLayerTransactions.status,
          input.reuseFinalized
            ? [
                "PREPARED",
                "SUBMITTED",
                "ACCEPTED",
                "FINALIZED",
                "RECONCILIATION_REQUIRED",
              ]
            : [
                "PREPARED",
                "SUBMITTED",
                "ACCEPTED",
                "RECONCILIATION_REQUIRED",
              ],
        ),
      ),
    )
    .orderBy(desc(marketplaceGenLayerTransactions.createdAt))
    .limit(1);
  return row ?? null;
}

async function findGenLayerTransactionRetryPredecessor(
  input: MarketplaceTransactionIntentBinding & { includeFinalized: boolean },
): Promise<GenLayerTransactionRow | null> {
  const retryableStatuses: MarketplaceGenLayerTransactionStatus[] = input.includeFinalized
    ? ["EXECUTION_FAILED", "NETWORK_TERMINATED", "FINALIZED"]
    : ["EXECUTION_FAILED", "NETWORK_TERMINATED"];
  const [row] = await getDb()
    .select()
    .from(marketplaceGenLayerTransactions)
    .where(
      and(
        eq(marketplaceGenLayerTransactions.network, MARKETPLACE_GENLAYER_NETWORK),
        eq(marketplaceGenLayerTransactions.chainId, MARKETPLACE_GENLAYER_CHAIN_ID),
        eq(marketplaceGenLayerTransactions.operation, input.operation),
        eq(marketplaceGenLayerTransactions.functionName, input.functionName),
        eq(
          marketplaceGenLayerTransactions.contractAddress,
          input.contractAddress.toLowerCase(),
        ),
        eq(marketplaceGenLayerTransactions.actorWallet, input.actorWallet),
        eq(marketplaceGenLayerTransactions.argsHash, input.argsHash),
        eq(marketplaceGenLayerTransactions.valueAtto, input.valueAtto),
        input.localCampaignId === null
          ? sql`${marketplaceGenLayerTransactions.localCampaignId} is null`
          : eq(
              marketplaceGenLayerTransactions.localCampaignId,
              input.localCampaignId,
            ),
        input.localApplicationId === null
          ? sql`${marketplaceGenLayerTransactions.localApplicationId} is null`
          : eq(
              marketplaceGenLayerTransactions.localApplicationId,
              input.localApplicationId,
            ),
        input.onchainEntityId === null
          ? sql`${marketplaceGenLayerTransactions.onchainEntityId} is null`
          : eq(
              marketplaceGenLayerTransactions.onchainEntityId,
              input.onchainEntityId,
            ),
        inArray(marketplaceGenLayerTransactions.status, retryableStatuses),
      ),
    )
    .orderBy(
      desc(marketplaceGenLayerTransactions.createdAt),
      desc(marketplaceGenLayerTransactions.preparedId),
    )
    .limit(1);
  return row ?? null;
}

function marketplaceTransactionIntentBaseKey(
  input: MarketplaceTransactionIntentBinding,
): string {
  return canonicalHash({
    protocol: "influencedx-marketplace-transaction-intent-v1",
    network: MARKETPLACE_GENLAYER_NETWORK,
    chain_id: MARKETPLACE_GENLAYER_CHAIN_ID,
    contract_address: marketplaceContractAddress(),
    operation: input.operation,
    function_name: input.functionName,
    actor_wallet: input.actorWallet,
    args_hash: input.argsHash,
    value_atto: input.valueAtto,
    local_campaign_id: input.localCampaignId,
    local_application_id: input.localApplicationId,
    onchain_entity_id: input.onchainEntityId,
  });
}

function marketplaceTransactionAttemptKey(
  intentBaseKey: string,
  predecessor: GenLayerTransactionRow | null,
): string {
  return canonicalHash({
    protocol: "influencedx-marketplace-transaction-attempt-v1",
    intent_base_key: intentBaseKey,
    retry_predecessor_prepared_id: predecessor?.preparedId ?? null,
    retry_predecessor_status: predecessor?.status ?? null,
  });
}

function preparedDto(row: GenLayerTransactionRow): PreparedMarketplaceTransaction {
  return {
    preparedId: row.preparedId,
    operation: row.operation,
    call: {
      network: MARKETPLACE_GENLAYER_NETWORK,
      chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
      contractAddress: marketplaceRpcContractAddress(),
      functionName: row.functionName,
      args: row.args as never[],
      argTypes: row.argTypes,
      value: row.valueAtto,
    },
    recovery: row.transactionHash
      ? {
          preparedId: row.preparedId,
          transactionHash: row.transactionHash,
        }
      : null,
  };
}

function validateCall(call: MarketplaceGenLayerCall): void {
  if (
    call.network !== MARKETPLACE_GENLAYER_NETWORK ||
    call.chainId !== MARKETPLACE_GENLAYER_CHAIN_ID ||
    !/^0x[0-9a-f]{40}$/.test(call.contractAddress) ||
    !/^[a-z][a-z0-9_]{1,63}$/.test(call.functionName) ||
    call.argTypes.length !== call.args.length ||
    !call.argTypes.every((type) => MARKETPLACE_GENLAYER_ARG_TYPES.includes(type)) ||
    !call.args.every((value, index) => validTypedArgument(value, call.argTypes[index])) ||
    !decimalPattern.test(call.value)
  ) {
    throw new Error("The prepared GenLayer marketplace call is invalid.");
  }
}

function validTypedArgument(
  value: unknown,
  type: MarketplaceGenLayerCall["argTypes"][number],
): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "bool") return typeof value === "boolean";
  if (type === "uint256") {
    if (typeof value === "bigint") return value >= 0n && value < 1n << 256n;
    if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0;
    return typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << 256n;
  }
  if (type === "address") {
    if (typeof value === "string") return /^0x[0-9a-fA-F]{40}$/.test(value);
    return Boolean(value && typeof value === "object" && "bytes" in value);
  }
  return false;
}

function assertCampaignMoney(input: {
  budgetAtto: string;
  availableAtto: string;
  reservedAtto: string;
  settledAtto: string;
  creatorPaidAtto: string;
  brandRefundedAtto: string;
  feeAtto: string;
  status: string;
}): void {
  const values = [
    input.budgetAtto,
    input.availableAtto,
    input.reservedAtto,
    input.settledAtto,
    input.creatorPaidAtto,
    input.brandRefundedAtto,
    input.feeAtto,
  ];
  if (!values.every((value) => decimalPattern.test(value))) {
    throw new Error("Campaign GEN projection contains an invalid amount.");
  }
  const [budget, available, reserved, settled, creatorPaid, brandRefunded, fee] =
    values.map(BigInt);
  if (
    budget <= 0n ||
    available + reserved + creatorPaid + brandRefunded + fee !== budget ||
    settled < creatorPaid + fee ||
    settled > creatorPaid + fee + brandRefunded ||
    (input.status !== "OPEN" && (available !== 0n || reserved !== 0n))
  ) {
    throw new Error("Campaign GEN projection does not conserve funds.");
  }
}

function assertAssignmentMoney(input: {
  agreedRateAtto: string;
  creatorCreditAtto: string;
  brandCreditAtto: string;
  feeAtto: string;
}): void {
  const values = [
    input.agreedRateAtto,
    input.creatorCreditAtto,
    input.brandCreditAtto,
    input.feeAtto,
  ];
  if (!values.every((value) => decimalPattern.test(value))) {
    throw new Error("Assignment GEN projection contains an invalid amount.");
  }
  const [agreed, ...components] = values.map(BigInt);
  if (agreed <= 0n || components.reduce((a, b) => a + b, 0n) > agreed) {
    throw new Error("Assignment GEN projection does not conserve funds.");
  }
}

function jsonSafeArgs(args: readonly unknown[]): unknown[] {
  return JSON.parse(
    JSON.stringify(args, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  ) as unknown[];
}

function normalizeAddress(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("Wallet address is invalid.");
  }
  return normalized;
}

function normalizeHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Transaction hash is invalid.");
  }
  return normalized;
}

async function seedGenLayerJournalMaintenance(nowMs: number): Promise<void> {
  // The bound journal is already durable. A queue outage must not discard the
  // user's exact transaction hash; the daily bootstrap will repair the gap.
  await enqueueMarketplaceMaintenanceHeartbeat({
    nowMs,
    delaySeconds: 60,
  }).catch(() => undefined);
}

function firstRawRow(result: unknown): Record<string, unknown> | null {
  if (Array.isArray(result)) {
    const first = result[0];
    if (first && typeof first === "object") return first as Record<string, unknown>;
  }
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown[] }).rows;
    const first = rows?.[0];
    if (first && typeof first === "object") return first as Record<string, unknown>;
  }
  return null;
}

function snakeTransactionRow(row: Record<string, unknown>): GenLayerTransactionRow {
  return {
    preparedId: String(row.prepared_id),
    network: String(row.network),
    chainId: Number(row.chain_id),
    contractAddress: String(row.contract_address),
    operation: String(row.operation) as MarketplaceGenLayerOperation,
    functionName: String(row.function_name),
    args: row.args as unknown[],
    argTypes: row.arg_types as GenLayerTransactionRow["argTypes"],
    argsHash: String(row.args_hash),
    intentKey: nullableString(row.intent_key),
    valueAtto: String(row.value_atto),
    actorWallet: String(row.actor_wallet),
    localCampaignId: nullableString(row.local_campaign_id),
    localApplicationId: nullableString(row.local_application_id),
    onchainEntityId: nullableString(row.onchain_entity_id),
    transactionHash: nullableString(row.transaction_hash),
    status: String(row.status) as MarketplaceGenLayerTransactionStatus,
    lifecycleStatus: nullableString(row.lifecycle_status),
    executionResult: nullableString(row.execution_result),
    errorCode: nullableString(row.error_code),
    submittedAt: nullableNumber(row.submitted_at),
    acceptedAt: nullableNumber(row.accepted_at),
    finalizedAt: nullableNumber(row.finalized_at),
    lastCheckedAt: nullableNumber(row.last_checked_at),
    reconciliationAttempts: Number(row.reconciliation_attempts),
    nextReconcileAt: Number(row.next_reconcile_at),
    fenceToken: nullableString(row.fence_token),
    fenceExpiresAt: nullableNumber(row.fence_expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

const decimalPattern = /^(0|[1-9][0-9]{0,77})$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
