import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiParameters,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ExecutionResult, TransactionStatus } from "genlayer-js/types";
import type { WatcherConfig } from "../lib/config";
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_ESCROW,
  BASE_SEPOLIA_RECEIVER,
  GENLAYER_NETWORK,
  STUDIONET_CHAIN_ID,
  STUDIONET_RESOLVER,
  STUDIONET_RPC_URL,
} from "../lib/constants";
import type {
  BaseReadClient,
  CampaignSignatureRequest,
  FinalizedSource,
} from "../lib/protocol";

export const watcherPrivateKey = `0x${"11".repeat(32)}` as Hex;
export const watcherAddress = privateKeyToAccount(watcherPrivateKey).address;
export const brand = getAddress("0x1111111111111111111111111111111111111111");
export const creator = getAddress("0x2222222222222222222222222222222222222222");
export const identityHash = `0x${"33".repeat(32)}` as Hex;
export const agreementHash = `0x${"44".repeat(32)}` as Hex;
export const genlayerTxHash = `0x${"55".repeat(32)}` as Hex;
export const evidenceHash = `0x${"66".repeat(32)}` as Hex;
export const campaignId = 7n;
export const assignmentId = 9n;
export const round = 1n;
export const submittedAt = 1_000n;
export const retentionSeconds = 10n;
export const expectedHandle = "creator_x";
export const postId = "20864108500280";

export const termsDocument = Object.freeze({
  schemaVersion: 1,
  network: "base-sepolia",
  chainId: BASE_SEPOLIA_CHAIN_ID,
  brandWallet: brand,
  requiredPhrases: ["InfluencedX"],
  forbiddenPhrases: ["scam"],
  requireAdDisclosure: true,
  semanticBrief: "Show the product honestly.",
  retentionSeconds: retentionSeconds.toString(),
});

export const submissionDocument = Object.freeze({
  schemaVersion: 1,
  chainId: BASE_SEPOLIA_CHAIN_ID,
  escrowContract: getAddress(BASE_SEPOLIA_ESCROW),
  assignmentId: assignmentId.toString(),
  agreementHash,
  creatorWallet: creator,
  expectedHandle,
  xPostId: postId,
});

export const termsHash = documentHash("campaign-terms", termsDocument);
export const submissionHash = documentHash("submission-evidence", submissionDocument);
export const postIdHash = keccak256(stringToHex(`x-post-id:${postId}`));
export const requestId = keccak256(encodeAbiParameters(
  parseAbiParameters("uint256 chainId, address escrow, uint256 assignmentId, uint32 resolutionRound, bytes32 agreementHash, bytes32 submissionHash"),
  [BigInt(BASE_SEPOLIA_CHAIN_ID), getAddress(BASE_SEPOLIA_ESCROW), assignmentId, Number(round), agreementHash, submissionHash],
));

export function configFixture(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
  return Object.freeze({
    baseRpcUrl: "https://base.example.test/",
    genlayerNetwork: GENLAYER_NETWORK,
    genlayerChainId: STUDIONET_CHAIN_ID,
    genlayerRpcUrl: STUDIONET_RPC_URL,
    escrow: BASE_SEPOLIA_ESCROW,
    receiver: BASE_SEPOLIA_RECEIVER,
    resolver: STUDIONET_RESOLVER,
    watcherPrivateKey,
    watcherAddress,
    serviceToken: "s".repeat(40),
    caller: Object.freeze({
      teamSlug: "influencedx",
      teamId: "team_123",
      projectName: "influencedx-campaign-relay",
      projectId: "prj_123",
      environment: "preview",
    }),
    ...overrides,
  }) as WatcherConfig;
}

export function requestFixture(overrides: Partial<CampaignSignatureRequest> = {}): CampaignSignatureRequest {
  return Object.freeze({
    schemaVersion: 1,
    requestId,
    genlayerTxHash,
    binding: Object.freeze({
      campaignId: campaignId.toString(),
      assignmentId: assignmentId.toString(),
      brand,
      creator,
      identityHash,
      agreementHash,
      submissionHash,
      postIdHash,
      termsDocument,
      submissionDocument,
    }),
    ...overrides,
  });
}

export function assignmentFixture(overrides: Record<number, unknown> = {}): readonly unknown[] {
  const value: unknown[] = [
    campaignId,
    creator,
    identityHash,
    agreementHash,
    1_000_000n,
    900n,
    submittedAt,
    postIdHash,
    submissionHash,
    requestId,
    round,
    250n,
    4n,
  ];
  for (const [index, replacement] of Object.entries(overrides)) value[Number(index)] = replacement;
  return value;
}

export function campaignFixture(overrides: Record<number, unknown> = {}): readonly unknown[] {
  const value: unknown[] = [brand, termsHash, 2_000_000n, 1_000_000n, 0n, 0n, 800n, 850n, 3_000n, retentionSeconds];
  for (const [index, replacement] of Object.entries(overrides)) value[Number(index)] = replacement;
  return value;
}

export function baseClientFixture(overrides: {
  chainId?: number;
  wiredEscrow?: Address;
  wiredResolver?: Hex;
  threshold?: bigint;
  enabled?: boolean;
  used?: boolean;
  paused?: boolean;
  assignment?: readonly unknown[];
  campaign?: readonly unknown[];
} = {}): BaseReadClient {
  return Object.freeze({
    async getChainId() { return overrides.chainId ?? BASE_SEPOLIA_CHAIN_ID; },
    async readContract(input: { functionName: string }) {
      if (input.functionName === "escrow") return overrides.wiredEscrow ?? getAddress(BASE_SEPOLIA_ESCROW);
      if (input.functionName === "genlayerContract") return overrides.wiredResolver ?? (`0x${"0".repeat(24)}${STUDIONET_RESOLVER.slice(2)}`.toLowerCase() as Hex);
      if (input.functionName === "threshold") return overrides.threshold ?? 2n;
      if (input.functionName === "isWatcher") return overrides.enabled ?? true;
      if (input.functionName === "usedAttestations") return overrides.used ?? false;
      if (input.functionName === "paused") return overrides.paused ?? false;
      if (input.functionName === "assignments") return overrides.assignment ?? assignmentFixture();
      if (input.functionName === "campaigns") return overrides.campaign ?? campaignFixture();
      throw new Error(`Unexpected Base read ${input.functionName}`);
    },
  });
}

export function sourceFixture(overrides: {
  receipt?: Record<string, unknown>;
  result?: Record<string, unknown>;
  args?: unknown[];
} = {}): FinalizedSource {
  const args = overrides.args ?? [
    requestId,
    expectedHandle,
    postId,
    JSON.stringify(termsDocument.requiredPhrases),
    JSON.stringify(termsDocument.forbiddenPhrases),
    termsDocument.requireAdDisclosure,
    termsDocument.semanticBrief,
    Number(submittedAt + retentionSeconds),
    Number(assignmentId),
    agreementHash,
    submissionHash,
  ];
  return Object.freeze({
    receipt: {
      statusName: TransactionStatus.FINALIZED,
      txExecutionResultName: ExecutionResult.FINISHED_WITH_RETURN,
      toAddress: STUDIONET_RESOLVER,
      txDataDecoded: { callData: { method: "resolve_submission", args } },
      ...(overrides.receipt ?? {}),
    },
    result: {
      kind: "CAMPAIGN",
      request_id: requestId,
      assignment_id: Number(assignmentId),
      agreement_hash: agreementHash,
      submission_hash: submissionHash,
      handle: expectedHandle,
      post_id: postId,
      outcome: "PASS",
      evidence_hash: evidenceHash,
      resolved_at_epoch: 1_500,
      ...(overrides.result ?? {}),
    },
  });
}

function documentHash(kind: string, value: unknown): Hex {
  return keccak256(stringToHex(`influencedx.marketplace/v1|${kind}|${canonical(value)}`));
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
