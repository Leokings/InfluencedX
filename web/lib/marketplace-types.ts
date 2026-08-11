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

export type CampaignStatus = Lowercase<MarketplaceCampaignStatus>;
export type FundingStatus = Lowercase<MarketplaceFundingStatus>;
export type ApplicationStatus = Lowercase<MarketplaceApplicationStatus>;
export type ProfileVisibility = Lowercase<MarketplaceProfileVisibility>;
export type MetricRiskLevel = Lowercase<MarketplaceMetricRiskLevel>;
export type ResolutionOutcome = Lowercase<MarketplaceResolutionOutcome>;

export type MarketplaceTransactionDto = {
  chainId: typeof BASE_SEPOLIA_CHAIN_ID;
  to: string;
  data: string;
  value: "0";
};

export type MarketplaceCampaignDto = {
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
  status: CampaignStatus;
  fundingStatus: FundingStatus;
  escrowContract: string | null;
  escrowCampaignId: string | null;
  fundingTxHash: string | null;
  fundedAt: string | null;
  applicationCount: number;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceApplicationDto = {
  id: string;
  campaignId: string;
  creatorWallet: string;
  creatorProfileId: string;
  creatorHandle: string | null;
  creatorHandleHash: string;
  requestedRateUsdc: string;
  pitch: string;
  status: ApplicationStatus;
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

export type CampaignListResponse = {
  campaigns: MarketplaceCampaignDto[];
  summary: {
    openCampaigns: number;
    lockedUsdc: string;
  };
};

export type CampaignDetailResponse = {
  campaign: MarketplaceCampaignDto;
  applications: MarketplaceApplicationDto[];
  viewerApplication: MarketplaceApplicationDto | null;
};
