import { getAddress, type Address, type Hex } from "viem";
import {
  BASE_SEPOLIA_CHAIN_ID,
  INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT,
  extractUnallocatedCredited,
  extractWithdrawal,
  marketplaceEscrowAbi,
  prepareEscrowWithdrawal,
  prepareUnallocatedBudgetCredit,
  type PreparedMarketplaceCall,
} from "./marketplace-chain.ts";
import {
  authorizeMarketplaceCall,
  loadConfirmedMarketplaceTransaction,
  marketplacePublicClient,
  requireTransactionHash,
} from "./marketplace-receipts.ts";
import { getMarketplaceCampaignDetail } from "./marketplace-service.ts";
import {
  assertUnallocatedCreditPostState,
  assertWithdrawalPostState,
  marketplaceUnallocatedBudget,
  type SettlementChainCampaign,
} from "./marketplace-settlement-validation.ts";
import type {
  LegacyMarketplaceCampaignDto as MarketplaceCampaignDto,
  LegacyMarketplaceSettlementMutationResponse as MarketplaceSettlementMutationResponse,
  LegacyMarketplaceSettlementStateDto as MarketplaceSettlementStateDto,
  LegacyMarketplaceTransactionDto as MarketplaceTransactionDto,
} from "./marketplace-types.ts";
import { ApiProblem } from "./verification-api.ts";
import type { AuthenticatedWalletSession } from "./wallet-session.ts";

type SettlementContext = Readonly<{
  campaign: MarketplaceCampaignDto;
  actor: Address;
  role: "brand" | "creator";
  escrowCampaignId: bigint;
}>;

export async function getMarketplaceSettlementState(input: {
  campaignId: string;
  session: AuthenticatedWalletSession;
}): Promise<MarketplaceSettlementStateDto> {
  const context = await settlementContext(input);
  return readSettlementState(context);
}

export async function prepareMarketplaceUnallocatedCredit(input: {
  campaignId: string;
  session: AuthenticatedWalletSession;
}): Promise<MarketplaceSettlementMutationResponse> {
  const context = await settlementContext(input);
  if (context.role !== "brand") {
    throw new ApiProblem(
      403,
      "CAMPAIGN_OWNER_REQUIRED",
      "Only the campaign owner can recover unused campaign budget.",
    );
  }
  const settlement = await readSettlementState(context);
  if (!settlement.canCreditUnallocated) {
    throw new ApiProblem(
      409,
      "UNALLOCATED_BUDGET_NOT_READY",
      "No unused campaign budget is currently eligible for recovery.",
    );
  }
  const call = prepareUnallocatedBudgetCredit({
    chainId: BASE_SEPOLIA_CHAIN_ID,
    campaignId: context.escrowCampaignId,
  });
  return Object.freeze({ settlement, transaction: transactionDto(call) });
}

export async function confirmMarketplaceUnallocatedCredit(input: {
  campaignId: string;
  session: AuthenticatedWalletSession;
  txHash: unknown;
}): Promise<MarketplaceSettlementMutationResponse> {
  const context = await settlementContext(input);
  if (context.role !== "brand") {
    throw new ApiProblem(
      403,
      "CAMPAIGN_OWNER_REQUIRED",
      "Only the campaign owner can confirm unused-budget recovery.",
    );
  }
  const txHash = requireTransactionHash(input.txHash);
  const call = prepareUnallocatedBudgetCredit({
    chainId: BASE_SEPOLIA_CHAIN_ID,
    campaignId: context.escrowCampaignId,
  });
  const transaction = await loadConfirmedMarketplaceTransaction(txHash);
  await authorizeMarketplaceCall(transaction, call, context.actor);
  let credited: ReturnType<typeof extractUnallocatedCredited>;
  try {
    credited = extractUnallocatedCredited({
      receiptStatus: transaction.receiptStatus,
      logs: transaction.logs,
      expectedCampaignId: context.escrowCampaignId,
      expectedBrand: context.actor,
    });
  } catch {
    throw new ApiProblem(
      409,
      "INVALID_UNALLOCATED_CREDIT_RECEIPT",
      "The transaction does not contain the expected unused-budget credit event.",
    );
  }
  const campaignAfter = await readChainCampaign(
    context,
    transaction.blockNumber,
  );
  assertUnallocatedCreditPostState({
    campaign: campaignAfter,
    creditedAmount: credited.amount,
  });
  return Object.freeze({
    settlement: await readSettlementState(context),
    confirmation: Object.freeze({
      txHash,
      amountUsdc: credited.amount.toString(),
      blockNumber: transaction.blockNumber.toString(),
    }),
  });
}

export async function prepareMarketplaceWithdrawal(input: {
  campaignId: string;
  session: AuthenticatedWalletSession;
}): Promise<MarketplaceSettlementMutationResponse> {
  const context = await settlementContext(input);
  const settlement = await readSettlementState(context);
  if (!settlement.canWithdraw) {
    throw new ApiProblem(
      409,
      "NOTHING_TO_WITHDRAW",
      "Base escrow does not currently report claimable test USDC for this wallet.",
    );
  }
  const call = prepareEscrowWithdrawal({ chainId: BASE_SEPOLIA_CHAIN_ID });
  return Object.freeze({ settlement, transaction: transactionDto(call) });
}

export async function confirmMarketplaceWithdrawal(input: {
  campaignId: string;
  session: AuthenticatedWalletSession;
  txHash: unknown;
}): Promise<MarketplaceSettlementMutationResponse> {
  const context = await settlementContext(input);
  const txHash = requireTransactionHash(input.txHash);
  const call = prepareEscrowWithdrawal({ chainId: BASE_SEPOLIA_CHAIN_ID });
  const transaction = await loadConfirmedMarketplaceTransaction(txHash);
  await authorizeMarketplaceCall(transaction, call, context.actor);
  let withdrawal: ReturnType<typeof extractWithdrawal>;
  try {
    withdrawal = extractWithdrawal({
      receiptStatus: transaction.receiptStatus,
      logs: transaction.logs,
      expectedAccount: context.actor,
    });
  } catch {
    throw new ApiProblem(
      409,
      "INVALID_WITHDRAWAL_RECEIPT",
      "The transaction does not contain the expected wallet withdrawal event.",
    );
  }
  const claimableAfter = await marketplacePublicClient().readContract({
    address: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
    abi: marketplaceEscrowAbi,
    functionName: "claimable",
    args: [context.actor],
    blockNumber: transaction.blockNumber,
  });
  assertWithdrawalPostState(claimableAfter);
  return Object.freeze({
    settlement: await readSettlementState(context),
    confirmation: Object.freeze({
      txHash,
      amountUsdc: withdrawal.amount.toString(),
      blockNumber: transaction.blockNumber.toString(),
    }),
  });
}

async function settlementContext(input: {
  campaignId: string;
  session: AuthenticatedWalletSession;
}): Promise<SettlementContext> {
  const detail = await getMarketplaceCampaignDetail({
    campaignId: input.campaignId,
    viewerWallet: input.session.wallet,
  });
  const actor = getAddress(input.session.wallet);
  const brand = getAddress(detail.campaign.brandWallet);
  const role = actor === brand ? "brand" : "creator";
  if (role === "creator" && !detail.viewerApplication) {
    throw new ApiProblem(
      403,
      "CAMPAIGN_PARTICIPANT_REQUIRED",
      "Only this campaign's brand or an applying creator can inspect its settlement controls.",
    );
  }
  if (
    detail.campaign.chainId !== BASE_SEPOLIA_CHAIN_ID ||
    detail.campaign.escrowContract?.toLowerCase() !==
      INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow.toLowerCase() ||
    !detail.campaign.escrowCampaignId ||
    !/^[1-9][0-9]*$/.test(detail.campaign.escrowCampaignId)
  ) {
    throw new ApiProblem(
      409,
      "CAMPAIGN_ESCROW_NOT_READY",
      "The campaign is not bound to the pinned Base Sepolia escrow.",
    );
  }
  return Object.freeze({
    campaign: detail.campaign,
    actor,
    role,
    escrowCampaignId: BigInt(detail.campaign.escrowCampaignId),
  });
}

async function readSettlementState(
  context: SettlementContext,
): Promise<MarketplaceSettlementStateDto> {
  const client = marketplacePublicClient();
  const blockNumber = await client.getBlockNumber();
  const [block, claimable, campaign] = await Promise.all([
    client.getBlock({ blockNumber }),
    client.readContract({
      address: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
      abi: marketplaceEscrowAbi,
      functionName: "claimable",
      args: [context.actor],
      blockNumber,
    }),
    readChainCampaign(context, blockNumber),
  ]);
  const unallocated = marketplaceUnallocatedBudget(campaign);
  return Object.freeze({
    actorWallet: context.actor.toLowerCase(),
    role: context.role,
    blockNumber: blockNumber.toString(),
    claimableUsdc: claimable.toString(),
    unallocatedUsdc: unallocated.toString(),
    canWithdraw: claimable > 0n,
    canCreditUnallocated:
      context.role === "brand" &&
      unallocated > 0n &&
      block.timestamp > campaign.selectionDeadline,
    selectionDeadline: new Date(Number(campaign.selectionDeadline) * 1_000).toISOString(),
  });
}

async function readChainCampaign(
  context: SettlementContext,
  blockNumber: bigint,
): Promise<SettlementChainCampaign> {
  const raw = await marketplacePublicClient().readContract({
    address: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
    abi: marketplaceEscrowAbi,
    functionName: "campaigns",
    args: [context.escrowCampaignId],
    blockNumber,
  });
  const campaign = Object.freeze({
    brand: getAddress(raw[0]),
    termsHash: raw[1].toLowerCase() as Hex,
    deposited: raw[2],
    allocated: raw[3],
    disbursed: raw[4],
    unallocatedWithdrawn: raw[5],
    applicationDeadline: raw[6],
    selectionDeadline: raw[7],
    submissionDeadline: raw[8],
    retentionSeconds: raw[9],
  });
  if (
    campaign.brand.toLowerCase() !== context.campaign.brandWallet.toLowerCase() ||
    campaign.termsHash !== context.campaign.termsHash.toLowerCase() ||
    campaign.deposited.toString() !== context.campaign.budgetUsdc ||
    campaign.applicationDeadline !== documentUint(
      context.campaign.termsDocument.applicationDeadline,
      "applicationDeadline",
    ) ||
    campaign.selectionDeadline !== documentUint(
      context.campaign.termsDocument.selectionDeadline,
      "selectionDeadline",
    ) ||
    campaign.submissionDeadline !== documentUint(
      context.campaign.termsDocument.submissionDeadline,
      "submissionDeadline",
    ) ||
    campaign.retentionSeconds !== documentUint(
      context.campaign.termsDocument.retentionSeconds,
      "retentionSeconds",
    )
  ) {
    throw new ApiProblem(
      409,
      "CAMPAIGN_ESCROW_BINDING_MISMATCH",
      "The Base escrow campaign does not match the persisted campaign terms.",
    );
  }
  marketplaceUnallocatedBudget(campaign);
  return campaign;
}

function documentUint(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`The persisted campaign ${field} is invalid.`);
  }
  return BigInt(value);
}

function transactionDto(call: PreparedMarketplaceCall): MarketplaceTransactionDto {
  return Object.freeze({
    chainId: call.chainId,
    to: call.address.toLowerCase(),
    data: call.data.toLowerCase(),
    value: "0",
  });
}
