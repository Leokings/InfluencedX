import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  ne,
  or,
  sql,
  type InferSelectModel,
  type SQL,
} from "drizzle-orm";
import { getDb } from "../db/index.ts";
import {
  marketplaceApplications,
  marketplaceCampaigns,
  marketplaceCreatorMetricsSnapshots,
  marketplaceCreatorProfiles,
  verificationRequests,
  type MarketplaceCampaignStatus,
} from "../db/postgres-schema.ts";

export type CampaignRow = InferSelectModel<typeof marketplaceCampaigns>;
export type ApplicationRow = InferSelectModel<typeof marketplaceApplications>;
export type CreatorProfileRow = InferSelectModel<
  typeof marketplaceCreatorProfiles
>;
export type CreatorMetricsRow = InferSelectModel<
  typeof marketplaceCreatorMetricsSnapshots
>;

export type FinalizedCreatorMetricsSnapshot = {
  profileId: string;
  requestId: string;
  txHash: string;
  followersCount: number;
  accountCreatedAt: number;
  postsSampled: number;
  medianEngagementCount: number;
  engagementRateBps: number;
  estimatedPayMinAmount: string;
  estimatedPayMaxAmount: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "UNDETERMINED";
  evidenceHash: string;
  capturedAt: number;
  expiresAt: number;
  nowMs: number;
};

/**
 * Treat a GenLayer request ID as an immutable idempotency key. `createdAt` is
 * deliberately excluded because a safe retry can happen at a later wall-clock
 * time; every field derived from the finalized result must still match exactly.
 */
export function exactMetricsSnapshot(
  snapshot: CreatorMetricsRow,
  input: FinalizedCreatorMetricsSnapshot,
): boolean {
  return (
    snapshot.id === input.requestId &&
    snapshot.profileId === input.profileId &&
    snapshot.followersCount === input.followersCount &&
    snapshot.accountCreatedAt === input.accountCreatedAt &&
    snapshot.postsSampled === input.postsSampled &&
    snapshot.medianEngagementCount === input.medianEngagementCount &&
    snapshot.engagementRateBps === input.engagementRateBps &&
    snapshot.estimatedPayMinAmount === input.estimatedPayMinAmount &&
    snapshot.estimatedPayMaxAmount === input.estimatedPayMaxAmount &&
    snapshot.riskLevel === input.riskLevel &&
    snapshot.evidenceHash === input.evidenceHash &&
    snapshot.genlayerRequestId === input.requestId &&
    snapshot.genlayerTxHash === input.txHash &&
    snapshot.capturedAt === input.capturedAt &&
    snapshot.expiresAt === input.expiresAt
  );
}

export type MarketplaceResolutionContext = {
  campaign: CampaignRow;
  application: ApplicationRow;
};

export const marketplaceGenLayerSubmitterStatuses = [
  "QUEUED",
  "PRECHECKING",
  "PRECHECK_FAILED",
  "BROADCASTING",
  "SUBMITTED",
  "POLLING",
  "FINALIZED",
  "EXECUTION_FAILED",
  "NETWORK_TERMINATED",
  "RECONCILIATION_REQUIRED",
  "POLLING_EXHAUSTED",
  "POISONED",
] as const;

export type MarketplaceGenLayerSubmitterStatus =
  (typeof marketplaceGenLayerSubmitterStatuses)[number];

export type CampaignListFilter = {
  viewerWallet?: string | null;
  status?: MarketplaceCampaignStatus;
  category?: string;
  format?: string;
  limit: number;
};

export async function insertCampaign(input: {
  id: string;
  brandWallet: string;
  brandName: string;
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
  budgetAmount: string;
  tokenAddress: string;
  chainId: number;
  deadlineAt: number;
  selectionDeadlineAt: number;
  submissionDeadlineAt: number;
  retentionSeconds: number;
  nowMs: number;
}): Promise<CampaignRow> {
  const [created] = await getDb()
    .insert(marketplaceCampaigns)
    .values({
      ...input,
      tokenDecimals: 6,
      status: "FUNDING",
      fundingStatus: "UNFUNDED",
      revision: 0,
      createdAt: input.nowMs,
      updatedAt: input.nowMs,
    })
    .returning();
  if (!created) throw new Error("Campaign insertion returned no row.");
  return created;
}

export async function findCampaign(id: string): Promise<CampaignRow | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceCampaigns)
    .where(eq(marketplaceCampaigns.id, id))
    .limit(1);
  return row ?? null;
}

export async function listCampaignRows(
  filter: CampaignListFilter,
): Promise<CampaignRow[]> {
  const conditions: SQL[] = [];
  if (filter.status) {
    conditions.push(eq(marketplaceCampaigns.status, filter.status));
    if (["DRAFT", "FUNDING"].includes(filter.status)) {
      if (!filter.viewerWallet) return [];
      conditions.push(
        eq(marketplaceCampaigns.brandWallet, filter.viewerWallet),
      );
    }
  } else {
    const publiclyVisible = inArray(marketplaceCampaigns.status, [
      "OPEN",
      "MATCHED",
      "ACTIVE",
      "SUBMITTED",
      "RESOLVING",
      "PAID",
      "REFUNDED",
      "CANCELLED",
    ]);
    conditions.push(
      filter.viewerWallet
        ? or(
            publiclyVisible,
            eq(marketplaceCampaigns.brandWallet, filter.viewerWallet),
          )!
        : publiclyVisible,
    );
  }
  if (filter.category) {
    conditions.push(eq(marketplaceCampaigns.category, filter.category));
  }
  if (filter.format) {
    conditions.push(eq(marketplaceCampaigns.format, filter.format));
  }
  return getDb()
    .select()
    .from(marketplaceCampaigns)
    .where(and(...conditions))
    .orderBy(desc(marketplaceCampaigns.createdAt), asc(marketplaceCampaigns.id))
    .limit(filter.limit);
}

export async function applicationCounts(
  campaignIds: string[],
): Promise<Map<string, number>> {
  if (campaignIds.length === 0) return new Map();
  const rows = await getDb()
    .select({
      campaignId: marketplaceApplications.campaignId,
      count: sql<number>`count(*)::integer`,
    })
    .from(marketplaceApplications)
    .where(inArray(marketplaceApplications.campaignId, campaignIds))
    .groupBy(marketplaceApplications.campaignId);
  return new Map(rows.map((row) => [row.campaignId, row.count]));
}

export async function marketplaceSummary(): Promise<{
  openCampaigns: number;
  lockedAmount: string;
}> {
  const result = await getDb().execute(sql`
    select
      count(*) filter (where status = 'OPEN')::integer as open_campaigns,
      coalesce(sum(budget_amount) filter (
        where funding_status = 'FUNDED'
          and status in ('OPEN', 'MATCHED', 'ACTIVE', 'SUBMITTED', 'RESOLVING')
      ), 0)::text as locked_amount
    from ${marketplaceCampaigns}
  `);
  const row = rawRows(result)[0];
  return {
    openCampaigns:
      typeof row?.open_campaigns === "number"
        ? row.open_campaigns
        : Number(row?.open_campaigns ?? 0),
    lockedAmount:
      typeof row?.locked_amount === "string" ? row.locked_amount : "0",
  };
}

export async function listApplicationsForCampaign(
  campaignId: string,
): Promise<ApplicationRow[]> {
  return getDb()
    .select()
    .from(marketplaceApplications)
    .where(eq(marketplaceApplications.campaignId, campaignId))
    .orderBy(asc(marketplaceApplications.createdAt));
}

export async function findCreatorApplication(
  campaignId: string,
  creatorWallet: string,
): Promise<ApplicationRow | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceApplications)
    .where(
      and(
        eq(marketplaceApplications.campaignId, campaignId),
        eq(marketplaceApplications.creatorWallet, creatorWallet),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findApplication(
  campaignId: string,
  applicationId: string,
): Promise<ApplicationRow | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceApplications)
    .where(
      and(
        eq(marketplaceApplications.campaignId, campaignId),
        eq(marketplaceApplications.id, applicationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function upsertVerifiedCreatorProfile(input: {
  wallet: string;
  nowMs: number;
}): Promise<CreatorProfileRow | null> {
  const [source] = await getDb()
    .select({
      baseProfileId: verificationRequests.baseProfileId,
      identityHash: verificationRequests.baseProfileIdentityHash,
      handleHash: verificationRequests.baseProfileHandleHash,
      verificationPostHash:
        verificationRequests.baseProfileVerificationPostHash,
      verificationTxHash: verificationRequests.baseRelayTxHash,
      credentialExpiresAt: verificationRequests.baseProfileExpiresAt,
      verifiedAt: verificationRequests.baseConfirmedAt,
      publicHandle: verificationRequests.handle,
    })
    .from(verificationRequests)
    .where(
      and(
        sql`lower(${verificationRequests.wallet}) = ${input.wallet.toLowerCase()}`,
        eq(verificationRequests.baseRelayStatus, "CONFIRMED"),
        eq(verificationRequests.baseProfileActive, true),
        eq(verificationRequests.baseProfileVerified, true),
        gt(verificationRequests.baseProfileExpiresAt, input.nowMs),
      ),
    )
    .orderBy(desc(verificationRequests.baseConfirmedAt))
    .limit(1);

  if (
    !source?.baseProfileId ||
    !source.identityHash ||
    !source.handleHash ||
    !source.verificationPostHash ||
    !source.verificationTxHash ||
    source.credentialExpiresAt === null ||
    source.verifiedAt === null
  ) {
    return null;
  }

  const id = randomUUID();
  const [profile] = await getDb()
    .insert(marketplaceCreatorProfiles)
    .values({
      id,
      ownerWallet: input.wallet,
      baseProfileId: source.baseProfileId,
      identityHash: source.identityHash,
      handleHash: source.handleHash,
      verificationPostHash: source.verificationPostHash,
      verificationTxHash: source.verificationTxHash,
      publicHandle: source.publicHandle,
      categories: [],
      visibility: "PUBLIC",
      active: true,
      credentialExpiresAt: source.credentialExpiresAt,
      verifiedAt: source.verifiedAt,
      revision: 0,
      createdAt: input.nowMs,
      updatedAt: input.nowMs,
    })
    .onConflictDoUpdate({
      target: marketplaceCreatorProfiles.ownerWallet,
      set: {
        baseProfileId: source.baseProfileId,
        identityHash: source.identityHash,
        handleHash: source.handleHash,
        verificationPostHash: source.verificationPostHash,
        verificationTxHash: source.verificationTxHash,
        publicHandle: source.publicHandle,
        active: true,
        credentialExpiresAt: source.credentialExpiresAt,
        verifiedAt: source.verifiedAt,
        revision: sql`${marketplaceCreatorProfiles.revision} + 1`,
        updatedAt: input.nowMs,
      },
    })
    .returning();
  return profile ?? null;
}

export async function insertApplicationIfOpen(input: {
  campaignId: string;
  profile: CreatorProfileRow;
  requestedAmount: string;
  pitch: string;
  nowMs: number;
}): Promise<ApplicationRow | null> {
  const id = randomUUID();
  const result = await getDb().execute(sql`
    insert into ${marketplaceApplications} (
      id,
      campaign_id,
      creator_wallet,
      creator_profile_id,
      creator_handle,
      creator_handle_hash,
      identity_hash,
      requested_amount,
      pitch,
      status,
      revision,
      resolution_round,
      created_at,
      updated_at
    )
    select
      ${id},
      campaign.id,
      ${input.profile.ownerWallet},
      ${input.profile.id},
      ${input.profile.publicHandle},
      ${input.profile.handleHash},
      ${input.profile.identityHash},
      ${input.requestedAmount}::numeric,
      ${input.pitch},
      'APPLIED'::marketplace_application_status,
      0,
      0,
      ${input.nowMs},
      ${input.nowMs}
    from ${marketplaceCampaigns} as campaign
    where campaign.id = ${input.campaignId}
      and campaign.status = 'OPEN'
      and campaign.funding_status = 'FUNDED'
      and campaign.deadline_at > ${input.nowMs}
      and ${input.requestedAmount}::numeric <= campaign.budget_amount
    on conflict (campaign_id, creator_wallet) do nothing
    returning id
  `);
  const createdId = stringField(rawRows(result)[0], "id");
  return createdId ? findApplication(input.campaignId, createdId) : null;
}

export async function selectApplicationAtomically(input: {
  campaignId: string;
  applicationId: string;
  brandWallet: string;
  expectedCampaignRevision: number;
  expectedApplicationRevision: number;
  identityHash: string;
  agreementHash: string;
  nowMs: number;
}): Promise<boolean> {
  const result = await getDb().execute(sql`
    with candidate as (
      select application.id
      from ${marketplaceApplications} as application
      where application.id = ${input.applicationId}
        and application.campaign_id = ${input.campaignId}
        and application.status = 'APPLIED'
        and application.revision = ${input.expectedApplicationRevision}
    ), campaign_transition as (
      update ${marketplaceCampaigns} as campaign
      set
        status = 'MATCHED',
        revision = campaign.revision + 1,
        updated_at = ${input.nowMs}
      where campaign.id = ${input.campaignId}
        and campaign.brand_wallet = ${input.brandWallet}
        and campaign.status = 'OPEN'
        and campaign.funding_status = 'FUNDED'
        and campaign.deadline_at > ${input.nowMs}
        and campaign.revision = ${input.expectedCampaignRevision}
        and exists (select 1 from candidate)
      returning campaign.id
    ), application_transition as (
      update ${marketplaceApplications} as application
      set
        status = 'SELECTED',
        selected_at = ${input.nowMs},
        identity_hash = ${input.identityHash},
        agreement_hash = ${input.agreementHash},
        revision = application.revision + 1,
        updated_at = ${input.nowMs}
      where application.id = ${input.applicationId}
        and application.status = 'APPLIED'
        and application.revision = ${input.expectedApplicationRevision}
        and exists (select 1 from campaign_transition)
      returning application.id
    ), rejected as (
      update ${marketplaceApplications} as application
      set
        status = 'REJECTED',
        revision = application.revision + 1,
        updated_at = ${input.nowMs}
      where application.campaign_id = ${input.campaignId}
        and application.id <> ${input.applicationId}
        and application.status = 'APPLIED'
        and exists (select 1 from application_transition)
      returning application.id
    )
    select id from application_transition
  `);
  return stringField(rawRows(result)[0], "id") === input.applicationId;
}

export async function acceptApplicationAtomically(input: {
  campaignId: string;
  applicationId: string;
  creatorWallet: string;
  expectedCampaignRevision: number;
  expectedApplicationRevision: number;
  escrowAssignmentId: string;
  agreementHash: string;
  acceptanceTxHash: string;
  nowMs: number;
}): Promise<boolean> {
  const result = await getDb().execute(sql`
    with candidate as (
      select application.id
      from ${marketplaceApplications} as application
      where application.id = ${input.applicationId}
        and application.campaign_id = ${input.campaignId}
        and application.creator_wallet = ${input.creatorWallet}
        and application.status = 'SELECTED'
        and application.escrow_assignment_id = ${input.escrowAssignmentId}
        and application.agreement_hash = ${input.agreementHash}
        and application.selection_tx_hash is not null
        and application.revision = ${input.expectedApplicationRevision}
    ), campaign_transition as (
      update ${marketplaceCampaigns} as campaign
      set
        status = 'ACTIVE',
        revision = campaign.revision + 1,
        updated_at = ${input.nowMs}
      where campaign.id = ${input.campaignId}
        and campaign.status = 'MATCHED'
        and campaign.revision = ${input.expectedCampaignRevision}
        and exists (select 1 from candidate)
      returning campaign.id
    ), application_transition as (
      update ${marketplaceApplications} as application
      set
        status = 'ACCEPTED',
        accepted_at = ${input.nowMs},
        acceptance_tx_hash = ${input.acceptanceTxHash},
        revision = application.revision + 1,
        updated_at = ${input.nowMs}
      where application.id = ${input.applicationId}
        and application.status = 'SELECTED'
        and application.revision = ${input.expectedApplicationRevision}
        and exists (select 1 from campaign_transition)
      returning application.id
    )
    select id from application_transition
  `);
  return stringField(rawRows(result)[0], "id") === input.applicationId;
}

export async function confirmCampaignFundingAtomically(input: {
  campaignId: string;
  brandWallet: string;
  expectedRevision: number;
  escrowContract: string;
  escrowCampaignId: string;
  fundingTxHash: string;
  nowMs: number;
}): Promise<boolean> {
  const [updated] = await getDb()
    .update(marketplaceCampaigns)
    .set({
      status: "OPEN",
      fundingStatus: "FUNDED",
      escrowContract: input.escrowContract,
      escrowCampaignId: input.escrowCampaignId,
      fundingTxHash: input.fundingTxHash,
      fundedAt: input.nowMs,
      revision: input.expectedRevision + 1,
      updatedAt: input.nowMs,
    })
    .where(
      and(
        eq(marketplaceCampaigns.id, input.campaignId),
        eq(marketplaceCampaigns.brandWallet, input.brandWallet),
        eq(marketplaceCampaigns.status, "FUNDING"),
        ne(marketplaceCampaigns.fundingStatus, "FUNDED"),
        eq(marketplaceCampaigns.revision, input.expectedRevision),
      ),
    )
    .returning({ id: marketplaceCampaigns.id });
  return updated?.id === input.campaignId;
}

export async function confirmApplicationSelectionAtomically(input: {
  campaignId: string;
  applicationId: string;
  brandWallet: string;
  expectedCampaignRevision: number;
  expectedApplicationRevision: number;
  agreementHash: string;
  escrowAssignmentId: string;
  selectionTxHash: string;
  nowMs: number;
}): Promise<boolean> {
  const result = await getDb().execute(sql`
    with candidate as (
      select application.id
      from ${marketplaceApplications} as application
      join ${marketplaceCampaigns} as campaign
        on campaign.id = application.campaign_id
      where application.id = ${input.applicationId}
        and application.campaign_id = ${input.campaignId}
        and application.status = 'SELECTED'
        and application.agreement_hash = ${input.agreementHash}
        and application.selection_tx_hash is null
        and application.escrow_assignment_id is null
        and application.revision = ${input.expectedApplicationRevision}
        and campaign.brand_wallet = ${input.brandWallet}
        and campaign.status = 'MATCHED'
        and campaign.revision = ${input.expectedCampaignRevision}
    ), campaign_transition as (
      update ${marketplaceCampaigns} as campaign
      set revision = campaign.revision + 1, updated_at = ${input.nowMs}
      where campaign.id = ${input.campaignId}
        and campaign.brand_wallet = ${input.brandWallet}
        and campaign.status = 'MATCHED'
        and campaign.revision = ${input.expectedCampaignRevision}
        and exists (select 1 from candidate)
      returning campaign.id
    ), application_transition as (
      update ${marketplaceApplications} as application
      set
        escrow_assignment_id = ${input.escrowAssignmentId},
        selection_tx_hash = ${input.selectionTxHash},
        revision = application.revision + 1,
        updated_at = ${input.nowMs}
      where application.id = ${input.applicationId}
        and application.campaign_id = ${input.campaignId}
        and application.status = 'SELECTED'
        and application.agreement_hash = ${input.agreementHash}
        and application.selection_tx_hash is null
        and application.escrow_assignment_id is null
        and application.revision = ${input.expectedApplicationRevision}
        and exists (select 1 from campaign_transition)
      returning application.id
    )
    select id from application_transition
  `);
  return stringField(rawRows(result)[0], "id") === input.applicationId;
}

export async function prepareApplicationSubmissionAtomically(input: {
  campaignId: string;
  applicationId: string;
  creatorWallet: string;
  expectedRevision: number;
  xPostId: string;
  postIdHash: string;
  submissionHash: string;
  nowMs: number;
}): Promise<boolean> {
  const [updated] = await getDb()
    .update(marketplaceApplications)
    .set({
      xPostId: input.xPostId,
      postIdHash: input.postIdHash,
      submissionHash: input.submissionHash,
      revision: input.expectedRevision + 1,
      updatedAt: input.nowMs,
    })
    .where(
      and(
        eq(marketplaceApplications.id, input.applicationId),
        eq(marketplaceApplications.campaignId, input.campaignId),
        eq(marketplaceApplications.creatorWallet, input.creatorWallet),
        eq(marketplaceApplications.status, "ACCEPTED"),
        eq(marketplaceApplications.revision, input.expectedRevision),
        sql`${marketplaceApplications.submissionHash} is null`,
        sql`${marketplaceApplications.postIdHash} is null`,
        sql`${marketplaceApplications.xPostId} is null`,
      ),
    )
    .returning({ id: marketplaceApplications.id });
  return updated?.id === input.applicationId;
}

export async function confirmApplicationSubmissionAtomically(input: {
  campaignId: string;
  applicationId: string;
  creatorWallet: string;
  expectedCampaignRevision: number;
  expectedApplicationRevision: number;
  submissionHash: string;
  postIdHash: string;
  submissionTxHash: string;
  nowMs: number;
}): Promise<boolean> {
  const result = await getDb().execute(sql`
    with candidate as (
      select application.id
      from ${marketplaceApplications} as application
      join ${marketplaceCampaigns} as campaign
        on campaign.id = application.campaign_id
      where application.id = ${input.applicationId}
        and application.campaign_id = ${input.campaignId}
        and application.creator_wallet = ${input.creatorWallet}
        and application.status = 'ACCEPTED'
        and application.submission_hash = ${input.submissionHash}
        and application.post_id_hash = ${input.postIdHash}
        and application.submission_tx_hash is null
        and application.revision = ${input.expectedApplicationRevision}
        and campaign.status = 'ACTIVE'
        and campaign.revision = ${input.expectedCampaignRevision}
    ), campaign_transition as (
      update ${marketplaceCampaigns} as campaign
      set
        status = 'SUBMITTED',
        revision = campaign.revision + 1,
        updated_at = ${input.nowMs}
      where campaign.id = ${input.campaignId}
        and campaign.status = 'ACTIVE'
        and campaign.revision = ${input.expectedCampaignRevision}
        and exists (select 1 from candidate)
      returning campaign.id
    ), application_transition as (
      update ${marketplaceApplications} as application
      set
        submission_tx_hash = ${input.submissionTxHash},
        submitted_at = ${input.nowMs},
        revision = application.revision + 1,
        updated_at = ${input.nowMs}
      where application.id = ${input.applicationId}
        and application.campaign_id = ${input.campaignId}
        and application.creator_wallet = ${input.creatorWallet}
        and application.status = 'ACCEPTED'
        and application.submission_hash = ${input.submissionHash}
        and application.post_id_hash = ${input.postIdHash}
        and application.submission_tx_hash is null
        and application.revision = ${input.expectedApplicationRevision}
        and exists (select 1 from campaign_transition)
      returning application.id
    )
    select id from application_transition
  `);
  return stringField(rawRows(result)[0], "id") === input.applicationId;
}

export async function confirmApplicationResolutionRequestAtomically(input: {
  campaignId: string;
  applicationId: string;
  expectedCampaignRevision: number;
  expectedApplicationRevision: number;
  requestId: string;
  resolutionRound: number;
  resolutionRequestTxHash: string;
  nowMs: number;
}): Promise<boolean> {
  const result = await getDb().execute(sql`
    with candidate as (
      select application.id
      from ${marketplaceApplications} as application
      join ${marketplaceCampaigns} as campaign
        on campaign.id = application.campaign_id
      where application.id = ${input.applicationId}
        and application.campaign_id = ${input.campaignId}
        and application.status = 'ACCEPTED'
        and application.submission_tx_hash is not null
        and application.request_id is null
        and application.resolution_request_tx_hash is null
        and application.revision = ${input.expectedApplicationRevision}
        and campaign.status = 'SUBMITTED'
        and campaign.revision = ${input.expectedCampaignRevision}
    ), campaign_transition as (
      update ${marketplaceCampaigns} as campaign
      set
        status = 'RESOLVING',
        revision = campaign.revision + 1,
        updated_at = ${input.nowMs}
      where campaign.id = ${input.campaignId}
        and campaign.status = 'SUBMITTED'
        and campaign.revision = ${input.expectedCampaignRevision}
        and exists (select 1 from candidate)
      returning campaign.id
    ), application_transition as (
      update ${marketplaceApplications} as application
      set
        request_id = ${input.requestId},
        resolution_round = ${input.resolutionRound},
        resolution_request_tx_hash = ${input.resolutionRequestTxHash},
        resolution_requested_at = ${input.nowMs},
        resolution_outcome = null,
        resolution_evidence_hash = null,
        resolution_tx_hash = null,
        revision = application.revision + 1,
        updated_at = ${input.nowMs}
      where application.id = ${input.applicationId}
        and application.campaign_id = ${input.campaignId}
        and application.status = 'ACCEPTED'
        and application.submission_tx_hash is not null
        and application.request_id is null
        and application.resolution_request_tx_hash is null
        and application.revision = ${input.expectedApplicationRevision}
        and exists (select 1 from campaign_transition)
      returning application.id
    )
    select id from application_transition
  `);
  return stringField(rawRows(result)[0], "id") === input.applicationId;
}

export async function findMarketplaceResolutionContextByRequestId(
  requestId: string,
): Promise<MarketplaceResolutionContext | null> {
  const [row] = await getDb()
    .select({
      campaign: marketplaceCampaigns,
      application: marketplaceApplications,
    })
    .from(marketplaceApplications)
    .innerJoin(
      marketplaceCampaigns,
      eq(marketplaceCampaigns.id, marketplaceApplications.campaignId),
    )
    .where(
      and(
        eq(marketplaceApplications.requestId, requestId),
        eq(marketplaceApplications.status, "ACCEPTED"),
        eq(marketplaceCampaigns.status, "RESOLVING"),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function recordGenLayerSubmissionAccepted(input: {
  applicationId: string;
  requestId: string;
  status: MarketplaceGenLayerSubmitterStatus;
  txHash: string | null;
  errorCode: string | null;
  nowMs: number;
}): Promise<ApplicationRow> {
  const context = await exactResolutionContext(input.applicationId, input.requestId);
  validateGenLayerProjection({
    status: input.status,
    txHash: input.txHash,
    resultOutcome: null,
    errorCode: input.errorCode,
    submittedAt: null,
    finalizedAt: null,
  });
  if (
    context.application.genlayerSubmitterStatus &&
    context.application.genlayerSubmitterStatus !== input.status
  ) {
    throw new Error("The GenLayer submission has already been accepted.");
  }
  const [updated] = await getDb()
    .update(marketplaceApplications)
    .set({
      genlayerSubmitterStatus: input.status,
      genlayerTxHash: input.txHash,
      genlayerErrorCode: input.errorCode,
      revision: context.application.revision + 1,
      updatedAt: input.nowMs,
    })
    .where(
      and(
        eq(marketplaceApplications.id, input.applicationId),
        eq(marketplaceApplications.requestId, input.requestId),
        eq(marketplaceApplications.revision, context.application.revision),
        sql`${marketplaceApplications.genlayerSubmitterStatus} is null or ${marketplaceApplications.genlayerSubmitterStatus} = ${input.status}`,
      ),
    )
    .returning();
  if (!updated) throw new Error("Concurrent GenLayer submission acceptance.");
  return updated;
}

export async function recordGenLayerSubmissionProjection(input: {
  applicationId: string;
  requestId: string;
  status: MarketplaceGenLayerSubmitterStatus;
  txHash: string | null;
  resultOutcome: "PASS" | "FAIL" | "UNDETERMINED" | null;
  lifecycleStatus: string | null;
  executionResult: string | null;
  errorCode: string | null;
  submittedAt?: number | null;
  finalizedAt?: number | null;
  nowMs: number;
}): Promise<ApplicationRow> {
  const context = await exactResolutionContext(input.applicationId, input.requestId);
  validateGenLayerProjection(input);
  const currentStatus = context.application.genlayerSubmitterStatus;
  if (
    currentStatus &&
    !canTransitionGenLayerStatus(
      currentStatus as MarketplaceGenLayerSubmitterStatus,
      input.status,
    )
  ) {
    throw new Error("The GenLayer lifecycle transition is not allowed.");
  }
  const [updated] = await getDb()
    .update(marketplaceApplications)
    .set({
      genlayerSubmitterStatus: input.status,
      genlayerTxHash: input.txHash,
      genlayerResultOutcome: input.resultOutcome,
      genlayerLifecycleStatus: boundedProjectionText(
        input.lifecycleStatus,
        "lifecycleStatus",
      ),
      genlayerExecutionResult: boundedProjectionText(
        input.executionResult,
        "executionResult",
      ),
      genlayerErrorCode: boundedProjectionText(input.errorCode, "errorCode"),
      genlayerSubmittedAt: input.submittedAt ?? null,
      genlayerFinalizedAt: input.finalizedAt ?? null,
      revision: context.application.revision + 1,
      updatedAt: input.nowMs,
    })
    .where(
      and(
        eq(marketplaceApplications.id, input.applicationId),
        eq(marketplaceApplications.requestId, input.requestId),
        eq(marketplaceApplications.revision, context.application.revision),
      ),
    )
    .returning();
  if (!updated) throw new Error("Concurrent GenLayer projection update.");
  return updated;
}

export async function latestMetricsForProfile(
  profile: CreatorProfileRow,
  nowMs: number,
): Promise<CreatorMetricsRow | null> {
  if (!profile.latestMetricsSnapshotId) return null;
  const [row] = await getDb()
    .select()
    .from(marketplaceCreatorMetricsSnapshots)
    .where(
      and(
        eq(marketplaceCreatorMetricsSnapshots.id, profile.latestMetricsSnapshotId),
        eq(marketplaceCreatorMetricsSnapshots.profileId, profile.id),
        gt(marketplaceCreatorMetricsSnapshots.expiresAt, nowMs),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findPublicCreatorProfileByWallet(
  wallet: string,
): Promise<CreatorProfileRow | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceCreatorProfiles)
    .where(
      and(
        eq(marketplaceCreatorProfiles.ownerWallet, wallet),
        eq(marketplaceCreatorProfiles.visibility, "PUBLIC"),
        eq(marketplaceCreatorProfiles.active, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findCreatorProfileByWallet(
  wallet: string,
): Promise<CreatorProfileRow | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceCreatorProfiles)
    .where(eq(marketplaceCreatorProfiles.ownerWallet, wallet))
    .limit(1);
  return row ?? null;
}

export async function findMetricsSnapshotByRequestId(
  requestId: string,
): Promise<CreatorMetricsRow | null> {
  const [row] = await getDb()
    .select()
    .from(marketplaceCreatorMetricsSnapshots)
    .where(eq(marketplaceCreatorMetricsSnapshots.id, requestId))
    .limit(1);
  return row ?? null;
}

export async function attachFinalizedCreatorMetricsSnapshot(
  input: FinalizedCreatorMetricsSnapshot,
): Promise<CreatorMetricsRow> {
  await getDb()
    .insert(marketplaceCreatorMetricsSnapshots)
    .values({
      id: input.requestId,
      profileId: input.profileId,
      followersCount: input.followersCount,
      accountCreatedAt: input.accountCreatedAt,
      postsSampled: input.postsSampled,
      medianEngagementCount: input.medianEngagementCount,
      engagementRateBps: input.engagementRateBps,
      estimatedPayMinAmount: input.estimatedPayMinAmount,
      estimatedPayMaxAmount: input.estimatedPayMaxAmount,
      riskLevel: input.riskLevel,
      evidenceHash: input.evidenceHash,
      genlayerRequestId: input.requestId,
      genlayerTxHash: input.txHash,
      capturedAt: input.capturedAt,
      expiresAt: input.expiresAt,
      createdAt: input.nowMs,
    })
    .onConflictDoNothing({ target: marketplaceCreatorMetricsSnapshots.id });
  const snapshot = await findMetricsSnapshotByRequestId(input.requestId);
  if (!snapshot || !exactMetricsSnapshot(snapshot, input)) {
    throw new Error("The metrics request ID is already bound to another snapshot.");
  }
  const [updated] = await getDb()
    .update(marketplaceCreatorProfiles)
    .set({
      latestMetricsSnapshotId: snapshot.id,
      metricsUpdatedAt: snapshot.capturedAt,
      revision: sql`${marketplaceCreatorProfiles.revision} + 1`,
      updatedAt: input.nowMs,
    })
    .where(and(
      eq(marketplaceCreatorProfiles.id, input.profileId),
      eq(marketplaceCreatorProfiles.active, true),
      gt(marketplaceCreatorProfiles.credentialExpiresAt, input.nowMs),
      sql`(${marketplaceCreatorProfiles.metricsUpdatedAt} is null or ${marketplaceCreatorProfiles.metricsUpdatedAt} < ${snapshot.capturedAt})`,
    ))
    .returning();
  if (!updated) {
    const [current] = await getDb()
      .select()
      .from(marketplaceCreatorProfiles)
      .where(eq(marketplaceCreatorProfiles.id, input.profileId))
      .limit(1);
    const isExactRetry =
      current?.latestMetricsSnapshotId === snapshot.id &&
      current.metricsUpdatedAt === snapshot.capturedAt;
    const isSupersededByNewerSnapshot =
      current?.metricsUpdatedAt !== null &&
      current?.metricsUpdatedAt !== undefined &&
      current.metricsUpdatedAt > snapshot.capturedAt;
    if (
      !current ||
      !current.active ||
      current.credentialExpiresAt <= input.nowMs ||
      (!isExactRetry && !isSupersededByNewerSnapshot)
    ) {
      throw new Error("The verified creator profile cannot accept this metrics snapshot.");
    }
  }
  return snapshot;
}

export async function expireProfileIfNeeded(
  profile: CreatorProfileRow,
  nowMs: number,
): Promise<CreatorProfileRow> {
  if (!profile.active || profile.credentialExpiresAt > nowMs) return profile;
  const [updated] = await getDb()
    .update(marketplaceCreatorProfiles)
    .set({
      active: false,
      revision: profile.revision + 1,
      updatedAt: nowMs,
    })
    .where(
      and(
        eq(marketplaceCreatorProfiles.id, profile.id),
        eq(marketplaceCreatorProfiles.revision, profile.revision),
      ),
    )
    .returning();
  return updated ?? { ...profile, active: false };
}

function rawRows(result: unknown): Array<Record<string, unknown>> {
  if (!result || typeof result !== "object") return [];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows)
    ? rows.filter(
        (row): row is Record<string, unknown> =>
          Boolean(row) && typeof row === "object" && !Array.isArray(row),
      )
    : [];
}

function stringField(
  row: Record<string, unknown> | undefined,
  field: string,
): string | null {
  const value = row?.[field];
  return typeof value === "string" ? value : null;
}

async function exactResolutionContext(
  applicationId: string,
  requestId: string,
): Promise<MarketplaceResolutionContext> {
  const context = await findMarketplaceResolutionContextByRequestId(requestId);
  if (!context || context.application.id !== applicationId) {
    throw new Error("The marketplace resolution context is unavailable.");
  }
  return context;
}

function validateGenLayerProjection(input: {
  status: MarketplaceGenLayerSubmitterStatus;
  txHash: string | null;
  resultOutcome: "PASS" | "FAIL" | "UNDETERMINED" | null;
  errorCode: string | null;
  submittedAt?: number | null;
  finalizedAt?: number | null;
}): void {
  if (!marketplaceGenLayerSubmitterStatuses.includes(input.status)) {
    throw new Error("The GenLayer submitter status is invalid.");
  }
  if (input.txHash !== null && !/^0x[0-9a-f]{64}$/.test(input.txHash)) {
    throw new Error("The GenLayer transaction hash is invalid.");
  }
  for (const [field, value] of [
    ["submittedAt", input.submittedAt],
    ["finalizedAt", input.finalizedAt],
  ] as const) {
    if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`${field} is invalid.`);
    }
  }
  boundedProjectionText(input.errorCode, "errorCode");
  if (
    input.status === "FINALIZED" &&
    (!input.txHash || !input.resultOutcome || !input.finalizedAt || input.errorCode)
  ) {
    throw new Error("A finalized GenLayer projection is incomplete.");
  }
}

function boundedProjectionText(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (!value || value.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new Error(`${field} is invalid.`);
  }
  return value;
}

export function canTransitionGenLayerStatus(
  current: MarketplaceGenLayerSubmitterStatus,
  next: MarketplaceGenLayerSubmitterStatus,
): boolean {
  if (current === next) return true;
  const allowed: Readonly<
    Record<MarketplaceGenLayerSubmitterStatus, readonly MarketplaceGenLayerSubmitterStatus[]>
  > = {
    QUEUED: ["PRECHECKING", "POISONED"],
    PRECHECKING: ["PRECHECK_FAILED", "BROADCASTING", "POISONED"],
    PRECHECK_FAILED: ["PRECHECKING", "POISONED"],
    BROADCASTING: [
      "SUBMITTED",
      "EXECUTION_FAILED",
      "NETWORK_TERMINATED",
      "RECONCILIATION_REQUIRED",
      "POISONED",
    ],
    SUBMITTED: [
      "POLLING",
      "FINALIZED",
      "EXECUTION_FAILED",
      "NETWORK_TERMINATED",
      "RECONCILIATION_REQUIRED",
      "POLLING_EXHAUSTED",
    ],
    POLLING: [
      "FINALIZED",
      "EXECUTION_FAILED",
      "NETWORK_TERMINATED",
      "RECONCILIATION_REQUIRED",
      "POLLING_EXHAUSTED",
    ],
    RECONCILIATION_REQUIRED: ["SUBMITTED", "POLLING", "POISONED"],
    POLLING_EXHAUSTED: ["POLLING", "POISONED"],
    FINALIZED: [],
    EXECUTION_FAILED: [],
    NETWORK_TERMINATED: [],
    POISONED: [],
  };
  return allowed[current].includes(next);
}
