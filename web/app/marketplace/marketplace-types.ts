import type {
  ApplicationStatus,
  CampaignDetailResponse as CoreCampaignDetailResponse,
  CampaignListResponse as CoreCampaignListResponse,
  CampaignStatus,
  FundingStatus,
  MarketplaceApplicationDto,
  MarketplaceCampaignDto,
  MarketplaceSettlementMutationResponse,
  MarketplaceSettlementStateDto,
  MarketplaceTransactionDto,
} from "../../lib/marketplace-types.ts";

export {
  type ApplicationStatus,
  type CampaignStatus,
  type FundingStatus,
  type MarketplaceSettlementMutationResponse,
  type MarketplaceSettlementStateDto,
  type MarketplaceTransactionDto,
};

export const STUDIONET_CHAIN_ID = 61_999 as const;
export const STUDIONET_CHAIN_ID_HEX = "0xf22f" as const;
export const STUDIONET_RPC_URL = "https://studio.genlayer.com/api" as const;
export const STUDIONET_EXPLORER_URL = "https://explorer-studio.genlayer.com" as const;
export const STUDIONET_FUNDING_GUIDE_URL = "https://docs.genlayer.com/developers/networks#studionet" as const;
export const STUDIONET_MARKETPLACE_ADDRESS = "0x492175c248168DDB9571CBF4c6A14296e3348181" as const;
export const STUDIONET_MARKETPLACE_DEPLOYMENT_TX = "0x3e3b7e8a10ab46c5e19638c3efd6816d78911d10213188571cbd4393f6494da8" as const;
export const GEN_DECIMALS = 18 as const;
export const GEN_SYMBOL = "GEN" as const;
export const CONTENT_SOURCES = ["X", "FARCASTER"] as const;
export type ContentSource = (typeof CONTENT_SOURCES)[number];

export type MarketplaceCampaign = MarketplaceCampaignDto;
export type MarketplaceApplication = MarketplaceApplicationDto;
export type CampaignListResponse = CoreCampaignListResponse;
export type CampaignDetailResponse = CoreCampaignDetailResponse;

export type MarketplaceActivity = {
  id: string;
  label: string;
  detail: string;
  createdAt?: string;
};

export type CampaignMutationResponse = {
  campaign: MarketplaceCampaign;
};

export type ApplicationMutationResponse = {
  application: MarketplaceApplication;
  campaign?: MarketplaceCampaign;
};

export type PreparedApplicationMutationResponse = ApplicationMutationResponse & {
  campaign: MarketplaceCampaign;
  transaction: MarketplaceTransactionDto;
};

export function campaignBudgetAtoms(campaign: MarketplaceCampaign): string {
  return campaign.budgetGen;
}

export function campaignContentSource(campaign: MarketplaceCampaign): ContentSource {
  if (campaign.contentSource !== "X" && campaign.contentSource !== "FARCASTER") {
    throw new Error("The campaign content source is unavailable.");
  }
  return campaign.contentSource;
}

export function contentSourceLabel(source: ContentSource): string {
  return source === "FARCASTER" ? "FARCASTER" : "X";
}

export function applicationRateAtoms(application: MarketplaceApplication): string {
  return application.requestedRateGen;
}

export function genAtomsToDisplay(value: string | null | undefined): string {
  if (!value || !/^\d+$/.test(value)) return "—";
  const atoms = BigInt(value);
  const scale = 10n ** BigInt(GEN_DECIMALS);
  const whole = atoms / scale;
  const remainder = atoms % scale;
  if (whole === 0n && remainder > 0n && remainder < scale / 1_000_000n) {
    return "<0.000001";
  }
  const fractional = remainder
    .toString()
    .padStart(GEN_DECIMALS, "0")
    .replace(/0+$/, "")
    .slice(0, 6);
  const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(whole);
  return fractional && /[1-9]/.test(fractional) ? `${grouped}.${fractional}` : grouped;
}

export function genInputToAtoms(value: string): string {
  const normalized = value.trim().replace(/,/g, "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(normalized)) {
    throw new Error("Enter a valid GEN amount with no more than 18 decimal places.");
  }
  const [whole, fractional = ""] = normalized.split(".");
  const atoms = BigInt(whole) * (10n ** BigInt(GEN_DECIMALS))
    + BigInt(fractional.padEnd(GEN_DECIMALS, "0"));
  if (atoms <= 0n) throw new Error("The amount must be greater than zero.");
  return atoms.toString();
}

export function campaignStatusLabel(status: CampaignStatus): string {
  return status.replaceAll("_", " ").toUpperCase();
}

export function fundingStatusLabel(status: FundingStatus | null | undefined): string {
  if (!status) return "FUNDING UNAVAILABLE";
  if (status === "funded") return "FUNDED ON GENLAYER";
  return "NOT YET FUNDED";
}

export function deadlineLabel(value: string, nowMs: number): string {
  const deadline = new Date(value);
  if (Number.isNaN(deadline.getTime())) return "DATE UNAVAILABLE";
  const milliseconds = deadline.getTime() - nowMs;
  if (milliseconds <= 0) return "CLOSED";
  const hours = Math.ceil(milliseconds / 3_600_000);
  if (hours < 48) return `${hours}H LEFT`;
  return `${Math.ceil(hours / 24)}D LEFT`;
}

export function shortenAddress(value: string | null | undefined): string {
  if (!value || value.length < 13) return value ?? "—";
  return `${value.slice(0, 7)}…${value.slice(-5)}`;
}

export function studioNetExplorerLink(kind: "tx" | "address", value: string | null | undefined): string | null {
  if (!value) return null;
  if (kind === "tx" && !/^0x[\da-f]{64}$/i.test(value)) return null;
  if (kind === "address" && !/^0x[\da-f]{40}$/i.test(value)) return null;
  return kind === "tx"
    ? `${STUDIONET_EXPLORER_URL}/tx/${value}`
    : `${STUDIONET_EXPLORER_URL}/address/${value}`;
}
