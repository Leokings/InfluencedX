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
  type GenLayerContentSource,
} from "./marketplace-genlayer-core.ts";
import { enqueueMarketplaceMaintenanceHeartbeat } from "./marketplace-genlayer-maintenance-queue.ts";

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
  nowMs?: number;
}): Promise<PreparedMarketplaceTransaction> {
  validateCall(input.call);
  const actorWallet = normalizeAddress(input.actorWallet);
  const nowMs = input.nowMs ?? Date.now();
  const args = jsonSafeArgs(input.call.args);
  const argsHash = canonicalHash(args);
  if (input.preparedId !== undefined && !uuidPattern.test(input.preparedId)) {
    throw new Error("The reserved GenLayer prepared ID is invalid.");
  }
  if (input.preparedId) {
    const reserved = await findGenLayerPreparedTransaction(input.preparedId);
    if (reserved) {
      assertReservedPreparedTransaction(reserved, {
        ...input,
        actorWallet,
        argsHash,
      });
      return preparedDto(reserved);
    }
  } else {
    const existing = await findReusablePreparedTransaction({
      operation: input.operation,
      contractAddress: input.call.contractAddress,
      actorWallet,
      argsHash,
      valueAtto: input.call.value,
      localCampaignId: input.localCampaignId ?? null,
      localApplicationId: input.localApplicationId ?? null,
      reuseFinalized: input.reuseFinalized ?? true,
    });
    if (existing) return preparedDto(existing);
  }

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
    .returning();
  if (!created) throw new Error("Prepared transaction insertion returned no row.");
  return preparedDto(created);
}

function assertReservedPreparedTransaction(
  row: GenLayerTransactionRow,
  input: {
    operation: MarketplaceGenLayerOperation;
    call: MarketplaceGenLayerCall;
    actorWallet: string;
    argsHash: string;
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

export async function findPreparedGenLayerApplicationResumeJournal(input: {
  localCampaignId: string;
  localApplicationId: string;
  actorWallet: string;
}): Promise<GenLayerTransactionRow | null> {
  const [row] = await getDb()
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
        eq(marketplaceGenLayerTransactions.operation, "APPLY"),
        eq(marketplaceGenLayerTransactions.functionName, "apply_to_campaign"),
        eq(
          marketplaceGenLayerTransactions.localCampaignId,
          input.localCampaignId,
        ),
        eq(
          marketplaceGenLayerTransactions.localApplicationId,
          input.localApplicationId,
        ),
        eq(
          marketplaceGenLayerTransactions.actorWallet,
          normalizeAddress(input.actorWallet),
        ),
        eq(marketplaceGenLayerTransactions.valueAtto, "0"),
        eq(marketplaceGenLayerTransactions.status, "PREPARED"),
        isNull(marketplaceGenLayerTransactions.transactionHash),
      ),
    )
    .orderBy(desc(marketplaceGenLayerTransactions.createdAt))
    .limit(1);
  return row ?? null;
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
  nowMs?: number;
}): Promise<GenLayerCampaignProjection> {
  assertCampaignMoney(input);
  const nowMs = input.nowMs ?? Date.now();
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
      snapshotHash: normalizeHash(input.snapshotHash),
      projectedAt: nowMs,
    })
    .onConflictDoUpdate({
      target: marketplaceGenLayerCampaigns.projectionId,
      set: {
        budgetAtto: input.budgetAtto,
        availableAtto: input.availableAtto,
        reservedAtto: input.reservedAtto,
        settledAtto: input.settledAtto,
        creatorPaidAtto: input.creatorPaidAtto,
        brandRefundedAtto: input.brandRefundedAtto,
        feeAtto: input.feeAtto,
        status: input.status,
        feeBps: input.feeBps,
        treasuryWallet: normalizeAddress(input.treasuryWallet),
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
        snapshotHash: normalizeHash(input.snapshotHash),
        projectedAt: nowMs,
      },
      setWhere: sql`${marketplaceGenLayerCampaigns.finalizedAt} < ${input.finalizedAt}`,
    })
    .returning();
  if (row) return row;
  const [current] = await getDb()
    .select()
    .from(marketplaceGenLayerCampaigns)
    .where(eq(marketplaceGenLayerCampaigns.projectionId, projectionId))
    .limit(1);
  if (!current || current.finalizedAt < input.finalizedAt) {
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
  nowMs?: number;
}): Promise<GenLayerAssignmentProjection> {
  assertAssignmentMoney(input);
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
      lastTxHash: normalizeHash(input.lastTxHash),
      finalizedAt: input.finalizedAt,
      snapshotHash: normalizeHash(input.snapshotHash),
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
        lastTxHash: normalizeHash(input.lastTxHash),
        finalizedAt: input.finalizedAt,
        snapshotHash: normalizeHash(input.snapshotHash),
        projectedAt: nowMs,
      },
      setWhere: sql`${marketplaceGenLayerAssignments.finalizedAt} < ${input.finalizedAt}`,
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
  return current;
}

export async function upsertGenLayerClaimableBalance(input: {
  contractAddress: string;
  wallet: string;
  amountAtto: string;
  nextWithdrawalNonce: number;
  transactionHash: string;
  snapshotHash: string;
  nowMs?: number;
}): Promise<void> {
  if (!decimalPattern.test(input.amountAtto)) {
    throw new Error("Claimable GEN amount is invalid.");
  }
  const nowMs = input.nowMs ?? Date.now();
  await getDb()
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
        lastTransactionHash: normalizeHash(input.transactionHash),
        snapshotHash: normalizeHash(input.snapshotHash),
        projectedAt: nowMs,
      },
      setWhere: sql`${marketplaceGenLayerClaimableBalances.projectedAt} < ${nowMs}`,
    });
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
  nowMs?: number;
}): Promise<GenLayerWithdrawalProjection> {
  const nowMs = input.nowMs ?? Date.now();
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
      lastTxHash: normalizeHash(input.lastTxHash),
      finalizedAt: input.finalizedAt,
      snapshotHash: normalizeHash(input.snapshotHash),
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
        lastTxHash: normalizeHash(input.lastTxHash),
        finalizedAt: input.finalizedAt,
        snapshotHash: normalizeHash(input.snapshotHash),
        projectedAt: nowMs,
      },
      setWhere: sql`${marketplaceGenLayerWithdrawals.finalizedAt} < ${input.finalizedAt}`,
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

async function findReusablePreparedTransaction(input: {
  operation: MarketplaceGenLayerOperation;
  contractAddress: string;
  actorWallet: string;
  argsHash: string;
  valueAtto: string;
  localCampaignId: string | null;
  localApplicationId: string | null;
  reuseFinalized: boolean;
}): Promise<GenLayerTransactionRow | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceGenLayerTransactions)
    .where(
      and(
        eq(marketplaceGenLayerTransactions.operation, input.operation),
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
    settled !== creatorPaid + brandRefunded + fee
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
