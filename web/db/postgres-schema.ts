import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Postgres representation of the XProof verification state machine.
 *
 * Epoch values intentionally remain millisecond bigint values. Mapping them to
 * Postgres int4 would overflow, while changing them to timestamps would alter
 * the comparison and projection contract used by verification-service.ts.
 */
export const postgresVerificationStatuses = [
  "WALLET_CHALLENGE_PENDING",
  "WALLET_AUTHORIZED",
  "X_CHALLENGE_ISSUED",
  "INTENT_PREPARED",
  "READY_FOR_GENLAYER",
  "EXPIRED",
] as const;

export type PostgresVerificationStatus =
  (typeof postgresVerificationStatuses)[number];

export const postgresIntentSignatureStatuses = [
  "NOT_PREPARED",
  "AWAITING_SIGNATURE",
  "VERIFIED",
] as const;

export const postgresOwnershipSubmissionStatuses = [
  "NOT_SUBMITTED",
  "DISPATCHING",
  "DISPATCH_UNKNOWN",
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

export const postgresBaseRelayStatuses = [
  "NOT_STARTED",
  "QUORUM_PENDING",
  "BROADCASTING",
  "CONFIRMED",
  "FAILED",
  "RECONCILIATION_REQUIRED",
] as const;

export type PostgresBaseRelayStatus =
  (typeof postgresBaseRelayStatuses)[number];

export type PostgresOwnershipSubmissionStatus =
  (typeof postgresOwnershipSubmissionStatuses)[number];

export type PostgresIntentSignatureStatus =
  (typeof postgresIntentSignatureStatuses)[number];

export const marketplaceCampaignRelayStatuses = [
  "PENDING",
  "CLAIMED",
  "QUORUM_READY",
  "SIMULATED",
  "BROADCASTING",
  "CONFIRMED",
  "RETRYABLE",
  "RECONCILIATION_REQUIRED",
  "FAILED",
] as const;

export type MarketplaceCampaignRelayStatus =
  (typeof marketplaceCampaignRelayStatuses)[number];

export const marketplaceCampaignRelayStatusEnum = pgEnum(
  "marketplace_campaign_relay_status",
  marketplaceCampaignRelayStatuses,
);

export const verificationStatusEnum = pgEnum(
  "verification_status",
  postgresVerificationStatuses,
);

export const intentSignatureStatusEnum = pgEnum(
  "intent_signature_status",
  postgresIntentSignatureStatuses,
);

export const ownershipSubmissionStatusEnum = pgEnum(
  "ownership_submission_status",
  postgresOwnershipSubmissionStatuses,
);

export const baseRelayStatusEnum = pgEnum(
  "base_relay_status",
  postgresBaseRelayStatuses,
);

export const marketplaceCampaignStatuses = [
  "DRAFT",
  "FUNDING",
  "OPEN",
  "MATCHED",
  "ACTIVE",
  "SUBMITTED",
  "RESOLVING",
  "PAID",
  "REFUNDED",
  "CANCELLED",
] as const;

export type MarketplaceCampaignStatus =
  (typeof marketplaceCampaignStatuses)[number];

export const marketplaceFundingStatuses = [
  "UNFUNDED",
  "PENDING",
  "FUNDED",
  "FAILED",
] as const;

export type MarketplaceFundingStatus =
  (typeof marketplaceFundingStatuses)[number];

export const marketplaceApplicationStatuses = [
  "APPLIED",
  "SELECTED",
  "ACCEPTED",
  "REJECTED",
  "WITHDRAWN",
] as const;

export type MarketplaceApplicationStatus =
  (typeof marketplaceApplicationStatuses)[number];

export const marketplaceProfileVisibilities = [
  "PUBLIC",
  "UNLISTED",
  "PRIVATE",
] as const;

export type MarketplaceProfileVisibility =
  (typeof marketplaceProfileVisibilities)[number];

export const marketplaceMetricRiskLevels = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "UNDETERMINED",
] as const;

export type MarketplaceMetricRiskLevel =
  (typeof marketplaceMetricRiskLevels)[number];

export const marketplaceResolutionOutcomes = [
  "PASS",
  "FAIL",
  "UNDETERMINED",
] as const;

export type MarketplaceResolutionOutcome =
  (typeof marketplaceResolutionOutcomes)[number];

export const marketplaceCampaignStatusEnum = pgEnum(
  "marketplace_campaign_status",
  marketplaceCampaignStatuses,
);

export const marketplaceFundingStatusEnum = pgEnum(
  "marketplace_funding_status",
  marketplaceFundingStatuses,
);

export const marketplaceApplicationStatusEnum = pgEnum(
  "marketplace_application_status",
  marketplaceApplicationStatuses,
);

export const marketplaceProfileVisibilityEnum = pgEnum(
  "marketplace_profile_visibility",
  marketplaceProfileVisibilities,
);

export const marketplaceMetricRiskLevelEnum = pgEnum(
  "marketplace_metric_risk_level",
  marketplaceMetricRiskLevels,
);

export const marketplaceResolutionOutcomeEnum = pgEnum(
  "marketplace_resolution_outcome",
  marketplaceResolutionOutcomes,
);

const epochMs = (name: string) => bigint(name, { mode: "number" });

export const postgresVerificationRequests = pgTable(
  "verification_requests",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    activeOwnerUserId: text("active_owner_user_id"),
    activeWallet: text("active_wallet"),
    status: verificationStatusEnum("status")
      .notNull()
      .default("WALLET_CHALLENGE_PENDING"),
    statusUpdatedAt: epochMs("status_updated_at").notNull(),
    requestExpiresAt: epochMs("request_expires_at").notNull(),
    revision: epochMs("revision").notNull().default(0),

    wallet: text("wallet").notNull(),
    walletNonce: text("wallet_nonce"),
    walletNonceHash: text("wallet_nonce_hash").notNull(),
    walletMessage: text("wallet_message"),
    walletMessageHash: text("wallet_message_hash").notNull(),
    walletChallengeExpiresAt: epochMs(
      "wallet_challenge_expires_at",
    ).notNull(),
    walletSignatureHash: text("wallet_signature_hash"),
    walletAuthorizedAt: epochMs("wallet_authorized_at"),

    handle: text("handle"),
    xChallenge: text("x_challenge"),
    tweetText: text("tweet_text"),
    tweetTextHash: text("tweet_text_hash"),
    xChallengeIssuedAt: epochMs("x_challenge_issued_at"),
    xChallengeExpiresAt: epochMs("x_challenge_expires_at"),
    credentialExpiresAt: epochMs("credential_expires_at"),

    normalizedVerificationPostUrl: text("normalized_verification_post_url"),
    verificationPostId: text("verification_post_id"),
    verificationPostCreatedAt: epochMs("verification_post_created_at"),

    finalizedRequestId: text("finalized_request_id"),
    handleHash: text("handle_hash"),
    verificationPostHash: text("verification_post_hash"),
    challengeHash: text("challenge_hash"),
    receiverContract: text("receiver_contract"),
    genlayerContract: text("genlayer_contract"),
    intentTypedDataJson: text("intent_typed_data_json"),
    intentSignatureHash: text("intent_signature_hash"),
    intentSignatureStatus: intentSignatureStatusEnum(
      "intent_signature_status",
    )
      .notNull()
      .default("NOT_PREPARED"),
    intentPreparedAt: epochMs("intent_prepared_at"),
    readyForGenLayerAt: epochMs("ready_for_genlayer_at"),
    sealedEvidenceCiphertext: text("sealed_evidence_ciphertext"),
    sealedEvidenceHash: text("sealed_evidence_hash"),
    sealedEvidenceExpiresAt: epochMs("sealed_evidence_expires_at"),
    sealedEvidencePurgedAt: epochMs("sealed_evidence_purged_at"),

    submissionStatus: ownershipSubmissionStatusEnum("submission_status")
      .notNull()
      .default("NOT_SUBMITTED"),
    submissionStatusUpdatedAt: epochMs("submission_status_updated_at"),
    submissionAttempts: epochMs("submission_attempts").notNull().default(0),
    submissionLastAttemptAt: epochMs("submission_last_attempt_at"),
    submissionResponseUpdatedAt: epochMs("submission_response_updated_at"),
    genlayerTxHash: text("genlayer_tx_hash"),
    genlayerOutcome: text("genlayer_outcome"),
    genlayerErrorCode: text("genlayer_error_code"),
    genlayerSubmittedAt: epochMs("genlayer_submitted_at"),
    genlayerLastPolledAt: epochMs("genlayer_last_polled_at"),
    genlayerFinalizedAt: epochMs("genlayer_finalized_at"),

    baseRelayStatus: baseRelayStatusEnum("base_relay_status")
      .notNull()
      .default("NOT_STARTED"),
    baseRelayTxHash: text("base_relay_tx_hash"),
    baseRelayUpdatedAt: epochMs("base_relay_updated_at"),
    baseConfirmedAt: epochMs("base_confirmed_at"),
    baseRelayErrorCode: text("base_relay_error_code"),
    baseRegistryAddress: text("base_registry_address"),
    baseProfileId: text("base_profile_id"),
    baseProfileIdentityHash: text("base_profile_identity_hash"),
    baseProfileHandleHash: text("base_profile_handle_hash"),
    baseProfileVerificationPostHash: text(
      "base_profile_verification_post_hash",
    ),
    baseProfileExpiresAt: epochMs("base_profile_expires_at"),
    baseProfileActive: boolean("base_profile_active"),
    baseProfileVerified: boolean("base_profile_verified")
      .notNull()
      .default(false),
    purgedAt: epochMs("purged_at"),

    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (table) => [
    index("verification_requests_owner_created_idx").on(
      table.ownerUserId,
      table.createdAt.desc(),
    ),
    index("verification_requests_owner_status_idx").on(
      table.ownerUserId,
      table.status,
    ),
    index("verification_requests_owner_active_expiry_idx")
      .on(table.ownerUserId, table.requestExpiresAt)
      .where(sql`${table.status} <> 'EXPIRED'`),
    uniqueIndex("verification_requests_finalized_request_idx").on(
      table.finalizedRequestId,
    ),
    uniqueIndex("verification_requests_one_active_owner_idx").on(
      table.activeOwnerUserId,
    ),
    index("verification_requests_active_wallet_idx").on(table.activeWallet),
    index("verification_requests_base_relay_status_idx").on(
      table.baseRelayStatus,
      table.baseRelayUpdatedAt,
    ),
    uniqueIndex("verification_requests_base_relay_tx_idx")
      .on(table.baseRelayTxHash)
      .where(sql`${table.baseRelayTxHash} is not null`),
    check(
      "verification_requests_revision_nonnegative",
      sql`${table.revision} >= 0`,
    ),
    check(
      "verification_requests_active_pair",
      sql`(${table.activeOwnerUserId} is null) = (${table.activeWallet} is null)`,
    ),
    check(
      "verification_requests_active_owner_matches",
      sql`${table.activeOwnerUserId} is null or ${table.activeOwnerUserId} = ${table.ownerUserId}`,
    ),
    check(
      "verification_requests_active_wallet_matches",
      sql`${table.activeWallet} is null or ${table.activeWallet} = ${table.wallet}`,
    ),
    check(
      "verification_requests_expiry_state",
      sql`(${table.status} = 'EXPIRED' and ${table.activeOwnerUserId} is null) or (${table.status} <> 'EXPIRED' and ${table.activeOwnerUserId} is not null)`,
    ),
    check(
      "verification_requests_intent_state",
      sql`${table.status} = 'EXPIRED' or (${table.status} in ('WALLET_CHALLENGE_PENDING', 'WALLET_AUTHORIZED', 'X_CHALLENGE_ISSUED') and ${table.intentSignatureStatus} = 'NOT_PREPARED') or (${table.status} = 'INTENT_PREPARED' and ${table.intentSignatureStatus} = 'AWAITING_SIGNATURE') or (${table.status} = 'READY_FOR_GENLAYER' and ${table.intentSignatureStatus} = 'VERIFIED')`,
    ),
    check(
      "verification_requests_submission_attempts_nonnegative",
      sql`${table.submissionAttempts} >= 0`,
    ),
    check(
      "verification_requests_submission_outcome",
      sql`${table.genlayerOutcome} is null or ${table.genlayerOutcome} in ('VERIFIED', 'REJECTED', 'UNDETERMINED')`,
    ),
    check(
      "verification_requests_sealed_evidence_pair",
      sql`(${table.sealedEvidenceCiphertext} is null) = (${table.sealedEvidenceHash} is null)`,
    ),
    check(
      "verification_requests_base_relay_tx_format",
      sql`${table.baseRelayTxHash} is null or ${table.baseRelayTxHash} ~ '^0x[0-9a-f]{64}$'`,
    ),
    check(
      "verification_requests_base_registry_format",
      sql`${table.baseRegistryAddress} is null or ${table.baseRegistryAddress} ~ '^0x[0-9a-fA-F]{40}$'`,
    ),
    check(
      "verification_requests_base_profile_id_format",
      sql`${table.baseProfileId} is null or ${table.baseProfileId} ~ '^[1-9][0-9]*$'`,
    ),
    check(
      "verification_requests_base_profile_hashes",
      sql`(${table.baseProfileIdentityHash} is null or ${table.baseProfileIdentityHash} ~ '^0x[0-9a-f]{64}$') and (${table.baseProfileHandleHash} is null or ${table.baseProfileHandleHash} ~ '^0x[0-9a-f]{64}$') and (${table.baseProfileVerificationPostHash} is null or ${table.baseProfileVerificationPostHash} ~ '^0x[0-9a-f]{64}$')`,
    ),
    check(
      "verification_requests_base_confirmation_state",
      sql`${table.baseRelayStatus} <> 'CONFIRMED' or (${table.baseRelayTxHash} is not null and ${table.baseConfirmedAt} is not null and ${table.baseRegistryAddress} is not null and ${table.baseProfileId} is not null and ${table.baseProfileIdentityHash} is not null and ${table.baseProfileHandleHash} is not null and ${table.baseProfileVerificationPostHash} is not null and ${table.baseProfileExpiresAt} is not null and ${table.baseProfileActive} is true and ${table.baseProfileVerified} is true)`,
    ),
  ],
);

/**
 * One-time Preview authorization grants for recovering an already-verified
 * creator signature into an operator-owned ephemeral RSA key. Only hashes and
 * public relay bindings are stored; neither the token nor the signature is
 * persisted here.
 */
export const ownershipAuthorizationGrants = pgTable(
  "ownership_authorization_grants",
  {
    tokenHash: text("token_hash").primaryKey(),
    requestId: text("request_id").notNull(),
    genlayerTxHash: text("genlayer_tx_hash").notNull(),
    resolverAddress: text("resolver_address").notNull(),
    baseReceiverAddress: text("base_receiver_address").notNull(),
    baseRegistryAddress: text("base_registry_address").notNull(),
    expectedWallet: text("expected_wallet").notNull(),
    expiresAt: epochMs("expires_at").notNull(),
    consumedAt: epochMs("consumed_at"),
    consumerKeyFingerprint: text("consumer_key_fingerprint"),
    createdAt: epochMs("created_at").notNull(),
  },
  (table) => [
    index("ownership_authorization_grants_expiry_idx").on(table.expiresAt),
    check(
      "ownership_authorization_grants_token_hash_format",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "ownership_authorization_grants_hash_formats",
      sql`${table.requestId} ~ '^0x[0-9a-f]{64}$' and ${table.genlayerTxHash} ~ '^0x[0-9a-f]{64}$'`,
    ),
    check(
      "ownership_authorization_grants_address_formats",
      sql`${table.resolverAddress} ~ '^0x[0-9a-fA-F]{40}$' and ${table.baseReceiverAddress} ~ '^0x[0-9a-fA-F]{40}$' and ${table.baseRegistryAddress} ~ '^0x[0-9a-fA-F]{40}$' and ${table.expectedWallet} ~ '^0x[0-9a-fA-F]{40}$'`,
    ),
    check(
      "ownership_authorization_grants_short_lived",
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + 900000`,
    ),
    check(
      "ownership_authorization_grants_consumption_pair",
      sql`(${table.consumedAt} is null) = (${table.consumerKeyFingerprint} is null)`,
    ),
    check(
      "ownership_authorization_grants_consumer_key_format",
      sql`${table.consumerKeyFingerprint} is null or ${table.consumerKeyFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/**
 * Durable fixed-window counters for verification mutations.
 *
 * `bucketHash` is an HMAC digest. Raw IP addresses, wallet addresses, session
 * subjects, and request IDs are deliberately never persisted in this table.
 * One row is reused per policy/bucket pair so window rollover cannot create an
 * unbounded history for an active caller.
 */
export const postgresVerificationRateLimits = pgTable(
  "verification_rate_limits",
  {
    policyKey: text("policy_key").notNull(),
    bucketHash: text("bucket_hash").notNull(),
    windowStartedAt: epochMs("window_started_at").notNull(),
    windowExpiresAt: epochMs("window_expires_at").notNull(),
    requestCount: integer("request_count").notNull(),
    requestLimit: integer("request_limit").notNull(),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "verification_rate_limits_policy_bucket_pk",
      columns: [table.policyKey, table.bucketHash],
    }),
    index("verification_rate_limits_expiry_idx").on(table.windowExpiresAt),
    check(
      "verification_rate_limits_bucket_hash_format",
      sql`${table.bucketHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "verification_rate_limits_window_order",
      sql`${table.windowStartedAt} >= 0 and ${table.windowExpiresAt} > ${table.windowStartedAt}`,
    ),
    check(
      "verification_rate_limits_positive_counts",
      sql`${table.requestCount} > 0 and ${table.requestLimit} > 0 and ${table.requestCount} <= ${table.requestLimit}`,
    ),
  ],
);

/**
 * Marketplace campaign intent and its Base Sepolia escrow binding.
 *
 * Amounts are USDC atomic units stored as numeric(78, 0). JavaScript never
 * converts them to Number, so a campaign budget cannot lose precision. A
 * campaign is not OPEN until a separately verified funding transition has
 * populated all escrow fields and set fundingStatus to FUNDED.
 */
export const marketplaceCampaigns = pgTable(
  "marketplace_campaigns",
  {
    id: text("id").primaryKey(),
    brandWallet: text("brand_wallet").notNull(),
    brandName: text("brand_name").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    category: text("category").notNull(),
    format: text("format").notNull(),
    deliverables: jsonb("deliverables").$type<string[]>().notNull(),
    requiredPhrases: jsonb("required_phrases").$type<string[]>().notNull(),
    forbiddenPhrases: jsonb("forbidden_phrases").$type<string[]>().notNull(),
    requireAdDisclosure: boolean("require_ad_disclosure").notNull(),
    semanticBrief: text("semantic_brief").notNull(),
    termsDocument: jsonb("terms_document")
      .$type<Record<string, unknown>>()
      .notNull(),
    termsHash: text("terms_hash").notNull(),
    budgetAmount: numeric("budget_amount", {
      precision: 78,
      scale: 0,
    }).notNull(),
    tokenAddress: text("token_address").notNull(),
    tokenDecimals: integer("token_decimals").notNull().default(6),
    chainId: integer("chain_id").notNull().default(84_532),
    deadlineAt: epochMs("deadline_at").notNull(),
    selectionDeadlineAt: epochMs("selection_deadline_at").notNull(),
    submissionDeadlineAt: epochMs("submission_deadline_at").notNull(),
    retentionSeconds: epochMs("retention_seconds").notNull(),
    status: marketplaceCampaignStatusEnum("status")
      .notNull()
      .default("FUNDING"),
    fundingStatus: marketplaceFundingStatusEnum("funding_status")
      .notNull()
      .default("UNFUNDED"),
    escrowContract: text("escrow_contract"),
    escrowCampaignId: text("escrow_campaign_id"),
    fundingTxHash: text("funding_tx_hash"),
    fundedAt: epochMs("funded_at"),
    revision: epochMs("revision").notNull().default(0),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (table) => [
    index("marketplace_campaigns_status_created_idx").on(
      table.status,
      table.createdAt.desc(),
    ),
    index("marketplace_campaigns_brand_created_idx").on(
      table.brandWallet,
      table.createdAt.desc(),
    ),
    index("marketplace_campaigns_category_status_idx").on(
      table.category,
      table.status,
    ),
    uniqueIndex("marketplace_campaigns_funding_tx_idx")
      .on(table.fundingTxHash)
      .where(sql`${table.fundingTxHash} is not null`),
    uniqueIndex("marketplace_campaigns_escrow_campaign_idx")
      .on(table.escrowContract, table.escrowCampaignId)
      .where(
        sql`${table.escrowContract} is not null and ${table.escrowCampaignId} is not null`,
      ),
    check(
      "marketplace_campaigns_brand_wallet_format",
      sql`${table.brandWallet} ~ '^0x[0-9a-f]{40}$'`,
    ),
    check(
      "marketplace_campaigns_token_address_format",
      sql`${table.tokenAddress} ~ '^0x[0-9a-f]{40}$'`,
    ),
    check(
      "marketplace_campaigns_base_sepolia_only",
      sql`${table.chainId} = 84532 and ${table.tokenDecimals} = 6`,
    ),
    check(
      "marketplace_campaigns_positive_budget",
      sql`${table.budgetAmount} > 0`,
    ),
    check(
      "marketplace_campaigns_terms_hash_format",
      sql`${table.termsHash} ~ '^0x[0-9a-f]{64}$'`,
    ),
    check(
      "marketplace_campaigns_deadline_order",
      sql`${table.deadlineAt} > ${table.createdAt} and ${table.selectionDeadlineAt} > ${table.deadlineAt} and ${table.submissionDeadlineAt} > ${table.selectionDeadlineAt} and ${table.retentionSeconds} > 0`,
    ),
    check(
      "marketplace_campaigns_escrow_address_format",
      sql`${table.escrowContract} is null or ${table.escrowContract} ~ '^0x[0-9a-f]{40}$'`,
    ),
    check(
      "marketplace_campaigns_funding_tx_format",
      sql`${table.fundingTxHash} is null or ${table.fundingTxHash} ~ '^0x[0-9a-f]{64}$'`,
    ),
    check(
      "marketplace_campaigns_funded_binding",
      sql`${table.fundingStatus} <> 'FUNDED' or (${table.escrowContract} is not null and ${table.escrowCampaignId} is not null and ${table.fundingTxHash} is not null and ${table.fundedAt} is not null)`,
    ),
    check(
      "marketplace_campaigns_open_requires_funding",
      sql`${table.status} not in ('OPEN', 'MATCHED', 'ACTIVE', 'SUBMITTED', 'RESOLVING', 'PAID') or ${table.fundingStatus} = 'FUNDED'`,
    ),
    check(
      "marketplace_campaigns_revision_nonnegative",
      sql`${table.revision} >= 0`,
    ),
  ],
);

/**
 * Public creator profile derived from a finalized Base creator-registry entry.
 * It stores only public presentation data and cryptographic commitments; raw X
 * verification evidence never crosses into the marketplace schema.
 */
export const marketplaceCreatorProfiles = pgTable(
  "marketplace_creator_profiles",
  {
    id: text("id").primaryKey(),
    ownerWallet: text("owner_wallet").notNull(),
    baseProfileId: text("base_profile_id").notNull(),
    identityHash: text("identity_hash").notNull(),
    handleHash: text("handle_hash").notNull(),
    verificationPostHash: text("verification_post_hash").notNull(),
    verificationTxHash: text("verification_tx_hash").notNull(),
    publicHandle: text("public_handle"),
    displayName: text("display_name"),
    bio: text("bio"),
    categories: jsonb("categories").$type<string[]>().notNull().default([]),
    visibility: marketplaceProfileVisibilityEnum("visibility")
      .notNull()
      .default("PUBLIC"),
    active: boolean("active").notNull().default(true),
    credentialExpiresAt: epochMs("credential_expires_at").notNull(),
    verifiedAt: epochMs("verified_at").notNull(),
    latestMetricsSnapshotId: text("latest_metrics_snapshot_id"),
    metricsUpdatedAt: epochMs("metrics_updated_at"),
    revision: epochMs("revision").notNull().default(0),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("marketplace_creator_profiles_owner_wallet_idx").on(
      table.ownerWallet,
    ),
    uniqueIndex("marketplace_creator_profiles_base_profile_idx").on(
      table.baseProfileId,
    ),
    index("marketplace_creator_profiles_visibility_updated_idx").on(
      table.visibility,
      table.updatedAt.desc(),
    ),
    check(
      "marketplace_creator_profiles_owner_wallet_format",
      sql`${table.ownerWallet} ~ '^0x[0-9a-f]{40}$'`,
    ),
    check(
      "marketplace_creator_profiles_base_profile_id_format",
      sql`${table.baseProfileId} ~ '^[1-9][0-9]*$'`,
    ),
    check(
      "marketplace_creator_profiles_commitment_formats",
      sql`${table.identityHash} ~ '^0x[0-9a-f]{64}$' and ${table.handleHash} ~ '^0x[0-9a-f]{64}$' and ${table.verificationPostHash} ~ '^0x[0-9a-f]{64}$'`,
    ),
    check(
      "marketplace_creator_profiles_verification_tx_format",
      sql`${table.verificationTxHash} ~ '^0x[0-9a-f]{64}$'`,
    ),
    check(
      "marketplace_creator_profiles_credential_order",
      sql`${table.credentialExpiresAt} > ${table.verifiedAt}`,
    ),
    check(
      "marketplace_creator_profiles_revision_nonnegative",
      sql`${table.revision} >= 0`,
    ),
  ],
);

/**
 * Sanitized GenLayer metric snapshots. Counts and commitments may be public,
 * but fetched HTML/JSON and other raw X evidence are never persisted here.
 */
export const marketplaceCreatorMetricsSnapshots = pgTable(
  "marketplace_creator_metrics_snapshots",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => marketplaceCreatorProfiles.id, { onDelete: "cascade" }),
    followersCount: epochMs("followers_count").notNull(),
    accountCreatedAt: epochMs("account_created_at").notNull(),
    postsSampled: integer("posts_sampled").notNull(),
    medianEngagementCount: epochMs("median_engagement_count").notNull(),
    engagementRateBps: integer("engagement_rate_bps").notNull(),
    estimatedPayMinAmount: numeric("estimated_pay_min_amount", {
      precision: 78,
      scale: 0,
    }).notNull(),
    estimatedPayMaxAmount: numeric("estimated_pay_max_amount", {
      precision: 78,
      scale: 0,
    }).notNull(),
    riskLevel: marketplaceMetricRiskLevelEnum("risk_level").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    genlayerRequestId: text("genlayer_request_id"),
    genlayerTxHash: text("genlayer_tx_hash"),
    capturedAt: epochMs("captured_at").notNull(),
    expiresAt: epochMs("expires_at").notNull(),
    createdAt: epochMs("created_at").notNull(),
  },
  (table) => [
    index("marketplace_creator_metrics_profile_captured_idx").on(
      table.profileId,
      table.capturedAt.desc(),
    ),
    check(
      "marketplace_creator_metrics_nonnegative",
      sql`${table.followersCount} >= 0 and ${table.postsSampled} >= 0 and ${table.medianEngagementCount} >= 0 and ${table.engagementRateBps} >= 0`,
    ),
    check(
      "marketplace_creator_metrics_pay_range",
      sql`${table.estimatedPayMinAmount} >= 0 and ${table.estimatedPayMaxAmount} >= ${table.estimatedPayMinAmount}`,
    ),
    check(
      "marketplace_creator_metrics_evidence_hash_format",
      sql`${table.evidenceHash} ~ '^0x[0-9a-f]{64}$'`,
    ),
    check(
      "marketplace_creator_metrics_genlayer_hash_formats",
      sql`(${table.genlayerRequestId} is null or ${table.genlayerRequestId} ~ '^0x[0-9a-f]{64}$') and (${table.genlayerTxHash} is null or ${table.genlayerTxHash} ~ '^0x[0-9a-f]{64}$')`,
    ),
    check(
      "marketplace_creator_metrics_time_order",
      sql`${table.accountCreatedAt} <= ${table.capturedAt} and ${table.expiresAt} > ${table.capturedAt}`,
    ),
  ],
);

/**
 * Creator applications are wallet-bound and reference a verified Base creator
 * profile snapshot. A partial unique index guarantees there is at most one
 * selected/accepted creator for a campaign even under concurrent requests.
 */
export const marketplaceApplications = pgTable(
  "marketplace_applications",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => marketplaceCampaigns.id, { onDelete: "cascade" }),
    creatorWallet: text("creator_wallet").notNull(),
    creatorProfileId: text("creator_profile_id")
      .notNull()
      .references(() => marketplaceCreatorProfiles.id, { onDelete: "restrict" }),
    creatorHandle: text("creator_handle"),
    creatorHandleHash: text("creator_handle_hash").notNull(),
    requestedAmount: numeric("requested_amount", {
      precision: 78,
      scale: 0,
    }).notNull(),
    pitch: text("pitch").notNull(),
    status: marketplaceApplicationStatusEnum("status")
      .notNull()
      .default("APPLIED"),
    revision: epochMs("revision").notNull().default(0),
    selectedAt: epochMs("selected_at"),
    acceptedAt: epochMs("accepted_at"),
    escrowAssignmentId: text("escrow_assignment_id"),
    identityHash: text("identity_hash"),
    agreementHash: text("agreement_hash"),
    selectionTxHash: text("selection_tx_hash"),
    acceptanceTxHash: text("acceptance_tx_hash"),
    postIdHash: text("post_id_hash"),
    xPostId: text("x_post_id"),
    submissionHash: text("submission_hash"),
    submissionTxHash: text("submission_tx_hash"),
    submittedAt: epochMs("submitted_at"),
    requestId: text("request_id"),
    resolutionRound: integer("resolution_round").notNull().default(0),
    resolutionRequestTxHash: text("resolution_request_tx_hash"),
    resolutionRequestedAt: epochMs("resolution_requested_at"),
    resolutionOutcome: marketplaceResolutionOutcomeEnum("resolution_outcome"),
    resolutionEvidenceHash: text("resolution_evidence_hash"),
    resolutionTxHash: text("resolution_tx_hash"),
    claimTxHash: text("claim_tx_hash"),
    genlayerSubmitterStatus: text("genlayer_submitter_status"),
    genlayerTxHash: text("genlayer_tx_hash"),
    genlayerResultOutcome: marketplaceResolutionOutcomeEnum(
      "genlayer_result_outcome",
    ),
    genlayerLifecycleStatus: text("genlayer_lifecycle_status"),
    genlayerExecutionResult: text("genlayer_execution_result"),
    genlayerErrorCode: text("genlayer_error_code"),
    genlayerSubmittedAt: epochMs("genlayer_submitted_at"),
    genlayerFinalizedAt: epochMs("genlayer_finalized_at"),
    progressionFenceToken: text("progression_fence_token"),
    progressionLeaseExpiresAt: epochMs("progression_lease_expires_at"),
    progressionNextAttemptAt: epochMs("progression_next_attempt_at")
      .notNull()
      .default(0),
    progressionAttemptCount: integer("progression_attempt_count")
      .notNull()
      .default(0),
    progressionErrorCode: text("progression_error_code"),
    progressionLastAttemptAt: epochMs("progression_last_attempt_at"),
    createdAt: epochMs("created_at").notNull(),
    updatedAt: epochMs("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("marketplace_applications_campaign_creator_idx").on(
      table.campaignId,
      table.creatorWallet,
    ),
    uniqueIndex("marketplace_applications_one_selected_idx")
      .on(table.campaignId)
      .where(sql`${table.status} in ('SELECTED', 'ACCEPTED')`),
    index("marketplace_applications_creator_created_idx").on(
      table.creatorWallet,
      table.createdAt.desc(),
    ),
    index("marketplace_applications_campaign_status_idx").on(
      table.campaignId,
      table.status,
    ),
    index("marketplace_applications_progression_due_idx")
      .on(table.progressionNextAttemptAt, table.updatedAt)
      .where(
        sql`${table.requestId} is not null and ${table.resolutionTxHash} is null`,
      ),
    uniqueIndex("marketplace_applications_selection_tx_idx")
      .on(table.selectionTxHash)
      .where(sql`${table.selectionTxHash} is not null`),
    uniqueIndex("marketplace_applications_acceptance_tx_idx")
      .on(table.acceptanceTxHash)
      .where(sql`${table.acceptanceTxHash} is not null`),
    uniqueIndex("marketplace_applications_submission_tx_idx")
      .on(table.submissionTxHash)
      .where(sql`${table.submissionTxHash} is not null`),
    uniqueIndex("marketplace_applications_resolution_request_tx_idx")
      .on(table.resolutionRequestTxHash)
      .where(sql`${table.resolutionRequestTxHash} is not null`),
    uniqueIndex("marketplace_applications_request_id_idx")
      .on(table.requestId)
      .where(sql`${table.requestId} is not null`),
    uniqueIndex("marketplace_applications_genlayer_tx_idx")
      .on(table.genlayerTxHash)
      .where(sql`${table.genlayerTxHash} is not null`),
    check(
      "marketplace_applications_creator_wallet_format",
      sql`${table.creatorWallet} ~ '^0x[0-9a-f]{40}$'`,
    ),
    check(
      "marketplace_applications_handle_hash_format",
      sql`${table.creatorHandleHash} ~ '^0x[0-9a-f]{64}$'`,
    ),
    check(
      "marketplace_applications_positive_rate",
      sql`${table.requestedAmount} > 0`,
    ),
    check(
      "marketplace_applications_revision_nonnegative",
      sql`${table.revision} >= 0`,
    ),
    check(
      "marketplace_applications_selection_timestamps",
      sql`(${table.status} not in ('SELECTED', 'ACCEPTED') or ${table.selectedAt} is not null) and (${table.status} <> 'ACCEPTED' or ${table.acceptedAt} is not null)`,
    ),
    check(
      "marketplace_applications_assignment_id_format",
      sql`${table.escrowAssignmentId} is null or ${table.escrowAssignmentId} ~ '^[1-9][0-9]*$'`,
    ),
    check(
      "marketplace_applications_commitment_formats",
      sql`(${table.identityHash} is null or ${table.identityHash} ~ '^0x[0-9a-f]{64}$') and (${table.agreementHash} is null or ${table.agreementHash} ~ '^0x[0-9a-f]{64}$') and (${table.postIdHash} is null or ${table.postIdHash} ~ '^0x[0-9a-f]{64}$') and (${table.submissionHash} is null or ${table.submissionHash} ~ '^0x[0-9a-f]{64}$') and (${table.requestId} is null or ${table.requestId} ~ '^0x[0-9a-f]{64}$') and (${table.resolutionEvidenceHash} is null or ${table.resolutionEvidenceHash} ~ '^0x[0-9a-f]{64}$')`,
    ),
    check(
      "marketplace_applications_x_post_id_format",
      sql`${table.xPostId} is null or ${table.xPostId} ~ '^[1-9][0-9]{5,24}$'`,
    ),
    check(
      "marketplace_applications_submission_state",
      sql`(${table.submissionTxHash} is null) = (${table.submittedAt} is null) and (${table.submissionHash} is null) = (${table.postIdHash} is null) and (${table.postIdHash} is null) = (${table.xPostId} is null)`,
    ),
    check(
      "marketplace_applications_resolution_request_state",
      sql`(${table.resolutionRequestTxHash} is null) = (${table.resolutionRequestedAt} is null) and (${table.requestId} is null) = (${table.resolutionRequestTxHash} is null)`,
    ),
    check(
      "marketplace_applications_transaction_hash_formats",
      sql`(${table.selectionTxHash} is null or ${table.selectionTxHash} ~ '^0x[0-9a-f]{64}$') and (${table.acceptanceTxHash} is null or ${table.acceptanceTxHash} ~ '^0x[0-9a-f]{64}$') and (${table.submissionTxHash} is null or ${table.submissionTxHash} ~ '^0x[0-9a-f]{64}$') and (${table.resolutionRequestTxHash} is null or ${table.resolutionRequestTxHash} ~ '^0x[0-9a-f]{64}$') and (${table.resolutionTxHash} is null or ${table.resolutionTxHash} ~ '^0x[0-9a-f]{64}$') and (${table.claimTxHash} is null or ${table.claimTxHash} ~ '^0x[0-9a-f]{64}$')`,
    ),
    check(
      "marketplace_applications_resolution_round_nonnegative",
      sql`${table.resolutionRound} >= 0`,
    ),
    check(
      "marketplace_applications_genlayer_tx_format",
      sql`${table.genlayerTxHash} is null or ${table.genlayerTxHash} ~ '^0x[0-9a-f]{64}$'`,
    ),
    check(
      "marketplace_applications_genlayer_status_values",
      sql`${table.genlayerSubmitterStatus} is null or ${table.genlayerSubmitterStatus} in ('QUEUED', 'PRECHECKING', 'PRECHECK_FAILED', 'BROADCASTING', 'SUBMITTED', 'POLLING', 'FINALIZED', 'EXECUTION_FAILED', 'NETWORK_TERMINATED', 'RECONCILIATION_REQUIRED', 'POLLING_EXHAUSTED', 'POISONED')`,
    ),
    check(
      "marketplace_applications_genlayer_finality",
      sql`${table.genlayerSubmitterStatus} <> 'FINALIZED' or (${table.genlayerTxHash} is not null and ${table.genlayerResultOutcome} is not null and ${table.genlayerFinalizedAt} is not null and ${table.genlayerErrorCode} is null)`,
    ),
    check(
      "marketplace_applications_progression_lease_pair",
      sql`(${table.progressionFenceToken} is null) = (${table.progressionLeaseExpiresAt} is null)`,
    ),
    check(
      "marketplace_applications_progression_attempts_nonnegative",
      sql`${table.progressionAttemptCount} >= 0`,
    ),
    check(
      "marketplace_applications_progression_error_code_format",
      sql`${table.progressionErrorCode} is null or ${table.progressionErrorCode} ~ '^[A-Z0-9_]{1,64}$'`,
    ),
  ],
);

/**
 * One durable fence per Base escrow resolution round. Watcher signatures are
 * deliberately not persisted; only their recovered addresses and common
 * EIP-712 digest are retained for operational auditability.
 */
export const marketplaceCampaignResolutionRelays = pgTable(
  "marketplace_campaign_resolution_relays",
  {
    requestId: text("request_id").primaryKey(),
    applicationId: text("application_id")
      .notNull()
      .references(() => marketplaceApplications.id, { onDelete: "restrict" }),
    resolutionRound: integer("resolution_round").notNull(),
    assignmentId: text("assignment_id").notNull(),
    genlayerTxHash: text("genlayer_tx_hash").notNull(),
    expectedOutcome: marketplaceResolutionOutcomeEnum("expected_outcome").notNull(),
    evidenceHash: text("evidence_hash"),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    relayDeadline: bigint("relay_deadline", { mode: "number" }),
    status: marketplaceCampaignRelayStatusEnum("status")
      .default("PENDING")
      .notNull(),
    fenceToken: text("fence_token"),
    leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    quorumDigest: text("quorum_digest"),
    signerAddresses: jsonb("signer_addresses").$type<string[]>().default([]).notNull(),
    baseTxHash: text("base_tx_hash"),
    baseBlockNumber: text("base_block_number"),
    errorCode: text("error_code"),
    lastAttemptAt: bigint("last_attempt_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("marketplace_campaign_resolution_relays_application_round_idx")
      .on(table.applicationId, table.resolutionRound),
    uniqueIndex("marketplace_campaign_resolution_relays_base_tx_idx")
      .on(table.baseTxHash)
      .where(sql`${table.baseTxHash} is not null`),
    index("marketplace_campaign_resolution_relays_status_updated_idx")
      .on(table.status, table.updatedAt),
    check("marketplace_campaign_resolution_relays_request_format", sql`${table.requestId} ~ '^0x[0-9a-f]{64}$'`),
    check("marketplace_campaign_resolution_relays_assignment_format", sql`${table.assignmentId} ~ '^[1-9][0-9]*$'`),
    check("marketplace_campaign_resolution_relays_round_positive", sql`${table.resolutionRound} > 0`),
    check("marketplace_campaign_resolution_relays_genlayer_tx_format", sql`${table.genlayerTxHash} ~ '^0x[0-9a-f]{64}$'`),
    check("marketplace_campaign_resolution_relays_optional_hash_formats", sql`(${table.evidenceHash} is null or ${table.evidenceHash} ~ '^0x[0-9a-f]{64}$') and (${table.quorumDigest} is null or ${table.quorumDigest} ~ '^0x[0-9a-f]{64}$') and (${table.baseTxHash} is null or ${table.baseTxHash} ~ '^0x[0-9a-f]{64}$')`),
    check("marketplace_campaign_resolution_relays_lease_pair", sql`(${table.fenceToken} is null) = (${table.leaseExpiresAt} is null)`),
    check("marketplace_campaign_resolution_relays_attempts_nonnegative", sql`${table.attemptCount} >= 0`),
    check("marketplace_campaign_resolution_relays_quorum_state", sql`${table.status} not in ('QUORUM_READY', 'SIMULATED', 'BROADCASTING', 'CONFIRMED') or (${table.quorumDigest} is not null and jsonb_typeof(${table.signerAddresses}) = 'array' and jsonb_array_length(${table.signerAddresses}) >= 2 and ${table.evidenceHash} is not null and ${table.resolvedAt} is not null and ${table.relayDeadline} is not null)`),
    check("marketplace_campaign_resolution_relays_confirmed_tx", sql`${table.status} <> 'CONFIRMED' or (${table.baseTxHash} is not null and ${table.baseBlockNumber} is not null)`),
  ],
);

// Stable export names used by verification-service.ts. The prefixed names remain
// available for migration tooling and schema-focused tests.
export const verificationStatuses = postgresVerificationStatuses;
export type VerificationStatus = PostgresVerificationStatus;
export const intentSignatureStatuses = postgresIntentSignatureStatuses;
export type IntentSignatureStatus = PostgresIntentSignatureStatus;
export const ownershipSubmissionStatuses = postgresOwnershipSubmissionStatuses;
export type OwnershipSubmissionStatus = PostgresOwnershipSubmissionStatus;
export const baseRelayStatuses = postgresBaseRelayStatuses;
export type BaseRelayStatus = PostgresBaseRelayStatus;
export const verificationRequests = postgresVerificationRequests;
export const verificationRateLimits = postgresVerificationRateLimits;
