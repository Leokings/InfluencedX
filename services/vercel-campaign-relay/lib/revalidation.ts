import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { ExecutionResult, TransactionHashVariant, TransactionStatus, type TransactionHash } from "genlayer-js/types";
import {
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  padHex,
  parseAbiParameters,
  size,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import type { RelayConfig } from "./config";
import {
  BASE_SEPOLIA_CHAIN_ID,
  escrowAbi,
  RELAY_WINDOW_SECONDS,
  receiverAbi,
} from "./constants";
import { RelayProblem } from "./problem";
import type { SerializedResolutionMessage, WatcherRequest } from "./types";

const MAX_UINT32 = (1n << 32n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const RESOLUTION_REQUESTED = 4n;

export type CoordinatorBaseClient = Readonly<{
  getChainId(): Promise<number>;
  readContract(input: { address: Address; abi: typeof receiverAbi | typeof escrowAbi; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}>;
export type CoordinatorSource = Readonly<{ receipt: Record<string, unknown>; result: Record<string, unknown> }>;
export type RevalidationDependencies = Readonly<{
  baseClient?: CoordinatorBaseClient;
  readFinalizedSource?: (input: { resolver: Address; txHash: Hex; requestId: Hex; rpcUrl: string }) => Promise<CoordinatorSource>;
  nowEpoch?: () => number;
}>;

export async function independentlyResolveCampaign(input: {
  request: WatcherRequest;
  config: RelayConfig;
  dependencies?: RevalidationDependencies;
}): Promise<Readonly<{
  message: SerializedResolutionMessage;
  threshold: number;
  enabledWatchers: ReadonlySet<string>;
  alreadyUsed: boolean;
}>> {
  const dependencies = input.dependencies ?? {};
  const client = dependencies.baseClient ?? createBaseClient(input.config.baseRpcUrl);
  if (await client.getChainId() !== BASE_SEPOLIA_CHAIN_ID) reject("Base RPC is not Base Sepolia.");
  const request = input.request;
  const assignmentId = BigInt(request.binding.assignmentId);
  const campaignId = BigInt(request.binding.campaignId);
  const [wiredEscrow, wiredResolver, thresholdValue, used, paused, assignmentValue, campaignValue, ...watcherFlags] = await Promise.all([
    client.readContract({ address: input.config.receiver, abi: receiverAbi, functionName: "escrow" }),
    client.readContract({ address: input.config.receiver, abi: receiverAbi, functionName: "genlayerContract" }),
    client.readContract({ address: input.config.receiver, abi: receiverAbi, functionName: "threshold" }),
    client.readContract({ address: input.config.receiver, abi: receiverAbi, functionName: "usedAttestations", args: [request.requestId] }),
    client.readContract({ address: input.config.receiver, abi: receiverAbi, functionName: "paused" }),
    client.readContract({ address: input.config.escrow, abi: escrowAbi, functionName: "assignments", args: [assignmentId] }),
    client.readContract({ address: input.config.escrow, abi: escrowAbi, functionName: "campaigns", args: [campaignId] }),
    ...input.config.watchers.map((watcher) => client.readContract({ address: input.config.receiver, abi: receiverAbi, functionName: "isWatcher", args: [watcher.address] })),
  ]);
  if (address(wiredEscrow, "receiver escrow") !== getAddress(input.config.escrow)) reject("Receiver escrow wiring changed.");
  if (bytes32(wiredResolver, "receiver resolver") !== padHex(input.config.resolver, { size: 32 }).toLowerCase()) reject("Receiver resolver wiring changed.");
  if (paused !== false) reject("Receiver is paused.");
  if (typeof used !== "boolean") reject("Receiver replay state is invalid.");
  const threshold = Number(uint(thresholdValue, "watcher threshold", 3n));
  if (threshold < 2 || threshold > input.config.watchers.length) reject("Receiver threshold is invalid.");
  const enabledWatchers = new Set<string>();
  watcherFlags.forEach((flag, index) => { if (flag === true) enabledWatchers.add(input.config.watchers[index]!.address.toLowerCase()); });
  if (enabledWatchers.size < threshold) reject("Too few configured watchers are enabled.");

  const assignment = tuple(assignmentValue, 13, "assignment");
  const campaign = tuple(campaignValue, 10, "campaign");
  if (uint(assignment[0], "assignment campaign", MAX_UINT256) !== campaignId) reject("Assignment campaign mismatch.");
  if (address(assignment[1], "assignment creator") !== request.binding.creator) reject("Assignment creator mismatch.");
  if (bytes32(assignment[2], "assignment identity") !== request.binding.identityHash) reject("Assignment identity mismatch.");
  if (bytes32(assignment[3], "assignment agreement") !== request.binding.agreementHash) reject("Assignment agreement mismatch.");
  const submittedAt = positive(assignment[6], "assignment submittedAt", MAX_UINT64);
  if (bytes32(assignment[7], "assignment post") !== request.binding.postIdHash) reject("Assignment post mismatch.");
  if (bytes32(assignment[8], "assignment submission") !== request.binding.submissionHash) reject("Assignment submission mismatch.");
  if (bytes32(assignment[9], "assignment request") !== request.requestId) reject("Assignment request mismatch.");
  const round = positive(assignment[10], "assignment round", MAX_UINT32);
  if (uint(assignment[12], "assignment status", 8n) !== RESOLUTION_REQUESTED) reject("Assignment is not awaiting resolution.");
  if (address(campaign[0], "campaign brand") !== request.binding.brand) reject("Campaign brand mismatch.");
  if (documentHash("campaign-terms", request.binding.termsDocument) !== bytes32(campaign[1], "campaign terms")) reject("Campaign terms commitment mismatch.");
  const retention = positive(campaign[9], "campaign retention", MAX_UINT64);
  if (deriveRequestId(input.config.escrow, assignmentId, round, request.binding.agreementHash, request.binding.submissionHash) !== request.requestId) reject("Request ID formula mismatch.");
  if (documentHash("submission-evidence", request.binding.submissionDocument) !== request.binding.submissionHash) reject("Submission commitment mismatch.");
  const terms = request.binding.termsDocument;
  const submission = request.binding.submissionDocument;
  if (terms.chainId !== BASE_SEPOLIA_CHAIN_ID || terms.network !== "base-sepolia" || address(terms.brandWallet, "terms brand") !== request.binding.brand) reject("Campaign terms binding is invalid.");
  if (String(terms.retentionSeconds) !== retention.toString()) reject("Campaign retention commitment mismatch.");
  const requiredPhrasesJson = phrases(terms.requiredPhrases, "required phrases");
  const forbiddenPhrasesJson = phrases(terms.forbiddenPhrases, "forbidden phrases");
  if (typeof terms.requireAdDisclosure !== "boolean") reject("Campaign disclosure commitment is invalid.");
  const semanticBrief = canonicalString(terms.semanticBrief, "semantic brief", 2_000, true);
  if (submission.chainId !== BASE_SEPOLIA_CHAIN_ID || address(submission.escrowContract, "submission escrow") !== getAddress(input.config.escrow)) reject("Submission network binding is invalid.");
  if (positive(submission.assignmentId, "submission assignment", MAX_UINT256) !== assignmentId || bytes32(submission.agreementHash, "submission agreement") !== request.binding.agreementHash || address(submission.creatorWallet, "submission creator") !== request.binding.creator) reject("Submission assignment binding is invalid.");
  const expectedHandle = canonicalHandle(submission.expectedHandle);
  const postId = canonicalPostId(submission.xPostId);
  if (keccak256(stringToHex(`x-post-id:${postId}`)) !== request.binding.postIdHash) reject("Post ID commitment mismatch.");
  const resolveNotBefore = submittedAt + retention;

  const reader = dependencies.readFinalizedSource ?? readFinalizedSource;
  const source = await reader({ resolver: input.config.resolver, txHash: request.genlayerTxHash, requestId: request.requestId, rpcUrl: input.config.genlayerRpcUrl });
  const nowEpoch = dependencies.nowEpoch?.() ?? Math.floor(Date.now() / 1_000);
  const receipt = source.receipt;
  const status = receipt.statusName ?? receipt.status_name ?? (receipt.status === 7 ? TransactionStatus.FINALIZED : receipt.status);
  const execution = receipt.txExecutionResultName ?? receipt.tx_execution_result_name ?? (receipt.txExecutionResult === 1 || receipt.tx_execution_result === 1 ? ExecutionResult.FINISHED_WITH_RETURN : receipt.txExecutionResult ?? receipt.tx_execution_result);
  if (status !== TransactionStatus.FINALIZED || execution !== ExecutionResult.FINISHED_WITH_RETURN) reject("GenLayer transaction is not finalized successfully.");
  if (address(receipt.toAddress ?? receipt.recipient ?? receipt.to_address, "GenLayer recipient") !== getAddress(input.config.resolver)) reject("GenLayer transaction targeted another resolver.");
  const callDataValue = object(receipt.txDataDecoded, "decoded transaction").callData;
  const callData = callDataValue instanceof Map ? callDataValue : object(callDataValue, "GenLayer calldata");
  const method = callData instanceof Map ? callData.get("method") : callData.method;
  const args = callData instanceof Map ? callData.get("args") : callData.args;
  if (method !== "resolve_submission" || !Array.isArray(args) || args.length !== 11) reject("GenLayer calldata is invalid.");
  const expectedArgs = [request.requestId, expectedHandle, postId, requiredPhrasesJson, forbiddenPhrasesJson, terms.requireAdDisclosure, semanticBrief, Number(resolveNotBefore), Number(assignmentId), request.binding.agreementHash, request.binding.submissionHash];
  for (let index = 0; index < expectedArgs.length; index += 1) if (comparable(args[index]) !== comparable(expectedArgs[index])) reject(`GenLayer argument ${index} mismatch.`);
  const result = source.result;
  if (result.kind !== "CAMPAIGN" || bytes32(result.request_id, "result request") !== request.requestId) reject("GenLayer result request mismatch.");
  if (positive(result.assignment_id, "result assignment", MAX_UINT256) !== assignmentId || bytes32(result.agreement_hash, "result agreement") !== request.binding.agreementHash || bytes32(result.submission_hash, "result submission") !== request.binding.submissionHash) reject("GenLayer result assignment binding mismatch.");
  if (result.handle !== expectedHandle || String(result.post_id) !== postId) reject("GenLayer result X binding mismatch.");
  const outcome = { PASS: 1, FAIL: 2, UNDETERMINED: 3 }[String(result.outcome) as "PASS" | "FAIL" | "UNDETERMINED"];
  if (!outcome) reject("GenLayer result outcome is invalid.");
  const resolvedAt = positive(result.resolved_at_epoch, "result resolvedAt", MAX_UINT64);
  if (resolvedAt < resolveNotBefore || resolvedAt > BigInt(nowEpoch + 300)) reject("GenLayer result timestamp is invalid.");
  const relayDeadline = resolvedAt + BigInt(RELAY_WINDOW_SECONDS);
  if (relayDeadline > MAX_UINT64 || relayDeadline < BigInt(nowEpoch)) reject("GenLayer relay deadline expired.");
  const message = Object.freeze({
    requestId: request.requestId,
    assignmentId: assignmentId.toString(),
    outcome,
    evidenceHash: bytes32(result.evidence_hash, "result evidence"),
    genlayerContract: padHex(input.config.resolver, { size: 32 }).toLowerCase() as Hex,
    genlayerTxHash: request.genlayerTxHash,
    resolvedAt: resolvedAt.toString(),
    relayDeadline: relayDeadline.toString(),
  });
  return Object.freeze({ message, threshold, enabledWatchers, alreadyUsed: used });
}

async function readFinalizedSource(input: { resolver: Address; txHash: Hex; requestId: Hex; rpcUrl: string }): Promise<CoordinatorSource> {
  const client = createClient({ chain: testnetBradbury, endpoint: input.rpcUrl });
  const receipt = await client.getTransaction({ hash: input.txHash as TransactionHash }) as unknown;
  const raw = await client.readContract({ address: input.resolver, functionName: "get_result", args: [input.requestId], transactionHashVariant: TransactionHashVariant.LATEST_FINAL });
  if (typeof raw !== "string" || raw.length === 0) reject("Finalized GenLayer result is empty.");
  let result: unknown; try { result = JSON.parse(raw); } catch { reject("Finalized GenLayer result is not JSON."); }
  return Object.freeze({ receipt: object(receipt, "GenLayer transaction"), result: object(result, "GenLayer result") });
}

function createBaseClient(url: string): CoordinatorBaseClient { return createPublicClient({ chain: baseSepolia, transport: http(url, { timeout: 12_000, retryCount: 1 }) }) as unknown as CoordinatorBaseClient; }
function deriveRequestId(escrow: Address, assignment: bigint, round: bigint, agreement: Hex, submission: Hex): Hex { return keccak256(encodeAbiParameters(parseAbiParameters("uint256 chainId,address escrow,uint256 assignmentId,uint32 resolutionRound,bytes32 agreementHash,bytes32 submissionHash"), [BigInt(BASE_SEPOLIA_CHAIN_ID), escrow, assignment, Number(round), agreement, submission])); }
function documentHash(kind: string, value: unknown): Hex { return keccak256(stringToHex(`influencedx.marketplace/v1|${kind}|${canonical(value)}`)); }
function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) reject("Marketplace document contains a float."); return Object.is(value, -0) ? "0" : String(value); }
  if (typeof value !== "object" || ancestors.has(value)) reject("Marketplace document is not canonical JSON.");
  ancestors.add(value); try {
    if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry, ancestors)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) reject("Marketplace document contains a non-plain object.");
    const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key], ancestors)}`).join(",")}}`;
  } finally { ancestors.delete(value); }
}
function phrases(value: unknown, label: string): string { if (!Array.isArray(value) || value.length > 20) reject(`${label} are invalid.`); return JSON.stringify(value.map((entry) => canonicalString(entry, label, 160, false))); }
function canonicalString(value: unknown, label: string, max: number, empty: boolean): string { if (typeof value !== "string" || value !== value.trim() || value.length > max || (!empty && value.length === 0)) reject(`${label} are not canonical.`); return value; }
function canonicalHandle(value: unknown): string { if (typeof value !== "string" || !/^[a-z0-9_]{1,15}$/.test(value)) reject("Creator handle is invalid."); return value; }
function canonicalPostId(value: unknown): string { if (typeof value !== "string" || !/^[1-9][0-9]{5,24}$/.test(value) || BigInt(value) > MAX_UINT64) reject("X post ID is invalid."); return value; }
function object(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) reject(`${label} is invalid.`); return value as Record<string, unknown>; }
function tuple(value: unknown, size: number, label: string): readonly unknown[] { if (!Array.isArray(value) || value.length < size) reject(`Base ${label} response is invalid.`); return value; }
function address(value: unknown, label: string): Address { if (typeof value !== "string" || !isAddress(value, { strict: false })) reject(`${label} is invalid.`); return getAddress(value); }
function bytes32(value: unknown, label: string): Hex { if (typeof value !== "string" || !isHex(value) || size(value) !== 32) reject(`${label} is invalid.`); return value.toLowerCase() as Hex; }
function uint(value: unknown, label: string, max: bigint): bigint { let parsed: bigint; if (typeof value === "bigint") parsed = value; else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value); else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) parsed = BigInt(value); else reject(`${label} is invalid.`); if (parsed! < 0n || parsed! > max) reject(`${label} is out of range.`); return parsed!; }
function positive(value: unknown, label: string, max: bigint): bigint { const parsed = uint(value, label, max); if (parsed === 0n) reject(`${label} must be positive.`); return parsed; }
function comparable(value: unknown): string { if (typeof value === "bigint") return value.toString(); if (typeof value === "number" && Number.isSafeInteger(value)) return String(value); return JSON.stringify(value); }
function reject(message: string): never { throw new RelayProblem(409, "INDEPENDENT_REVALIDATION_REJECTED", message); }
