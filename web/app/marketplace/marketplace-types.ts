import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC_ADDRESS,
  type ApplicationStatus,
  type CampaignDetailResponse,
  type CampaignListResponse,
  type CampaignStatus,
  type FundingStatus,
  type MarketplaceApplicationDto,
  type MarketplaceCampaignDto,
  type MarketplaceSettlementMutationResponse,
  type MarketplaceSettlementStateDto,
  type MarketplaceTransactionDto,
} from "../../lib/marketplace-types.ts";

export {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_USDC_ADDRESS,
  type ApplicationStatus,
  type CampaignDetailResponse,
  type CampaignListResponse,
  type CampaignStatus,
  type FundingStatus,
  type MarketplaceSettlementMutationResponse,
  type MarketplaceSettlementStateDto,
  type MarketplaceTransactionDto,
};

export const BASE_SEPOLIA_CHAIN_ID_HEX = "0x14a34";

export type MarketplaceCampaign = MarketplaceCampaignDto;
export type MarketplaceApplication = MarketplaceApplicationDto;

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

export function usdcAtomsToDisplay(value: string | null | undefined): string {
  if (!value || !/^\d+$/.test(value)) return "—";
  const atoms = BigInt(value);
  const whole = atoms / 1_000_000n;
  const fractional = (atoms % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(whole);
  return fractional ? `${grouped}.${fractional}` : grouped;
}

export function usdcInputToAtoms(value: string): string {
  const normalized = value.trim().replace(/,/g, "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(normalized)) {
    throw new Error("Enter a valid test USDC amount with no more than 6 decimal places.");
  }
  const [whole, fractional = ""] = normalized.split(".");
  const atoms = BigInt(whole) * 1_000_000n + BigInt(fractional.padEnd(6, "0"));
  if (atoms <= 0n) throw new Error("The campaign budget must be greater than zero.");
  return atoms.toString();
}

export function campaignStatusLabel(status: CampaignStatus): string {
  return status.replaceAll("_", " ").toUpperCase();
}

export function fundingStatusLabel(status: FundingStatus | null | undefined): string {
  if (!status) return "FUNDING UNAVAILABLE";
  if (status === "funded") return "FUNDED ON BASE";
  if (status === "pending") return "FUNDING PENDING";
  if (status === "failed") return "FUNDING FAILED";
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
