import type { Address, Hex } from "viem";
import { ApiProblem } from "./verification-api.ts";

export type SettlementChainCampaign = Readonly<{
  brand: Address;
  termsHash: Hex;
  deposited: bigint;
  allocated: bigint;
  disbursed: bigint;
  unallocatedWithdrawn: bigint;
  applicationDeadline: bigint;
  selectionDeadline: bigint;
  submissionDeadline: bigint;
  retentionSeconds: bigint;
}>;

export function assertWithdrawalPostState(claimableAfter: unknown): void {
  if (claimableAfter !== 0n) {
    throw new ApiProblem(
      409,
      "WITHDRAWAL_POST_STATE_MISMATCH",
      "The withdrawal receipt did not leave the authenticated wallet with zero claimable escrow balance at that block.",
    );
  }
}

export function assertUnallocatedCreditPostState(input: {
  campaign: SettlementChainCampaign;
  creditedAmount: bigint;
}): void {
  const remaining = marketplaceUnallocatedBudget(input.campaign);
  if (
    input.creditedAmount <= 0n ||
    input.campaign.unallocatedWithdrawn < input.creditedAmount ||
    remaining !== 0n
  ) {
    throw new ApiProblem(
      409,
      "UNALLOCATED_CREDIT_POST_STATE_MISMATCH",
      "The credit receipt does not match the campaign's post-transaction escrow state.",
    );
  }
}

export function marketplaceUnallocatedBudget(
  campaign: SettlementChainCampaign,
): bigint {
  const used = campaign.allocated + campaign.disbursed + campaign.unallocatedWithdrawn;
  if (used > campaign.deposited) {
    throw new Error("The Base escrow campaign accounting is invalid.");
  }
  return campaign.deposited - used;
}

