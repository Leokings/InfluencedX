import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  BASE_SEPOLIA_CHAIN_ID,
  deriveCampaignResolutionRequestId,
  INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT,
  marketplaceAttestationReceiverAbi,
  marketplaceEscrowAbi,
} from "./marketplace-chain.ts";
import type { MarketplaceResolutionContext } from "./marketplace-repository.ts";

const RESOLUTION_REQUESTED_STATUS = 4n;
const MAX_UINT64 = (1n << 64n) - 1n;

export type MarketplaceCampaignBindingClient = {
  getChainId(): Promise<number>;
  readContract(input: {
    address: Address;
    abi: typeof marketplaceEscrowAbi | typeof marketplaceAttestationReceiverAbi;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
};

export type VerifiedMarketplaceCampaignBinding = Readonly<{
  requestId: Hex;
  expectedHandle: string;
  postId: string;
  requiredPhrases: readonly string[];
  forbiddenPhrases: readonly string[];
  requireAdDisclosure: boolean;
  semanticBrief: string;
  resolveNotBeforeEpoch: number;
  assignmentId: string;
  agreementHash: Hex;
  submissionHash: Hex;
}>;

/**
 * Re-reads Base immediately before StudioNet dispatch. The queue envelope is
 * emitted only when the persisted marketplace record and every live onchain
 * assignment/campaign commitment agree, including the Base request-ID formula.
 */
export async function readVerifiedMarketplaceCampaignBinding(input: {
  context: MarketplaceResolutionContext;
  nowEpoch?: number;
  client?: MarketplaceCampaignBindingClient;
}): Promise<VerifiedMarketplaceCampaignBinding> {
  const { campaign, application } = input.context;
  invariant(campaign.chainId === BASE_SEPOLIA_CHAIN_ID, "Campaign chain is not Base Sepolia.");
  invariant(
    campaign.escrowContract?.toLowerCase() ===
      INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow.toLowerCase(),
    "Campaign escrow is not the pinned Base Sepolia deployment.",
  );
  const campaignId = positiveUint(campaign.escrowCampaignId, "campaign ID");
  const assignmentId = positiveUint(application.escrowAssignmentId, "assignment ID");
  const requestId = bytes32(application.requestId, "request ID");
  const agreementHash = bytes32(application.agreementHash, "agreement hash");
  const submissionHash = bytes32(application.submissionHash, "submission hash");
  const identityHash = bytes32(application.identityHash, "identity hash");
  const postIdHash = bytes32(application.postIdHash, "post ID hash");
  const expectedHandle = canonicalHandle(application.creatorHandle);
  const postId = canonicalPostId(application.xPostId);
  const resolutionRound = positiveUint(application.resolutionRound, "resolution round");
  invariant(resolutionRound <= 4_294_967_295n, "Resolution round exceeds uint32.");
  invariant(application.resolutionRequestTxHash !== null, "Resolution request receipt is missing.");
  invariant(application.submissionTxHash !== null, "Evidence submission receipt is missing.");

  const client = input.client ?? createMarketplaceCampaignBindingClient();
  invariant(await client.getChainId() === BASE_SEPOLIA_CHAIN_ID, "Base RPC chain mismatch.");
  const receiverEscrow = getAddress(String(await client.readContract({
    address: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.receiver,
    abi: marketplaceAttestationReceiverAbi,
    functionName: "escrow",
  })));
  invariant(
    receiverEscrow === INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
    "Attestation receiver is wired to another escrow.",
  );

  const [assignmentValue, campaignValue] = await Promise.all([
    client.readContract({
      address: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
      abi: marketplaceEscrowAbi,
      functionName: "assignments",
      args: [assignmentId],
    }),
    client.readContract({
      address: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
      abi: marketplaceEscrowAbi,
      functionName: "campaigns",
      args: [campaignId],
    }),
  ]);
  const assignment = tuple(assignmentValue, 13, "assignment");
  const onchainCampaign = tuple(campaignValue, 10, "campaign");

  invariant(uint(assignment[0], "onchain campaign ID") === campaignId, "Assignment campaign mismatch.");
  invariant(getAddress(String(assignment[1])).toLowerCase() === application.creatorWallet, "Assignment creator mismatch.");
  invariant(bytes32(assignment[2], "onchain identity hash") === identityHash, "Assignment identity mismatch.");
  invariant(bytes32(assignment[3], "onchain agreement hash") === agreementHash, "Assignment agreement mismatch.");
  const submittedAt = uint(assignment[6], "onchain submitted timestamp");
  invariant(submittedAt > 0n, "Assignment has no onchain submission timestamp.");
  invariant(bytes32(assignment[7], "onchain post ID hash") === postIdHash, "Assignment post mismatch.");
  invariant(bytes32(assignment[8], "onchain submission hash") === submissionHash, "Assignment submission mismatch.");
  invariant(bytes32(assignment[9], "onchain request ID") === requestId, "Assignment request ID mismatch.");
  invariant(uint(assignment[10], "onchain resolution round") === resolutionRound, "Assignment resolution round mismatch.");
  invariant(uint(assignment[12], "onchain assignment status") === RESOLUTION_REQUESTED_STATUS, "Assignment is not awaiting resolution.");

  invariant(getAddress(String(onchainCampaign[0])).toLowerCase() === campaign.brandWallet, "Campaign brand mismatch.");
  invariant(bytes32(onchainCampaign[1], "onchain terms hash") === bytes32(campaign.termsHash, "terms hash"), "Campaign terms mismatch.");
  const retentionSeconds = uint(onchainCampaign[9], "onchain retention seconds");
  invariant(retentionSeconds === BigInt(campaign.retentionSeconds), "Campaign retention mismatch.");

  const recomputed = deriveCampaignResolutionRequestId({
    chainId: BASE_SEPOLIA_CHAIN_ID,
    assignmentId,
    resolutionRound,
    agreementHash,
    submissionHash,
  });
  invariant(recomputed === requestId, "Request ID does not match the Base escrow formula.");
  const resolveNotBefore = submittedAt + retentionSeconds;
  invariant(resolveNotBefore <= MAX_UINT64 && resolveNotBefore <= BigInt(Number.MAX_SAFE_INTEGER), "Resolution timestamp is out of range.");
  const resolveNotBeforeEpoch = Number(resolveNotBefore);
  const nowEpoch = input.nowEpoch ?? Math.floor(Date.now() / 1_000);
  invariant(Number.isSafeInteger(nowEpoch) && nowEpoch >= resolveNotBeforeEpoch, "Campaign retention has not ended.");

  return Object.freeze({
    requestId,
    expectedHandle,
    postId,
    requiredPhrases: Object.freeze([...campaign.requiredPhrases]),
    forbiddenPhrases: Object.freeze([...campaign.forbiddenPhrases]),
    requireAdDisclosure: campaign.requireAdDisclosure,
    semanticBrief: campaign.semanticBrief,
    resolveNotBeforeEpoch,
    assignmentId: assignmentId.toString(),
    agreementHash,
    submissionHash,
  });
}

function createMarketplaceCampaignBindingClient(): MarketplaceCampaignBindingClient {
  const value = process.env.XPROOF_BASE_SEPOLIA_RPC_URL?.trim() ?? "https://sepolia.base.org";
  let rpc: URL;
  try {
    rpc = new URL(value);
  } catch {
    throw new Error("XPROOF_BASE_SEPOLIA_RPC_URL is invalid.");
  }
  if (rpc.protocol !== "https:" || rpc.username || rpc.password) {
    throw new Error("XPROOF_BASE_SEPOLIA_RPC_URL must be an HTTPS URL.");
  }
  return createPublicClient({
    chain: baseSepolia,
    transport: http(rpc.toString(), { timeout: 12_000, retryCount: 1 }),
  }) as unknown as MarketplaceCampaignBindingClient;
}

function tuple(value: unknown, length: number, label: string): readonly unknown[] {
  invariant(Array.isArray(value) && value.length >= length, `Base ${label} response is invalid.`);
  return value;
}

function uint(value: unknown, label: string): bigint {
  try {
    const parsed = typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
          ? BigInt(value)
          : -1n;
    invariant(parsed >= 0n, `${label} is invalid.`);
    return parsed;
  } catch {
    throw new Error(`${label} is invalid.`);
  }
}

function positiveUint(value: unknown, label: string): bigint {
  const parsed = uint(value, label);
  invariant(parsed > 0n, `${label} must be positive.`);
  return parsed;
}

function bytes32(value: unknown, label: string): Hex {
  invariant(typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value), `${label} is invalid.`);
  return value.toLowerCase() as Hex;
}

function canonicalHandle(value: unknown): string {
  invariant(typeof value === "string" && /^[a-z0-9_]{1,15}$/.test(value), "Creator handle is not canonical.");
  return value;
}

function canonicalPostId(value: unknown): string {
  invariant(typeof value === "string" && /^[1-9][0-9]{5,24}$/.test(value), "X post ID is invalid.");
  invariant(BigInt(value) <= 18_446_744_073_709_551_615n, "X post ID exceeds uint64.");
  return value;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
