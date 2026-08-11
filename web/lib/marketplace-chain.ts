import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseUnits,
  recoverTypedDataAddress,
  size,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  assignmentAgreementHash,
  campaignTermsHash,
  normalizeBytes32,
  submissionEvidenceHash,
} from "./marketplace-commitments.ts";

export const BASE_SEPOLIA_CHAIN_ID = 84_532 as const;
export const BASE_SEPOLIA_USDC_DECIMALS = 6 as const;
export const INFLUENCEDX_AGREEMENT_SCHEMA_VERSION = 1 as const;
export const INFLUENCEDX_SUBMISSION_SCHEMA_VERSION = 1 as const;

const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_X_POST_ID = 18_446_744_073_709_551_615n;

/**
 * Base Sepolia deployment pinned in deployments/base-sepolia.json.
 * The XProof EIP-712 name is an immutable protocol identifier on the already
 * deployed receiver and therefore intentionally survives the InfluencedX
 * product rename.
 */
export const INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT = Object.freeze({
  chainId: BASE_SEPOLIA_CHAIN_ID,
  usdc: getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  registry: getAddress("0x10079ef049d283bc3f212ccac4291b3ac2719c48"),
  escrow: getAddress("0x7e9b6b757d1ef12509889826b2f2a42906661927"),
  receiver: getAddress("0x15ddbcd98f97065746a1c35f88bb670a7a942264"),
  genlayerResolver: getAddress("0x017311b35dbB9802883bDaE7Fb0Efd7Bd77cB0b2"),
  genlayerContract:
    "0x000000000000000000000000017311b35dbb9802883bdae7fb0efd7bd77cb0b2" as Hex,
  protocolFeeBps: 250,
  receiverDomainName: "XProofAttestationReceiver",
  receiverDomainVersion: "2",
  watcherSnapshot: Object.freeze([
    getAddress("0x51a54A0E3Fc06B108175b06bE25bFB253Ec53c40"),
    getAddress("0x8C6b2b9151f004F8a9941a21Aad87bef5B3fCAd1"),
    getAddress("0x08C6D0B23D30bA84978Eba0CcC334a401c77572c"),
  ]),
  thresholdSnapshot: 2,
});

export const nativeUsdcAbi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const marketplaceCreatorRegistryAbi = parseAbi([
  "function getProfile(address wallet) view returns ((uint256 profileId, address wallet, bytes32 identityHash, bytes32 handleHash, bytes32 verificationPostHash, bytes32 metricsHash, uint64 verifiedAt, uint64 expiresAt, uint64 metricsMeasuredAt, uint64 metricsExpiresAt, bool active))",
  "function isVerified(address wallet, bytes32 identityHash) view returns (bool)",
  "function hasFreshMetrics(address wallet) view returns (bool)",
]);

export const marketplaceEscrowAbi = parseAbi([
  "function createCampaign(bytes32 termsHash, uint256 budget, uint64 applicationDeadline, uint64 selectionDeadline, uint64 submissionDeadline, uint64 retentionSeconds) returns (uint256 campaignId)",
  "function selectCreator(uint256 campaignId, address creator, bytes32 identityHash, bytes32 agreementHash, uint256 payout) returns (uint256 assignmentId)",
  "function acceptAssignment(uint256 assignmentId)",
  "function submitEvidence(uint256 assignmentId, bytes32 postIdHash, bytes32 submissionHash)",
  "function requestResolution(uint256 assignmentId) returns (bytes32 requestId)",
  "function cancelExpiredAssignment(uint256 assignmentId)",
  "function creditUnallocatedBudget(uint256 campaignId) returns (uint256 amount)",
  "function withdraw()",
  "function campaignCount() view returns (uint256)",
  "function assignmentCount() view returns (uint256)",
  "function claimable(address account) view returns (uint256)",
  "function campaigns(uint256 campaignId) view returns (address brand, bytes32 termsHash, uint256 deposited, uint256 allocated, uint256 disbursed, uint256 unallocatedWithdrawn, uint64 applicationDeadline, uint64 selectionDeadline, uint64 submissionDeadline, uint64 retentionSeconds)",
  "function assignments(uint256 assignmentId) view returns (uint256 campaignId, address creator, bytes32 identityHash, bytes32 agreementHash, uint256 payout, uint64 acceptedAt, uint64 submittedAt, bytes32 postIdHash, bytes32 submissionHash, bytes32 requestId, uint32 resolutionRound, uint16 feeBps, uint8 status)",
  "event CampaignCreated(uint256 indexed campaignId, address indexed brand, bytes32 indexed termsHash, uint256 deposited)",
  "event CreatorSelected(uint256 indexed assignmentId, uint256 indexed campaignId, address indexed creator, uint256 payout)",
  "event AssignmentAccepted(uint256 indexed assignmentId, bytes32 indexed agreementHash)",
  "event EvidenceSubmitted(uint256 indexed assignmentId, bytes32 indexed postIdHash, bytes32 indexed submissionHash)",
  "event ResolutionRequested(uint256 indexed assignmentId, bytes32 indexed requestId, uint32 indexed round, bytes32 agreementHash, bytes32 submissionHash)",
  "event AssignmentSettled(uint256 indexed assignmentId, bytes32 indexed requestId, uint8 outcome, bytes32 evidenceHash)",
  "event AssignmentCancelled(uint256 indexed assignmentId)",
  "event UnallocatedCredited(uint256 indexed campaignId, address indexed brand, uint256 amount)",
  "event Withdrawal(address indexed account, uint256 amount)",
]);

export const marketplaceAttestationReceiverAbi = parseAbi([
  "function escrow() view returns (address)",
  "function submitCampaignResolution((bytes32 requestId, uint256 assignmentId, uint8 outcome, bytes32 evidenceHash, bytes32 genlayerContract, bytes32 genlayerTxHash, uint64 resolvedAt, uint64 relayDeadline) item, bytes[] signatures)",
  "function threshold() view returns (uint256)",
  "function isWatcher(address watcher) view returns (bool)",
  "function usedAttestations(bytes32 attestationId) view returns (bool)",
  "event CampaignResolutionRelayed(bytes32 indexed requestId, uint256 indexed assignmentId, uint8 outcome, bytes32 evidenceHash)",
]);

export const assignmentStatuses = [
  "NONE",
  "SELECTED",
  "ACCEPTED",
  "SUBMITTED",
  "RESOLUTION_REQUESTED",
  "UNDETERMINED",
  "PAID",
  "REFUNDED",
  "CANCELLED",
] as const;

export type AssignmentStatus = (typeof assignmentStatuses)[number];
export type CampaignOutcome = 1 | 2 | 3;

export type PreparedMarketplaceCall<
  TName extends string = string,
  TArgs extends readonly unknown[] = readonly unknown[],
> = Readonly<{
  chainId: typeof BASE_SEPOLIA_CHAIN_ID;
  address: Address;
  abi: Abi;
  functionName: TName;
  args: TArgs;
  data: Hex;
  value: 0n;
}>;

export type CampaignFundingPlan = Readonly<{
  brand: Address;
  termsHash: Hex;
  budgetAtoms: bigint;
  allowanceRead: PreparedMarketplaceCall<"allowance", readonly [Address, Address]>;
  balanceRead: PreparedMarketplaceCall<"balanceOf", readonly [Address]>;
  approvalCall: PreparedMarketplaceCall<"approve", readonly [Address, bigint]>;
  createCampaignCall: PreparedMarketplaceCall<
    "createCampaign",
    readonly [Hex, bigint, bigint, bigint, bigint, bigint]
  >;
}>;

export type AssignmentAgreementCommitment = Readonly<{
  schemaVersion: typeof INFLUENCEDX_AGREEMENT_SCHEMA_VERSION;
  chainId: typeof BASE_SEPOLIA_CHAIN_ID;
  escrowContract: Address;
  tokenAddress: Address;
  escrowCampaignId: string;
  campaignRecordId: string;
  campaignRevision: string;
  applicationRecordId: string;
  applicationRevision: string;
  termsHash: Hex;
  brandWallet: Address;
  creatorWallet: Address;
  identityHash: Hex;
  payoutAtoms: string;
  protocolFeeBps: number;
}>;

export type AssignmentSubmissionCommitment = Readonly<{
  schemaVersion: typeof INFLUENCEDX_SUBMISSION_SCHEMA_VERSION;
  chainId: typeof BASE_SEPOLIA_CHAIN_ID;
  escrowContract: Address;
  assignmentId: string;
  agreementHash: Hex;
  creatorWallet: Address;
  expectedHandle: string;
  xPostId: string;
}>;

export const campaignResolutionTypes = {
  CampaignResolution: [
    { name: "requestId", type: "bytes32" },
    { name: "assignmentId", type: "uint256" },
    { name: "outcome", type: "uint8" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "genlayerContract", type: "bytes32" },
    { name: "genlayerTxHash", type: "bytes32" },
    { name: "resolvedAt", type: "uint64" },
    { name: "relayDeadline", type: "uint64" },
  ],
} as const;

export type CampaignResolutionMessage = Readonly<{
  requestId: Hex;
  assignmentId: bigint;
  outcome: CampaignOutcome;
  evidenceHash: Hex;
  genlayerContract: Hex;
  genlayerTxHash: Hex;
  resolvedAt: bigint;
  relayDeadline: bigint;
}>;

export type MarketplaceReceiptLog = Readonly<{
  address: Address | string;
  data: Hex;
  topics: readonly Hex[];
}>;

export function assertBaseSepoliaChain(chainId: unknown): asserts chainId is 84_532 {
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error("Marketplace transactions must target Base Sepolia (chain 84532).");
  }
}

/** Converts a human USDC amount to its canonical 6-decimal atom value. */
export function parseUsdcAmount(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) {
    throw new Error("USDC amount must be a nonnegative decimal with at most 6 places.");
  }
  const atoms = parseUnits(value, BASE_SEPOLIA_USDC_DECIMALS);
  if (atoms > MAX_UINT256) throw new Error("USDC amount exceeds uint256.");
  return atoms;
}

export function prepareCampaignFunding(input: {
  chainId: unknown;
  brand: unknown;
  termsDocument: unknown;
  budgetUsdc: unknown;
  applicationDeadline: unknown;
  selectionDeadline: unknown;
  submissionDeadline: unknown;
  retentionSeconds: unknown;
  nowSeconds: unknown;
}): CampaignFundingPlan {
  assertBaseSepoliaChain(input.chainId);
  const brand = normalizeAddress(input.brand, "brand");
  const budgetAtoms = parseUsdcAmount(input.budgetUsdc);
  if (budgetAtoms === 0n) throw new Error("Campaign budget must be greater than zero.");
  const applicationDeadline = normalizeUint64(input.applicationDeadline, "applicationDeadline");
  const selectionDeadline = normalizeUint64(input.selectionDeadline, "selectionDeadline");
  const submissionDeadline = normalizeUint64(input.submissionDeadline, "submissionDeadline");
  const retentionSeconds = normalizeUint64(input.retentionSeconds, "retentionSeconds");
  const nowSeconds = normalizeUint64(input.nowSeconds, "nowSeconds");
  if (
    applicationDeadline <= nowSeconds ||
    selectionDeadline <= applicationDeadline ||
    submissionDeadline <= selectionDeadline ||
    retentionSeconds === 0n
  ) {
    throw new Error("Campaign deadlines are not strictly ordered or are already expired.");
  }
  const termsHash = campaignTermsHash(input.termsDocument);
  const deployment = INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT;

  const allowanceArgs = [brand, deployment.escrow] as const;
  const balanceArgs = [brand] as const;
  const approvalArgs = [deployment.escrow, budgetAtoms] as const;
  const campaignArgs = [
    termsHash,
    budgetAtoms,
    applicationDeadline,
    selectionDeadline,
    submissionDeadline,
    retentionSeconds,
  ] as const;

  return Object.freeze({
    brand,
    termsHash,
    budgetAtoms,
    allowanceRead: preparedCall(
      deployment.usdc,
      nativeUsdcAbi,
      "allowance",
      allowanceArgs,
      encodeFunctionData({ abi: nativeUsdcAbi, functionName: "allowance", args: allowanceArgs }),
    ),
    balanceRead: preparedCall(
      deployment.usdc,
      nativeUsdcAbi,
      "balanceOf",
      balanceArgs,
      encodeFunctionData({ abi: nativeUsdcAbi, functionName: "balanceOf", args: balanceArgs }),
    ),
    approvalCall: preparedCall(
      deployment.usdc,
      nativeUsdcAbi,
      "approve",
      approvalArgs,
      encodeFunctionData({ abi: nativeUsdcAbi, functionName: "approve", args: approvalArgs }),
    ),
    createCampaignCall: preparedCall(
      deployment.escrow,
      marketplaceEscrowAbi,
      "createCampaign",
      campaignArgs,
      encodeFunctionData({ abi: marketplaceEscrowAbi, functionName: "createCampaign", args: campaignArgs }),
    ),
  });
}

export function buildAssignmentAgreementCommitment(input: {
  chainId: unknown;
  escrowCampaignId: unknown;
  campaignRecordId: unknown;
  campaignRevision: unknown;
  applicationRecordId: unknown;
  applicationRevision: unknown;
  termsHash: unknown;
  brandWallet: unknown;
  creatorWallet: unknown;
  identityHash: unknown;
  payoutAtoms: unknown;
}): AssignmentAgreementCommitment {
  assertBaseSepoliaChain(input.chainId);
  const commitment = {
    schemaVersion: INFLUENCEDX_AGREEMENT_SCHEMA_VERSION,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    escrowContract: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
    tokenAddress: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.usdc,
    escrowCampaignId: normalizePositiveUint(input.escrowCampaignId, "escrowCampaignId").toString(),
    campaignRecordId: normalizeRecordId(input.campaignRecordId, "campaignRecordId"),
    campaignRevision: normalizeNonnegativeUint(input.campaignRevision, "campaignRevision").toString(),
    applicationRecordId: normalizeRecordId(input.applicationRecordId, "applicationRecordId"),
    applicationRevision: normalizeNonnegativeUint(input.applicationRevision, "applicationRevision").toString(),
    termsHash: normalizeBytes32(input.termsHash, "termsHash"),
    brandWallet: normalizeAddress(input.brandWallet, "brandWallet"),
    creatorWallet: normalizeAddress(input.creatorWallet, "creatorWallet"),
    identityHash: normalizeBytes32(input.identityHash, "identityHash"),
    payoutAtoms: normalizePositiveUint(input.payoutAtoms, "payoutAtoms").toString(),
    protocolFeeBps: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.protocolFeeBps,
  } satisfies AssignmentAgreementCommitment;
  return Object.freeze(commitment);
}

export function prepareCreatorSelection(input: Parameters<typeof buildAssignmentAgreementCommitment>[0]): Readonly<{
  agreement: AssignmentAgreementCommitment;
  agreementHash: Hex;
  call: PreparedMarketplaceCall<
    "selectCreator",
    readonly [bigint, Address, Hex, Hex, bigint]
  >;
}> {
  const agreement = buildAssignmentAgreementCommitment(input);
  const agreementHash = assignmentAgreementHash(agreement);
  const args = [
    BigInt(agreement.escrowCampaignId),
    agreement.creatorWallet,
    agreement.identityHash,
    agreementHash,
    BigInt(agreement.payoutAtoms),
  ] as const;
  return Object.freeze({
    agreement,
    agreementHash,
    call: preparedCall(
      INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
      marketplaceEscrowAbi,
      "selectCreator",
      args,
      encodeFunctionData({ abi: marketplaceEscrowAbi, functionName: "selectCreator", args }),
    ),
  });
}

export function prepareAssignmentAcceptance(input: {
  chainId: unknown;
  assignmentId: unknown;
}): PreparedMarketplaceCall<"acceptAssignment", readonly [bigint]> {
  assertBaseSepoliaChain(input.chainId);
  const args = [normalizePositiveUint(input.assignmentId, "assignmentId")] as const;
  return preparedCall(
    INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
    marketplaceEscrowAbi,
    "acceptAssignment",
    args,
    encodeFunctionData({ abi: marketplaceEscrowAbi, functionName: "acceptAssignment", args }),
  );
}

export function buildAssignmentSubmissionCommitment(input: {
  chainId: unknown;
  assignmentId: unknown;
  agreementHash: unknown;
  creatorWallet: unknown;
  expectedHandle: unknown;
  xPostId: unknown;
}): AssignmentSubmissionCommitment {
  assertBaseSepoliaChain(input.chainId);
  return Object.freeze({
    schemaVersion: INFLUENCEDX_SUBMISSION_SCHEMA_VERSION,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    escrowContract: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
    assignmentId: normalizePositiveUint(input.assignmentId, "assignmentId").toString(),
    agreementHash: normalizeBytes32(input.agreementHash, "agreementHash"),
    creatorWallet: normalizeAddress(input.creatorWallet, "creatorWallet"),
    expectedHandle: normalizeXHandle(input.expectedHandle),
    xPostId: normalizeXPostId(input.xPostId),
  });
}

export function xPostIdHash(value: unknown): Hex {
  const postId = normalizeXPostId(value);
  return keccak256(stringToHex(`x-post-id:${postId}`));
}

export function prepareEvidenceSubmission(input: Parameters<typeof buildAssignmentSubmissionCommitment>[0]): Readonly<{
  submission: AssignmentSubmissionCommitment;
  postIdHash: Hex;
  submissionHash: Hex;
  call: PreparedMarketplaceCall<"submitEvidence", readonly [bigint, Hex, Hex]>;
}> {
  const submission = buildAssignmentSubmissionCommitment(input);
  const postIdHash = xPostIdHash(submission.xPostId);
  const submissionHash = submissionEvidenceHash(submission);
  const args = [BigInt(submission.assignmentId), postIdHash, submissionHash] as const;
  return Object.freeze({
    submission,
    postIdHash,
    submissionHash,
    call: preparedCall(
      INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
      marketplaceEscrowAbi,
      "submitEvidence",
      args,
      encodeFunctionData({ abi: marketplaceEscrowAbi, functionName: "submitEvidence", args }),
    ),
  });
}

export function prepareResolutionRequest(input: {
  chainId: unknown;
  assignmentId: unknown;
}): PreparedMarketplaceCall<"requestResolution", readonly [bigint]> {
  assertBaseSepoliaChain(input.chainId);
  const args = [normalizePositiveUint(input.assignmentId, "assignmentId")] as const;
  return preparedCall(
    INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow,
    marketplaceEscrowAbi,
    "requestResolution",
    args,
    encodeFunctionData({ abi: marketplaceEscrowAbi, functionName: "requestResolution", args }),
  );
}

/** Recomputes the exact request ID formula used by AdProofEscrow.requestResolution. */
export function deriveCampaignResolutionRequestId(input: {
  chainId: unknown;
  escrowAddress?: unknown;
  assignmentId: unknown;
  resolutionRound: unknown;
  agreementHash: unknown;
  submissionHash: unknown;
}): Hex {
  assertBaseSepoliaChain(input.chainId);
  const escrow = input.escrowAddress === undefined
    ? INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow
    : normalizeAddress(input.escrowAddress, "escrowAddress");
  if (escrow !== INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow) {
    throw new Error("escrowAddress is not the pinned Base Sepolia escrow.");
  }
  return keccak256(encodeAbiParameters(
    parseAbiParameters(
      "uint256 chainId, address escrow, uint256 assignmentId, uint32 resolutionRound, bytes32 agreementHash, bytes32 submissionHash",
    ),
    [
      BigInt(BASE_SEPOLIA_CHAIN_ID),
      escrow,
      normalizePositiveUint(input.assignmentId, "assignmentId"),
      normalizeUint32(input.resolutionRound, "resolutionRound"),
      normalizeBytes32(input.agreementHash, "agreementHash"),
      normalizeBytes32(input.submissionHash, "submissionHash"),
    ],
  ));
}

export function buildCampaignResolutionTypedData(input: {
  chainId: unknown;
  requestId: unknown;
  assignmentId: unknown;
  outcome: unknown;
  evidenceHash: unknown;
  genlayerContract?: unknown;
  genlayerTxHash: unknown;
  resolvedAt: unknown;
  relayDeadline: unknown;
  nowSeconds: unknown;
}) {
  assertBaseSepoliaChain(input.chainId);
  const outcome = normalizeOutcome(input.outcome);
  const resolvedAt = normalizeUint64(input.resolvedAt, "resolvedAt");
  const relayDeadline = normalizeUint64(input.relayDeadline, "relayDeadline");
  const nowSeconds = normalizeUint64(input.nowSeconds, "nowSeconds");
  if (relayDeadline <= resolvedAt || relayDeadline <= nowSeconds) {
    throw new Error("Campaign resolution relay deadline is expired or invalid.");
  }
  const genlayerContract = input.genlayerContract === undefined
    ? INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.genlayerContract
    : normalizeBytes32(input.genlayerContract, "genlayerContract");
  if (genlayerContract !== INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.genlayerContract.toLowerCase()) {
    throw new Error("Campaign resolution targets the wrong GenLayer resolver.");
  }
  const message = Object.freeze({
    requestId: normalizeBytes32(input.requestId, "requestId"),
    assignmentId: normalizePositiveUint(input.assignmentId, "assignmentId"),
    outcome,
    evidenceHash: normalizeBytes32(input.evidenceHash, "evidenceHash"),
    genlayerContract,
    genlayerTxHash: normalizeBytes32(input.genlayerTxHash, "genlayerTxHash"),
    resolvedAt,
    relayDeadline,
  } satisfies CampaignResolutionMessage);
  return Object.freeze({
    domain: Object.freeze({
      name: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.receiverDomainName,
      version: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.receiverDomainVersion,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      verifyingContract: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.receiver,
    }),
    types: campaignResolutionTypes,
    primaryType: "CampaignResolution" as const,
    message,
  });
}

export function campaignResolutionDigest(
  typedData: ReturnType<typeof buildCampaignResolutionTypedData>,
): Hex {
  return hashTypedData(typedData);
}

export async function validateAndSortCampaignResolutionSignatures(input: {
  typedData: ReturnType<typeof buildCampaignResolutionTypedData>;
  signatures: readonly unknown[];
  authorizedWatchers: readonly unknown[];
  threshold: unknown;
}): Promise<readonly Hex[]> {
  const threshold = Number(normalizePositiveUint(input.threshold, "threshold"));
  const watchers = new Set(
    input.authorizedWatchers.map((value) => normalizeAddress(value, "authorizedWatcher").toLowerCase()),
  );
  if (watchers.size !== input.authorizedWatchers.length || threshold > watchers.size) {
    throw new Error("Watcher authorization set or threshold is invalid.");
  }
  if (input.signatures.length < threshold) {
    throw new Error("Campaign resolution does not have watcher quorum.");
  }
  const recovered = await Promise.all(input.signatures.map(async (value) => {
    if (typeof value !== "string" || !isHex(value) || ![64, 65].includes(size(value))) {
      throw new Error("Campaign resolution contains an invalid watcher signature.");
    }
    const signature = value as Hex;
    const signer = getAddress(await recoverTypedDataAddress({
      ...input.typedData,
      signature,
    }));
    if (!watchers.has(signer.toLowerCase())) {
      throw new Error(`Campaign resolution signer ${signer} is not an authorized watcher.`);
    }
    return { signer, signature };
  }));
  if (new Set(recovered.map(({ signer }) => signer.toLowerCase())).size !== recovered.length) {
    throw new Error("Campaign resolution contains duplicate watcher signatures.");
  }
  recovered.sort((left, right) => (
    left.signer.toLowerCase().localeCompare(right.signer.toLowerCase())
  ));
  return Object.freeze(recovered.map(({ signature }) => signature));
}

export async function prepareCampaignResolutionRelay(input: {
  typedData: ReturnType<typeof buildCampaignResolutionTypedData>;
  signatures: readonly unknown[];
  authorizedWatchers: readonly unknown[];
  threshold: unknown;
}): Promise<Readonly<{
  digest: Hex;
  sortedSignatures: readonly Hex[];
  call: PreparedMarketplaceCall<
    "submitCampaignResolution",
    readonly [CampaignResolutionMessage, readonly Hex[]]
  >;
}>> {
  const sortedSignatures = await validateAndSortCampaignResolutionSignatures(input);
  const signatureList = [...sortedSignatures] as [Hex, ...Hex[]];
  const args = [input.typedData.message, signatureList] as const;
  return Object.freeze({
    digest: campaignResolutionDigest(input.typedData),
    sortedSignatures,
    call: preparedCall(
      INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.receiver,
      marketplaceAttestationReceiverAbi,
      "submitCampaignResolution",
      args,
      encodeFunctionData({
        abi: marketplaceAttestationReceiverAbi,
        functionName: "submitCampaignResolution",
        args,
      }),
    ),
  });
}

/**
 * Produces the object to pass to viem publicClient.simulateContract. This
 * module intentionally has no write helper: callers must simulate, present the
 * exact transaction to the wallet, then independently verify its receipt.
 */
export function marketplaceSimulationRequest(
  call: PreparedMarketplaceCall,
  account: unknown,
) {
  assertBaseSepoliaChain(call.chainId);
  return Object.freeze({
    account: normalizeAddress(account, "account"),
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    value: call.value,
  });
}

export function extractCampaignCreated(input: {
  receiptStatus: unknown;
  logs: readonly MarketplaceReceiptLog[];
  expectedBrand: unknown;
  expectedTermsHash: unknown;
  expectedDeposited: unknown;
}): Readonly<{
  campaignId: bigint;
  brand: Address;
  termsHash: Hex;
  deposited: bigint;
}> {
  if (input.receiptStatus !== "success") {
    throw new Error("Campaign funding transaction was not successful.");
  }
  const expectedBrand = normalizeAddress(input.expectedBrand, "expectedBrand");
  const expectedTermsHash = normalizeBytes32(input.expectedTermsHash, "expectedTermsHash");
  const expectedDeposited = normalizePositiveUint(input.expectedDeposited, "expectedDeposited");
  const decoded = input.logs.flatMap((log) => {
    if (!isAddress(log.address, { strict: false })) return [];
    if (getAddress(log.address) !== INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow) return [];
    try {
      const event = decodeEventLog({
        abi: marketplaceEscrowAbi,
        eventName: "CampaignCreated",
        data: log.data,
        topics: normalizedTopics(log.topics),
        strict: true,
      });
      return event.eventName === "CampaignCreated" ? [event.args] : [];
    } catch {
      return [];
    }
  });
  if (decoded.length !== 1) {
    throw new Error("Campaign funding receipt must contain exactly one CampaignCreated event.");
  }
  const event = decoded[0];
  if (
    getAddress(event.brand) !== expectedBrand ||
    event.termsHash.toLowerCase() !== expectedTermsHash ||
    event.deposited !== expectedDeposited
  ) {
    throw new Error("CampaignCreated event does not match the persisted campaign draft.");
  }
  return Object.freeze({
    campaignId: event.campaignId,
    brand: getAddress(event.brand),
    termsHash: event.termsHash.toLowerCase() as Hex,
    deposited: event.deposited,
  });
}

export function extractCreatorSelected(input: {
  receiptStatus: unknown;
  logs: readonly MarketplaceReceiptLog[];
  expectedCampaignId: unknown;
  expectedCreator: unknown;
  expectedPayout: unknown;
}): Readonly<{
  assignmentId: bigint;
  campaignId: bigint;
  creator: Address;
  payout: bigint;
}> {
  if (input.receiptStatus !== "success") {
    throw new Error("Creator selection transaction was not successful.");
  }
  const expectedCampaignId = normalizePositiveUint(input.expectedCampaignId, "expectedCampaignId");
  const expectedCreator = normalizeAddress(input.expectedCreator, "expectedCreator");
  const expectedPayout = normalizePositiveUint(input.expectedPayout, "expectedPayout");
  const decoded = input.logs.flatMap((log) => {
    if (!isAddress(log.address, { strict: false })) return [];
    if (getAddress(log.address) !== INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow) return [];
    try {
      const event = decodeEventLog({
        abi: marketplaceEscrowAbi,
        eventName: "CreatorSelected",
        data: log.data,
        topics: normalizedTopics(log.topics),
        strict: true,
      });
      return event.eventName === "CreatorSelected" ? [event.args] : [];
    } catch {
      return [];
    }
  });
  if (decoded.length !== 1) {
    throw new Error("Creator selection receipt must contain exactly one CreatorSelected event.");
  }
  const event = decoded[0];
  if (
    event.campaignId !== expectedCampaignId ||
    getAddress(event.creator) !== expectedCreator ||
    event.payout !== expectedPayout
  ) {
    throw new Error("CreatorSelected event does not match the selected application.");
  }
  return Object.freeze({
    assignmentId: event.assignmentId,
    campaignId: event.campaignId,
    creator: getAddress(event.creator),
    payout: event.payout,
  });
}

export function extractAssignmentAccepted(input: {
  receiptStatus: unknown;
  logs: readonly MarketplaceReceiptLog[];
  expectedAssignmentId: unknown;
  expectedAgreementHash: unknown;
}): Readonly<{
  assignmentId: bigint;
  agreementHash: Hex;
}> {
  if (input.receiptStatus !== "success") {
    throw new Error("Assignment acceptance transaction was not successful.");
  }
  const expectedAssignmentId = normalizePositiveUint(
    input.expectedAssignmentId,
    "expectedAssignmentId",
  );
  const expectedAgreementHash = normalizeBytes32(
    input.expectedAgreementHash,
    "expectedAgreementHash",
  );
  const decoded = input.logs.flatMap((log) => {
    if (!isAddress(log.address, { strict: false })) return [];
    if (getAddress(log.address) !== INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow) return [];
    try {
      const event = decodeEventLog({
        abi: marketplaceEscrowAbi,
        eventName: "AssignmentAccepted",
        data: log.data,
        topics: normalizedTopics(log.topics),
        strict: true,
      });
      return event.eventName === "AssignmentAccepted" ? [event.args] : [];
    } catch {
      return [];
    }
  });
  if (decoded.length !== 1) {
    throw new Error("Acceptance receipt must contain exactly one AssignmentAccepted event.");
  }
  const event = decoded[0];
  if (
    event.assignmentId !== expectedAssignmentId ||
    event.agreementHash.toLowerCase() !== expectedAgreementHash
  ) {
    throw new Error("AssignmentAccepted event does not match the selected agreement.");
  }
  return Object.freeze({
    assignmentId: event.assignmentId,
    agreementHash: event.agreementHash.toLowerCase() as Hex,
  });
}

export function extractEvidenceSubmitted(input: {
  receiptStatus: unknown;
  logs: readonly MarketplaceReceiptLog[];
  expectedAssignmentId: unknown;
  expectedPostIdHash: unknown;
  expectedSubmissionHash: unknown;
}): Readonly<{
  assignmentId: bigint;
  postIdHash: Hex;
  submissionHash: Hex;
}> {
  if (input.receiptStatus !== "success") {
    throw new Error("Evidence submission transaction was not successful.");
  }
  const expectedAssignmentId = normalizePositiveUint(
    input.expectedAssignmentId,
    "expectedAssignmentId",
  );
  const expectedPostIdHash = normalizeBytes32(input.expectedPostIdHash, "expectedPostIdHash");
  const expectedSubmissionHash = normalizeBytes32(
    input.expectedSubmissionHash,
    "expectedSubmissionHash",
  );
  const decoded = input.logs.flatMap((log) => {
    if (!isAddress(log.address, { strict: false })) return [];
    if (getAddress(log.address) !== INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow) return [];
    try {
      const event = decodeEventLog({
        abi: marketplaceEscrowAbi,
        eventName: "EvidenceSubmitted",
        data: log.data,
        topics: normalizedTopics(log.topics),
        strict: true,
      });
      return event.eventName === "EvidenceSubmitted" ? [event.args] : [];
    } catch {
      return [];
    }
  });
  if (decoded.length !== 1) {
    throw new Error("Evidence receipt must contain exactly one EvidenceSubmitted event.");
  }
  const event = decoded[0];
  if (
    event.assignmentId !== expectedAssignmentId ||
    event.postIdHash.toLowerCase() !== expectedPostIdHash ||
    event.submissionHash.toLowerCase() !== expectedSubmissionHash
  ) {
    throw new Error("EvidenceSubmitted event does not match the persisted submission.");
  }
  return Object.freeze({
    assignmentId: event.assignmentId,
    postIdHash: event.postIdHash.toLowerCase() as Hex,
    submissionHash: event.submissionHash.toLowerCase() as Hex,
  });
}

export function extractResolutionRequested(input: {
  receiptStatus: unknown;
  logs: readonly MarketplaceReceiptLog[];
  expectedAssignmentId: unknown;
  expectedRequestId: unknown;
  expectedRound: unknown;
  expectedAgreementHash: unknown;
  expectedSubmissionHash: unknown;
}): Readonly<{
  assignmentId: bigint;
  requestId: Hex;
  round: number;
  agreementHash: Hex;
  submissionHash: Hex;
}> {
  if (input.receiptStatus !== "success") {
    throw new Error("Resolution request transaction was not successful.");
  }
  const expectedAssignmentId = normalizePositiveUint(
    input.expectedAssignmentId,
    "expectedAssignmentId",
  );
  const expectedRequestId = normalizeBytes32(input.expectedRequestId, "expectedRequestId");
  const expectedRound = normalizeUint32(input.expectedRound, "expectedRound");
  const expectedAgreementHash = normalizeBytes32(
    input.expectedAgreementHash,
    "expectedAgreementHash",
  );
  const expectedSubmissionHash = normalizeBytes32(
    input.expectedSubmissionHash,
    "expectedSubmissionHash",
  );
  const decoded = input.logs.flatMap((log) => {
    if (!isAddress(log.address, { strict: false })) return [];
    if (getAddress(log.address) !== INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow) return [];
    try {
      const event = decodeEventLog({
        abi: marketplaceEscrowAbi,
        eventName: "ResolutionRequested",
        data: log.data,
        topics: normalizedTopics(log.topics),
        strict: true,
      });
      return event.eventName === "ResolutionRequested" ? [event.args] : [];
    } catch {
      return [];
    }
  });
  if (decoded.length !== 1) {
    throw new Error("Resolution receipt must contain exactly one ResolutionRequested event.");
  }
  const event = decoded[0];
  if (
    event.assignmentId !== expectedAssignmentId ||
    event.requestId.toLowerCase() !== expectedRequestId ||
    event.round !== expectedRound ||
    event.agreementHash.toLowerCase() !== expectedAgreementHash ||
    event.submissionHash.toLowerCase() !== expectedSubmissionHash
  ) {
    throw new Error("ResolutionRequested event does not match the persisted assignment.");
  }
  return Object.freeze({
    assignmentId: event.assignmentId,
    requestId: event.requestId.toLowerCase() as Hex,
    round: event.round,
    agreementHash: event.agreementHash.toLowerCase() as Hex,
    submissionHash: event.submissionHash.toLowerCase() as Hex,
  });
}

export function assignmentStatusFromChain(value: unknown): AssignmentStatus {
  const status = Number(normalizeNonnegativeUint(value, "assignmentStatus"));
  const name = assignmentStatuses[status];
  if (!name) throw new Error("The escrow returned an unknown assignment status.");
  return name;
}

function preparedCall<TName extends string, TArgs extends readonly unknown[]>(
  address: Address,
  abi: Abi,
  functionName: TName,
  args: TArgs,
  data: Hex,
): PreparedMarketplaceCall<TName, TArgs> {
  return Object.freeze({
    chainId: BASE_SEPOLIA_CHAIN_ID,
    address,
    abi,
    functionName,
    args,
    data,
    value: 0n,
  });
}

function normalizedTopics(topics: readonly Hex[]): [] | [Hex, ...Hex[]] {
  if (topics.length === 0) return [];
  return [...topics] as [Hex, ...Hex[]];
}

function normalizeAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new Error(`${label} must be an EVM address.`);
  }
  return getAddress(value);
}

function normalizeUint(value: unknown, label: string, max: bigint): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) parsed = BigInt(value);
  else throw new Error(`${label} must be an unsigned integer.`);
  if (parsed < 0n || parsed > max) throw new Error(`${label} is outside its supported range.`);
  return parsed;
}

function normalizeNonnegativeUint(value: unknown, label: string): bigint {
  return normalizeUint(value, label, MAX_UINT256);
}

function normalizePositiveUint(value: unknown, label: string): bigint {
  const parsed = normalizeNonnegativeUint(value, label);
  if (parsed === 0n) throw new Error(`${label} must be greater than zero.`);
  return parsed;
}

function normalizeUint64(value: unknown, label: string): bigint {
  return normalizeUint(value, label, MAX_UINT64);
}

function normalizeUint32(value: unknown, label: string): number {
  const parsed = normalizeUint(value, label, (1n << 32n) - 1n);
  if (parsed === 0n) throw new Error(`${label} must be greater than zero.`);
  return Number(parsed);
}

function normalizeOutcome(value: unknown): CampaignOutcome {
  if (value !== 1 && value !== 2 && value !== 3) {
    throw new Error("Campaign outcome must be PASS (1), FAIL (2), or UNDETERMINED (3).");
  }
  return value;
}

function normalizeRecordId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function normalizeXHandle(value: unknown): string {
  if (typeof value !== "string") throw new Error("expectedHandle must be an X handle.");
  const handle = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) {
    throw new Error("expectedHandle must be an X handle.");
  }
  return handle;
}

function normalizeXPostId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{5,24}$/.test(value)) {
    throw new Error("xPostId must be an X post ID.");
  }
  if (BigInt(value) > MAX_X_POST_ID) {
    throw new Error("xPostId is outside the supported range.");
  }
  return value;
}
