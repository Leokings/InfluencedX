import type {
  MarketplaceApplicationStatus,
  MarketplaceCampaignStatus,
  MarketplaceFundingStatus,
  MarketplaceMetricRiskLevel,
  MarketplaceProfileVisibility,
  MarketplaceResolutionOutcome,
} from "@/db/postgres-schema";

export const BASE_SEPOLIA_CHAIN_ID = 84_532;
export const BASE_SEPOLIA_USDC_ADDRESS =
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
export const BASE_SEPOLIA_ESCROW_ADDRESS =
  "0x7e9b6b757d1ef12509889826b2f2a42906661927";
export const USDC_DECIMALS = 6;

export type LegacyCampaignStatus = Lowercase<MarketplaceCampaignStatus>;
export type LegacyFundingStatus = Lowercase<MarketplaceFundingStatus>;
export type LegacyApplicationStatus = Lowercase<MarketplaceApplicationStatus>;
export type ProfileVisibility = Lowercase<MarketplaceProfileVisibility>;
export type MetricRiskLevel = Lowercase<MarketplaceMetricRiskLevel>;
export type ResolutionOutcome = Lowercase<MarketplaceResolutionOutcome>;

export type ContentSource = "X" | "FARCASTER";
export type CampaignStatus = "funding" | "open" | "cancelled" | "closed";
export type FundingStatus = "unfunded" | "funded";
export type ApplicationStatus =
  | "pending_onchain"
  | "applied"
  | "withdrawn"
  | "selected"
  | "accepted"
  | "submitted"
  | "undetermined"
  | "settled_pass"
  | "settled_fail"
  | "declined"
  | "expired"
  | "refunded";

export type MarketplaceTransactionDto = Readonly<{
  network: "studionet";
  chainId: 61_999;
  contractAddress: string;
  functionName: string;
  args: unknown[];
  argTypes: Array<"string" | "bool" | "uint256" | "address">;
  value: string;
}>;

export type MarketplaceSettlementStateDto = Readonly<{
  actorWallet: string;
  role: "brand" | "creator";
  claimableGen: string;
  claimableAtto: string;
  unallocatedGen: string;
  unallocatedAtto: string;
  canClaim: boolean;
  canRefundUnallocated: boolean;
  selectionDeadline: string;
  withdrawalId: string | null;
  withdrawalStatus:
    | "PENDING"
    | "EMITTED_UNCONFIRMED"
    | "CONFIRMED"
    | "RESTORED_FAILED"
    | null;
}>;

export type MarketplaceSettlementMutationResponse = Readonly<{
  settlement: MarketplaceSettlementStateDto;
  preparedId?: string;
  transaction?: MarketplaceTransactionDto;
  withdrawalId?: string;
  withdrawalStatus?: MarketplaceSettlementStateDto["withdrawalStatus"];
}>;

export type MarketplaceCampaignDto = Readonly<{
  id: string;
  brandWallet: string;
  brandName: string;
  contentSource: ContentSource;
  title: string;
  description: string;
  category: string;
  format: string;
  deliverables: string[];
  requiredPhrases: string[];
  forbiddenPhrases: string[];
  requireAdDisclosure: boolean;
  semanticBrief: string;
  termsDocument: Readonly<Record<string, unknown>>;
  termsHash: string;
  network: "studionet";
  assetSymbol: "GEN";
  assetDecimals: 18;
  budgetGen: string;
  chainId: 61_999;
  deadline: string;
  selectionDeadline: string;
  submissionDeadline: string;
  retentionSeconds: string;
  maxUndeterminedRetries: number;
  status: CampaignStatus;
  fundingStatus: FundingStatus;
  marketplaceContract: string;
  genlayerCampaignId: string | null;
  fundingTxHash: string | null;
  fundedAt: string | null;
  availableAtto: string;
  reservedAtto: string;
  settledAtto: string;
  creatorPaidAtto: string;
  brandRefundedAtto: string;
  feeAtto: string;
  applicationCount: number;
  createdAt: string;
  updatedAt: string;
}>;

export type MarketplaceResolutionChecksDto = Readonly<{
  authorMatch: boolean;
  postIdMatch: boolean;
  publicationInWindow: boolean;
  requiredChecks: boolean[];
  forbiddenChecks: boolean[];
  disclosurePresent: boolean;
  semanticPass: boolean;
}>;

export type MarketplaceApplicationDto = Readonly<{
  id: string;
  campaignId: string;
  creatorWallet: string;
  creatorProfileId: string;
  creatorHandle: string | null;
  contentSource: ContentSource;
  creatorExternalUserId: string | null;
  creatorIdentityHash: string | null;
  requestedRateGen: string;
  pitch: string;
  status: ApplicationStatus;
  selectedAt: string | null;
  acceptedAt: string | null;
  genlayerAssignmentId: string | null;
  agreementHash: string | null;
  selectionTxHash: string | null;
  acceptanceTxHash: string | null;
  contentId: string | null;
  submissionHash: string | null;
  submissionTxHash: string | null;
  submittedAt: string | null;
  requestId: string | null;
  resolutionRound: number;
  resolutionOutcome: "pass" | "fail" | "undetermined" | null;
  resolutionEvidenceHash: string | null;
  resolutionTxHash: string | null;
  resolutionChecks: MarketplaceResolutionChecksDto | null;
  genlayerTxHash: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type CampaignListResponse = Readonly<{
  campaigns: MarketplaceCampaignDto[];
  summary: { openCampaigns: number; lockedGen: string };
}>;

export type CampaignDetailResponse = Readonly<{
  campaign: MarketplaceCampaignDto;
  applications: MarketplaceApplicationDto[];
  viewerApplication: MarketplaceApplicationDto | null;
}>;

// Historical Base Sepolia DTOs remain for the archived read-only modules. New
// API routes must never import them.
export type LegacyMarketplaceTransactionDto = {
  chainId: typeof BASE_SEPOLIA_CHAIN_ID;
  to: string;
  data: string;
  value: "0";
};

export type LegacyMarketplaceSettlementStateDto = {
  actorWallet: string;
  role: "brand" | "creator";
  blockNumber: string;
  claimableUsdc: string;
  unallocatedUsdc: string;
  canWithdraw: boolean;
  canCreditUnallocated: boolean;
  selectionDeadline: string;
};

export type LegacyMarketplaceSettlementMutationResponse = {
  settlement: LegacyMarketplaceSettlementStateDto;
  transaction?: LegacyMarketplaceTransactionDto;
  confirmation?: {
    txHash: string;
    amountUsdc: string;
    blockNumber: string;
  };
};

export type LegacyMarketplaceCampaignDto = {
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
  termsDocument: Readonly<Record<string, unknown>>;
  termsHash: string;
  budgetUsdc: string;
  tokenAddress: string;
  chainId: typeof BASE_SEPOLIA_CHAIN_ID;
  deadline: string;
  selectionDeadline: string;
  submissionDeadline: string;
  retentionSeconds: string;
  status: LegacyCampaignStatus;
  fundingStatus: LegacyFundingStatus;
  escrowContract: string | null;
  escrowCampaignId: string | null;
  fundingTxHash: string | null;
  fundedAt: string | null;
  applicationCount: number;
  createdAt: string;
  updatedAt: string;
};

export type LegacyMarketplaceApplicationDto = {
  id: string;
  campaignId: string;
  creatorWallet: string;
  creatorProfileId: string;
  creatorHandle: string | null;
  creatorHandleHash: string;
  requestedRateUsdc: string;
  pitch: string;
  status: LegacyApplicationStatus;
  selectedAt: string | null;
  acceptedAt: string | null;
  escrowAssignmentId: string | null;
  identityHash: string | null;
  agreementHash: string | null;
  selectionTxHash: string | null;
  acceptanceTxHash: string | null;
  postIdHash: string | null;
  xPostId: string | null;
  submissionHash: string | null;
  submissionTxHash: string | null;
  submittedAt: string | null;
  requestId: string | null;
  resolutionRound: number;
  resolutionRequestTxHash: string | null;
  resolutionRequestedAt: string | null;
  resolutionOutcome: ResolutionOutcome | null;
  resolutionEvidenceHash: string | null;
  resolutionTxHash: string | null;
  claimTxHash: string | null;
  genlayerSubmitterStatus: string | null;
  genlayerTxHash: string | null;
  genlayerResultOutcome: ResolutionOutcome | null;
  genlayerLifecycleStatus: string | null;
  genlayerExecutionResult: string | null;
  genlayerErrorCode: string | null;
  genlayerSubmittedAt: string | null;
  genlayerFinalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceMetricsDto = {
  id: string;
  followersCount: string;
  accountCreatedAt: string;
  postsSampled: number;
  medianEngagementCount: string;
  engagementRateBps: number;
  estimatedPayMinUsdc: string;
  estimatedPayMaxUsdc: string;
  riskLevel: MetricRiskLevel;
  evidenceHash: string;
  capturedAt: string;
  expiresAt: string;
};

export type MarketplaceCreatorProfileDto = {
  id: string;
  ownerWallet: string;
  baseProfileId: string;
  identityHash: string;
  handleHash: string;
  verificationPostHash: string;
  verificationTxHash: string;
  publicHandle: string | null;
  displayName: string | null;
  bio: string | null;
  categories: string[];
  visibility: ProfileVisibility;
  active: boolean;
  credentialExpiresAt: string;
  verifiedAt: string;
  metrics: MarketplaceMetricsDto | null;
  createdAt: string;
  updatedAt: string;
};

export type LegacyCampaignListResponse = {
  campaigns: LegacyMarketplaceCampaignDto[];
  summary: {
    openCampaigns: number;
    lockedUsdc: string;
  };
};

export type LegacyCampaignDetailResponse = {
  campaign: LegacyMarketplaceCampaignDto;
  applications: LegacyMarketplaceApplicationDto[];
  viewerApplication: LegacyMarketplaceApplicationDto | null;
};
