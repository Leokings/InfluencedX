import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import {
  ExecutionResult,
  TransactionHashVariant,
  TransactionStatus,
  type TransactionHash,
} from "genlayer-js/types";
import {
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  http,
  isAddress,
  isHex,
  keccak256,
  padHex,
  parseAbiParameters,
  recoverTypedDataAddress,
  size,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { WatcherConfig } from "./config.js";
import {
  BASE_SEPOLIA_CHAIN_ID,
  campaignResolutionTypes,
  escrowAbi,
  RELAY_WINDOW_SECONDS,
  receiverAbi,
  RESOLUTION_REQUESTED_STATUS,
  STUDIONET_CHAIN_ID,
} from "./constants.js";
import { WatcherProblem } from "./problem.js";

const DOMAIN_NAME = "XProofAttestationReceiver" as const;
const DOMAIN_VERSION = "2" as const;
const COMMITMENT_SCHEMA = "influencedx.marketplace/v1" as const;
const MAX_UINT32 = (1n << 32n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

export type CampaignSignatureRequest = Readonly<{
  schemaVersion: 1;
  requestId: Hex;
  genlayerTxHash: Hex;
  binding: Readonly<{
    campaignId: string;
    assignmentId: string;
    brand: Address;
    creator: Address;
    identityHash: Hex;
    agreementHash: Hex;
    submissionHash: Hex;
    postIdHash: Hex;
    termsDocument: Readonly<Record<string, unknown>>;
    submissionDocument: Readonly<Record<string, unknown>>;
  }>;
}>;

export type CampaignResolutionMessage = Readonly<{
  requestId: Hex;
  assignmentId: bigint;
  outcome: number;
  evidenceHash: Hex;
  genlayerContract: Hex;
  genlayerTxHash: Hex;
  resolvedAt: bigint;
  relayDeadline: bigint;
}>;

export type CampaignTypedData = Readonly<{
  domain: Readonly<{
    name: typeof DOMAIN_NAME;
    version: typeof DOMAIN_VERSION;
    chainId: typeof BASE_SEPOLIA_CHAIN_ID;
    verifyingContract: Address;
  }>;
  types: typeof campaignResolutionTypes;
  primaryType: "CampaignResolution";
  message: CampaignResolutionMessage;
}>;

export type BaseReadClient = Readonly<{
  getChainId(): Promise<number>;
  readContract(input: {
    address: Address;
    abi: typeof receiverAbi | typeof escrowAbi;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}>;

export type FinalizedSource = Readonly<{
  receipt: Record<string, unknown>;
  result: Record<string, unknown>;
}>;

export type WatcherDependencies = Readonly<{
  baseClient?: BaseReadClient;
  readFinalizedSource?: (input: {
    resolver: Address;
    txHash: Hex;
    requestId: Hex;
    rpcUrl: string;
  }) => Promise<FinalizedSource>;
  nowEpoch?: () => number;
}>;

export function parseCampaignSignatureRequest(value: unknown): CampaignSignatureRequest {
  const record = object(value, "The watcher request");
  exactKeys(record, ["schemaVersion", "requestId", "genlayerTxHash", "binding"], "The watcher request");
  if (record.schemaVersion !== 1) invalid("Unsupported watcher request schema.");
  const binding = object(record.binding, "The campaign binding");
  exactKeys(binding, [
    "campaignId", "assignmentId", "brand", "creator", "identityHash", "agreementHash",
    "submissionHash", "postIdHash", "termsDocument", "submissionDocument",
  ], "The campaign binding");
  return Object.freeze({
    schemaVersion: 1,
    requestId: bytes32(record.requestId, "requestId"),
    genlayerTxHash: bytes32(record.genlayerTxHash, "genlayerTxHash"),
    binding: Object.freeze({
      campaignId: positiveUint(binding.campaignId, "campaignId", MAX_UINT256).toString(),
      assignmentId: positiveUint(binding.assignmentId, "assignmentId", MAX_UINT256).toString(),
      brand: address(binding.brand, "brand"),
      creator: address(binding.creator, "creator"),
      identityHash: bytes32(binding.identityHash, "identityHash"),
      agreementHash: bytes32(binding.agreementHash, "agreementHash"),
      submissionHash: bytes32(binding.submissionHash, "submissionHash"),
      postIdHash: bytes32(binding.postIdHash, "postIdHash"),
      termsDocument: Object.freeze({ ...object(binding.termsDocument, "termsDocument") }),
      submissionDocument: Object.freeze({ ...object(binding.submissionDocument, "submissionDocument") }),
    }),
  });
}

export async function signVerifiedCampaignResolution(
  request: CampaignSignatureRequest,
  config: WatcherConfig,
  dependencies: WatcherDependencies = {},
): Promise<Readonly<{
  schemaVersion: 1;
  requestId: Hex;
  signer: Address;
  digest: Hex;
  signature: Hex;
  message: ReturnType<typeof serializeMessage>;
}>> {
  const baseClient = dependencies.baseClient ?? createBaseClient(config.baseRpcUrl);
  const sourceReader = dependencies.readFinalizedSource ?? readFinalizedGenLayerSource;
  const nowEpoch = dependencies.nowEpoch?.() ?? Math.floor(Date.now() / 1_000);
  const verified = await verifyLiveBaseBinding(request, config, baseClient);
  const source = await sourceReader({
    resolver: config.resolver,
    txHash: request.genlayerTxHash,
    requestId: request.requestId,
    rpcUrl: config.genlayerRpcUrl,
  });
  const typedData = buildTypedDataFromFinalizedSource(request, verified, source, config, nowEpoch);
  const account = privateKeyToAccount(config.watcherPrivateKey);
  if (getAddress(account.address) !== getAddress(config.watcherAddress)) {
    throw new WatcherProblem(503, "WATCHER_CONFIGURATION_INVALID", "The watcher signer changed after configuration validation.");
  }
  const signature = await account.signTypedData(typedData);
  const recovered = await recoverTypedDataAddress({ ...typedData, signature });
  if (getAddress(recovered) !== getAddress(config.watcherAddress)) internal("The watcher produced an invalid signature.");
  return Object.freeze({
    schemaVersion: 1,
    requestId: request.requestId,
    signer: getAddress(config.watcherAddress),
    digest: hashTypedData(typedData),
    signature,
    message: serializeMessage(typedData.message),
  });
}

export async function verifyLiveBaseBinding(
  request: CampaignSignatureRequest,
  config: WatcherConfig,
  client: BaseReadClient,
): Promise<Readonly<{
  expectedHandle: string;
  postId: string;
  requiredPhrasesJson: string;
  forbiddenPhrasesJson: string;
  requireAdDisclosure: boolean;
  semanticBrief: string;
  resolveNotBeforeEpoch: bigint;
}>> {
  if (await client.getChainId() !== BASE_SEPOLIA_CHAIN_ID) binding("Base RPC is not Base Sepolia.");
  const assignmentId = BigInt(request.binding.assignmentId);
  const campaignId = BigInt(request.binding.campaignId);
  const expectedGenLayerContract = padHex(config.resolver, { size: 32 }).toLowerCase();
  const [wiredEscrow, wiredResolver, threshold, enabled, used, paused, assignmentValue, campaignValue] = await Promise.all([
    client.readContract({ address: config.receiver, abi: receiverAbi, functionName: "escrow" }),
    client.readContract({ address: config.receiver, abi: receiverAbi, functionName: "genlayerContract" }),
    client.readContract({ address: config.receiver, abi: receiverAbi, functionName: "threshold" }),
    client.readContract({ address: config.receiver, abi: receiverAbi, functionName: "isWatcher", args: [config.watcherAddress] }),
    client.readContract({ address: config.receiver, abi: receiverAbi, functionName: "usedAttestations", args: [request.requestId] }),
    client.readContract({ address: config.receiver, abi: receiverAbi, functionName: "paused" }),
    client.readContract({ address: config.escrow, abi: escrowAbi, functionName: "assignments", args: [assignmentId] }),
    client.readContract({ address: config.escrow, abi: escrowAbi, functionName: "campaigns", args: [campaignId] }),
  ]);
  if (address(wiredEscrow, "receiver escrow") !== getAddress(config.escrow)) binding("The receiver is wired to another escrow.");
  if (bytes32(wiredResolver, "receiver resolver") !== expectedGenLayerContract) binding("The receiver is wired to another GenLayer resolver.");
  if (uint(threshold, "receiver threshold", MAX_UINT256) < 2n) binding("The receiver watcher threshold is unsafe.");
  if (enabled !== true) binding("This watcher is not enabled on the receiver.");
  if (used !== false) binding("This campaign request was already relayed.");
  if (paused !== false) binding("The receiver is paused.");

  const assignment = tuple(assignmentValue, 13, "assignment");
  const campaign = tuple(campaignValue, 10, "campaign");
  if (uint(assignment[0], "assignment campaign", MAX_UINT256) !== campaignId) binding("Assignment campaign mismatch.");
  if (address(assignment[1], "assignment creator") !== request.binding.creator) binding("Assignment creator mismatch.");
  if (bytes32(assignment[2], "assignment identity") !== request.binding.identityHash) binding("Assignment identity mismatch.");
  if (bytes32(assignment[3], "assignment agreement") !== request.binding.agreementHash) binding("Assignment agreement mismatch.");
  const submittedAt = uint(assignment[6], "assignment submittedAt", MAX_UINT64);
  if (submittedAt === 0n) binding("Assignment has no submitted evidence.");
  if (bytes32(assignment[7], "assignment post") !== request.binding.postIdHash) binding("Assignment post mismatch.");
  if (bytes32(assignment[8], "assignment submission") !== request.binding.submissionHash) binding("Assignment submission mismatch.");
  if (bytes32(assignment[9], "assignment request") !== request.requestId) binding("Assignment request mismatch.");
  const round = positiveUint(assignment[10], "assignment resolution round", MAX_UINT32);
  if (uint(assignment[12], "assignment status", 8n) !== RESOLUTION_REQUESTED_STATUS) binding("Assignment is not awaiting resolution.");

  if (address(campaign[0], "campaign brand") !== request.binding.brand) binding("Campaign brand mismatch.");
  const termsHash = bytes32(campaign[1], "campaign terms hash");
  if (marketplaceDocumentHash("campaign-terms", request.binding.termsDocument) !== termsHash) binding("Campaign terms document does not match Base.");
  const retention = positiveUint(campaign[9], "campaign retention", MAX_UINT64);
  const recomputed = deriveRequestId(config.escrow, assignmentId, round, request.binding.agreementHash, request.binding.submissionHash);
  if (recomputed !== request.requestId) binding("Request ID does not match the escrow formula.");

  const terms = request.binding.termsDocument;
  if (terms.schemaVersion !== 1 || terms.network !== "base-sepolia" || terms.chainId !== BASE_SEPOLIA_CHAIN_ID) binding("Campaign terms target another network.");
  if (address(terms.brandWallet, "terms brand") !== request.binding.brand) binding("Campaign terms brand mismatch.");
  const requiredPhrasesJson = phrasesJson(terms.requiredPhrases, "requiredPhrases");
  const forbiddenPhrasesJson = phrasesJson(terms.forbiddenPhrases, "forbiddenPhrases");
  if (typeof terms.requireAdDisclosure !== "boolean") binding("Campaign disclosure flag is invalid.");
  const semanticBrief = canonicalString(terms.semanticBrief, "semanticBrief", 2_000, true);
  if (String(terms.retentionSeconds) !== retention.toString()) binding("Campaign retention commitment mismatch.");

  const submission = request.binding.submissionDocument;
  if (marketplaceDocumentHash("submission-evidence", submission) !== request.binding.submissionHash) binding("Submission document does not match Base.");
  if (submission.schemaVersion !== 1 || submission.chainId !== BASE_SEPOLIA_CHAIN_ID) binding("Submission targets another network.");
  if (address(submission.escrowContract, "submission escrow") !== getAddress(config.escrow)) binding("Submission escrow mismatch.");
  if (positiveUint(submission.assignmentId, "submission assignment", MAX_UINT256) !== assignmentId) binding("Submission assignment mismatch.");
  if (bytes32(submission.agreementHash, "submission agreement") !== request.binding.agreementHash) binding("Submission agreement mismatch.");
  if (address(submission.creatorWallet, "submission creator") !== request.binding.creator) binding("Submission creator mismatch.");
  const expectedHandle = canonicalHandle(submission.expectedHandle);
  const postId = canonicalPostId(submission.xPostId);
  if (keccak256(stringToHex(`x-post-id:${postId}`)) !== request.binding.postIdHash) binding("Submission post ID commitment mismatch.");

  const resolveNotBeforeEpoch = submittedAt + retention;
  if (resolveNotBeforeEpoch > MAX_UINT64) binding("Resolution retention timestamp overflowed uint64.");
  return Object.freeze({
    expectedHandle,
    postId,
    requiredPhrasesJson,
    forbiddenPhrasesJson,
    requireAdDisclosure: terms.requireAdDisclosure,
    semanticBrief,
    resolveNotBeforeEpoch,
  });
}

export function buildTypedDataFromFinalizedSource(
  request: CampaignSignatureRequest,
  binding: Awaited<ReturnType<typeof verifyLiveBaseBinding>>,
  source: FinalizedSource,
  config: WatcherConfig,
  nowEpoch: number,
): CampaignTypedData {
  const receipt = source.receipt;
  const result = source.result;
  const status = receipt.statusName ?? receipt.status_name ?? (receipt.status === 7 ? TransactionStatus.FINALIZED : receipt.status);
  const execution = receipt.txExecutionResultName ?? receipt.tx_execution_result_name ?? (receipt.txExecutionResult === 1 || receipt.tx_execution_result === 1 ? ExecutionResult.FINISHED_WITH_RETURN : receipt.txExecutionResult ?? receipt.tx_execution_result);
  if (status !== TransactionStatus.FINALIZED) sourceInvalid("GenLayer transaction is not finalized.");
  if (execution !== ExecutionResult.FINISHED_WITH_RETURN) sourceInvalid("GenLayer transaction did not finish with a return value.");
  const recipient = receipt.toAddress ?? receipt.recipient ?? receipt.to_address;
  if (address(recipient, "GenLayer transaction recipient") !== getAddress(config.resolver)) sourceInvalid("GenLayer transaction targeted another resolver.");
  const callData = object(receipt.txDataDecoded, "GenLayer decoded transaction").callData;
  const method = callData instanceof Map ? callData.get("method") : object(callData, "GenLayer calldata").method;
  const args = callData instanceof Map ? callData.get("args") : object(callData, "GenLayer calldata").args;
  if (method !== "resolve_submission" || !Array.isArray(args) || args.length !== 11) sourceInvalid("GenLayer transaction method or arguments are invalid.");
  const expectedArgs: readonly unknown[] = [
    request.requestId,
    binding.expectedHandle,
    binding.postId,
    binding.requiredPhrasesJson,
    binding.forbiddenPhrasesJson,
    binding.requireAdDisclosure,
    binding.semanticBrief,
    Number(binding.resolveNotBeforeEpoch),
    Number(request.binding.assignmentId),
    request.binding.agreementHash,
    request.binding.submissionHash,
  ];
  for (let index = 0; index < expectedArgs.length; index += 1) {
    if (canonicalComparable(args[index]) !== canonicalComparable(expectedArgs[index])) sourceInvalid(`GenLayer argument ${index} does not match Base commitments.`);
  }

  if (result.kind !== "CAMPAIGN" || bytes32(result.request_id, "result requestId") !== request.requestId) sourceInvalid("Resolver returned another campaign request.");
  if (positiveUint(result.assignment_id, "result assignmentId", MAX_UINT256).toString() !== request.binding.assignmentId) sourceInvalid("Resolver assignment mismatch.");
  if (bytes32(result.agreement_hash, "result agreementHash") !== request.binding.agreementHash) sourceInvalid("Resolver agreement mismatch.");
  if (bytes32(result.submission_hash, "result submissionHash") !== request.binding.submissionHash) sourceInvalid("Resolver submission mismatch.");
  if (result.handle !== binding.expectedHandle || String(result.post_id) !== binding.postId) sourceInvalid("Resolver X identity or post mismatch.");
  const outcomes: Record<string, number> = { PASS: 1, FAIL: 2, UNDETERMINED: 3 };
  const outcome = typeof result.outcome === "string" ? outcomes[result.outcome] : undefined;
  if (!outcome) sourceInvalid("Resolver outcome is invalid.");
  const resolvedAt = positiveUint(result.resolved_at_epoch, "resolvedAt", MAX_UINT64);
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch <= 0) internal("The watcher clock is invalid.");
  if (resolvedAt > BigInt(nowEpoch + 300)) sourceInvalid("Resolver timestamp is in the future.");
  if (resolvedAt < binding.resolveNotBeforeEpoch) sourceInvalid("Resolver timestamp predates campaign retention.");
  const relayDeadline = resolvedAt + BigInt(RELAY_WINDOW_SECONDS);
  if (relayDeadline > MAX_UINT64 || relayDeadline < BigInt(nowEpoch)) sourceInvalid("Campaign relay deadline has expired.");

  return Object.freeze({
    domain: Object.freeze({
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      verifyingContract: getAddress(config.receiver),
    }),
    types: campaignResolutionTypes,
    primaryType: "CampaignResolution",
    message: Object.freeze({
      requestId: request.requestId,
      assignmentId: BigInt(request.binding.assignmentId),
      outcome,
      evidenceHash: bytes32(result.evidence_hash, "result evidenceHash"),
      genlayerContract: padHex(config.resolver, { size: 32 }).toLowerCase() as Hex,
      genlayerTxHash: request.genlayerTxHash,
      resolvedAt,
      relayDeadline,
    }),
  });
}

export async function readFinalizedGenLayerSource(input: {
  resolver: Address;
  txHash: Hex;
  requestId: Hex;
  rpcUrl: string;
}): Promise<FinalizedSource> {
  if (studionet.id !== STUDIONET_CHAIN_ID) internal("The GenLayer SDK StudioNet chain ID is invalid.");
  const client = createClient({ chain: studionet, endpoint: input.rpcUrl });
  const receipt = await client.getTransaction({ hash: input.txHash as TransactionHash }) as unknown;
  const raw = await client.readContract({
    address: input.resolver,
    functionName: "get_result",
    args: [input.requestId],
    transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
  });
  if (typeof raw !== "string" || raw.length === 0) sourceInvalid("Finalized resolver result is empty.");
  let result: unknown;
  try { result = JSON.parse(raw); } catch { sourceInvalid("Finalized resolver result is not JSON."); }
  return Object.freeze({
    receipt: object(receipt, "GenLayer transaction"),
    result: object(result, "GenLayer result"),
  });
}

function createBaseClient(rpcUrl: string): BaseReadClient {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl, { timeout: 12_000, retryCount: 1 }),
  }) as unknown as BaseReadClient;
}

function serializeMessage(message: CampaignResolutionMessage) {
  return Object.freeze({
    requestId: message.requestId,
    assignmentId: message.assignmentId.toString(),
    outcome: message.outcome,
    evidenceHash: message.evidenceHash,
    genlayerContract: message.genlayerContract,
    genlayerTxHash: message.genlayerTxHash,
    resolvedAt: message.resolvedAt.toString(),
    relayDeadline: message.relayDeadline.toString(),
  });
}

function deriveRequestId(escrow: Address, assignmentId: bigint, round: bigint, agreementHash: Hex, submissionHash: Hex): Hex {
  return keccak256(encodeAbiParameters(
    parseAbiParameters("uint256 chainId, address escrow, uint256 assignmentId, uint32 resolutionRound, bytes32 agreementHash, bytes32 submissionHash"),
    [BigInt(BASE_SEPOLIA_CHAIN_ID), escrow, assignmentId, Number(round), agreementHash, submissionHash],
  ));
}

function marketplaceDocumentHash(kind: "campaign-terms" | "submission-evidence", value: unknown): Hex {
  return keccak256(stringToHex(`${COMMITMENT_SCHEMA}|${kind}|${canonicalJson(value)}`));
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) invalid("Marketplace documents may contain only safe integers.");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) invalid("Marketplace document is not canonical JSON.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid("Marketplace document contains a non-plain object.");
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`).join(",")}}`;
  } finally { ancestors.delete(value); }
}

function phrasesJson(value: unknown, label: string): string {
  if (!Array.isArray(value) || value.length > 20) binding(`${label} is invalid.`);
  const phrases = value.map((entry) => canonicalString(entry, label, 160, false));
  return JSON.stringify(phrases);
}

function canonicalString(value: unknown, label: string, maximum: number, allowEmpty: boolean): string {
  if (typeof value !== "string" || value !== value.trim() || value.length > maximum || (!allowEmpty && value.length === 0)) binding(`${label} is not canonical.`);
  return value;
}

function canonicalHandle(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_]{1,15}$/.test(value)) binding("Submission handle is not canonical.");
  return value;
}

function canonicalPostId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{5,24}$/.test(value) || BigInt(value) > MAX_UINT64) binding("Submission post ID is invalid.");
  return value;
}

function canonicalComparable(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return JSON.stringify(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid(`${label} contains unexpected fields.`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function tuple(value: unknown, minimum: number, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum) binding(`Base ${label} response is invalid.`);
  return value;
}

function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) invalid(`${label} must be an address.`);
  return getAddress(value);
}

function bytes32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHex(value) || size(value) !== 32) invalid(`${label} must be bytes32.`);
  return value.toLowerCase() as Hex;
}

function uint(value: unknown, label: string, maximum: bigint): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) parsed = BigInt(value);
  else invalid(`${label} must be an unsigned integer.`);
  if (parsed! < 0n || parsed! > maximum) invalid(`${label} is out of range.`);
  return parsed!;
}

function positiveUint(value: unknown, label: string, maximum: bigint): bigint {
  const parsed = uint(value, label, maximum);
  if (parsed === 0n) invalid(`${label} must be positive.`);
  return parsed;
}

function invalid(message: string): never { throw new WatcherProblem(400, "INVALID_CAMPAIGN_REQUEST", message); }
function binding(message: string): never { throw new WatcherProblem(409, "CAMPAIGN_BINDING_REJECTED", message); }
function sourceInvalid(message: string): never { throw new WatcherProblem(409, "GENLAYER_SOURCE_REJECTED", message); }
function internal(message: string): never { throw new WatcherProblem(500, "WATCHER_FAILED", message); }
