import { createHash } from "node:crypto";
import { createClient, decodeInputData } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import {
  CalldataAddress,
  TransactionHashVariant,
  TransactionStatus,
  type CalldataEncodable,
  type GenLayerTransaction,
  type TransactionHash,
} from "genlayer-js/types";

export const MARKETPLACE_GENLAYER_NETWORK = "studionet" as const;
export const MARKETPLACE_GENLAYER_CHAIN_ID = 61_999 as const;
export const MARKETPLACE_NATIVE_SYMBOL = "GEN" as const;
export const MARKETPLACE_NATIVE_DECIMALS = 18 as const;
export const DEFAULT_STUDIONET_RPC_URL = "https://studio.genlayer.com/api";
export const MARKETPLACE_V2_STUDIONET_ADDRESS =
  "0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb" as const;
export const MARKETPLACE_V2_STUDIONET_RPC_ADDRESS =
  "0xb72FE7272A5aEdf3c6Ba893394EbeF818fd86Fbb" as const;
export const MARKETPLACE_V2_DEPLOYMENT_TX =
  "0x05ff78998a2b389c7e102f6f09b893dbd16d376f3c18f9748b2b8ef9de5e7998" as const;
export const MARKETPLACE_GENLAYER_ARG_TYPES = [
  "string",
  "bool",
  "uint256",
  "address",
] as const;
export type MarketplaceGenLayerArgType =
  (typeof MARKETPLACE_GENLAYER_ARG_TYPES)[number];

export type MarketplaceGenLayerCall = Readonly<{
  network: typeof MARKETPLACE_GENLAYER_NETWORK;
  chainId: typeof MARKETPLACE_GENLAYER_CHAIN_ID;
  contractAddress: `0x${string}`;
  functionName: string;
  args: readonly CalldataEncodable[];
  argTypes: readonly MarketplaceGenLayerArgType[];
  value: string;
}>;

export type FinalizedMarketplaceTransaction = Readonly<{
  hash: string;
  sender: string;
  recipient: string;
  functionName: string | null;
  args: readonly unknown[] | null;
  lifecycleStatus: string;
  executionResult: string;
  consensusResult: string;
  valueAtto: string;
  finalizedAt: number;
}>;

type MarketplaceReadClient = Pick<
  ReturnType<typeof createClient>,
  "getTransaction" | "readContract"
>;

let cachedClient:
  | { rpcUrl: string; client: ReturnType<typeof createClient> }
  | undefined;

export function marketplaceContractAddress(): `0x${string}` {
  const value = (
    process.env.INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS ??
    process.env.NEXT_PUBLIC_INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS ??
    MARKETPLACE_V2_STUDIONET_ADDRESS
  )
    .trim()
    .toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(value)) {
    throw new Error(
      "INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS is not configured.",
    );
  }
  if (value !== MARKETPLACE_V2_STUDIONET_ADDRESS) {
    throw new Error("INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS is not the pinned V2 deployment.");
  }
  return value as `0x${string}`;
}

export function marketplaceRpcContractAddress(): `0x${string}` {
  marketplaceContractAddress();
  return MARKETPLACE_V2_STUDIONET_RPC_ADDRESS;
}

export function marketplaceContractVersion(): string {
  const value =
    process.env.INFLUENCEDX_GENLAYER_MARKETPLACE_VERSION?.trim() || "2";
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(value)) {
    throw new Error("The GenLayer marketplace version is invalid.");
  }
  return value;
}

export function createMarketplaceReadClient(): ReturnType<typeof createClient> {
  if (studionet.id !== MARKETPLACE_GENLAYER_CHAIN_ID) {
    throw new Error("genlayer-js StudioNet chain ID changed unexpectedly.");
  }
  const rpcUrl = configuredStudioNetRpcUrl();
  if (!cachedClient || cachedClient.rpcUrl !== rpcUrl) {
    cachedClient = {
      rpcUrl,
      client: createClient({ chain: studionet, endpoint: rpcUrl }),
    };
  }
  return cachedClient.client;
}

export async function loadFinalizedMarketplaceTransaction(
  hash: string,
  client: MarketplaceReadClient = createMarketplaceReadClient(),
  valueLoader: (hash: string) => Promise<string> = loadRawTransactionValueAtto,
): Promise<FinalizedMarketplaceTransaction> {
  const normalizedHash = normalizeHash(hash, "transaction hash");
  let transaction: GenLayerTransaction;
  let valueAtto: string;
  try {
    [transaction, valueAtto] = await Promise.all([
      client.getTransaction({ hash: normalizedHash as TransactionHash }),
      valueLoader(normalizedHash),
    ]);
  } catch {
    throw new MarketplaceGenLayerFinalityError(
      "GENLAYER_TRANSACTION_UNAVAILABLE",
      "The StudioNet transaction could not be loaded.",
      true,
    );
  }
  const transactionRecord = transaction as GenLayerTransaction & Record<string, unknown>;
  const lifecycle =
    transaction.statusName ??
    stringValue(transactionRecord.status_name) ??
    String(transaction.status ?? "");
  if (lifecycle !== TransactionStatus.FINALIZED) {
    if (
      lifecycle === TransactionStatus.CANCELED ||
      lifecycle === TransactionStatus.VALIDATORS_TIMEOUT ||
      lifecycle === TransactionStatus.LEADER_TIMEOUT
    ) {
      throw new MarketplaceGenLayerFinalityError(
        "GENLAYER_TRANSACTION_TERMINATED",
        `The StudioNet transaction terminated with ${lifecycle}.`,
        false,
      );
    }
    throw new MarketplaceGenLayerFinalityError(
      "GENLAYER_FINALITY_PENDING",
      "The StudioNet transaction is not finalized yet.",
      true,
    );
  }
  const execution = finalizedExecution(transactionRecord);
  if (!execution.success) {
    throw new MarketplaceGenLayerFinalityError(
      "GENLAYER_EXECUTION_FAILED",
      "The finalized StudioNet transaction did not execute successfully.",
      false,
    );
  }

  const sender = normalizeAddress(
    transaction.sender ?? transaction.from_address,
    "transaction sender",
  );
  const recipient = normalizeAddress(
    transaction.recipient ?? transaction.to_address,
    "transaction recipient",
  );
  const decoded = decodeMarketplaceCall(transaction, recipient);
  return {
    hash: normalizedHash,
    sender,
    recipient,
    functionName: decoded?.functionName ?? null,
    args: decoded?.args ?? null,
    lifecycleStatus: lifecycle,
    executionResult: execution.executionResult,
    consensusResult: execution.consensusResult,
    valueAtto,
    finalizedAt: transactionTimestamp(transaction),
  };
}

export async function readMarketplaceState(
  functionName: string,
  args: readonly CalldataEncodable[],
  client: MarketplaceReadClient = createMarketplaceReadClient(),
): Promise<unknown> {
  const value = await client.readContract({
    address: marketplaceRpcContractAddress(),
    functionName,
    args: [...args],
    jsonSafeReturn: true,
    transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
  });
  return parseJsonResult(value);
}

export function assertTransactionMatchesPreparedCall(input: {
  transaction: FinalizedMarketplaceTransaction;
  call: MarketplaceGenLayerCall;
  actorWallet: string;
}): void {
  const expectedActor = normalizeAddress(input.actorWallet, "actor wallet");
  if (input.transaction.sender !== expectedActor) {
    throw new Error("The StudioNet transaction was signed by another wallet.");
  }
  if (
    input.transaction.recipient !== input.call.contractAddress.toLowerCase()
  ) {
    throw new Error("The StudioNet transaction targets another contract.");
  }
  if (
    input.transaction.functionName === null ||
    input.transaction.args === null
  ) {
    throw new Error("The StudioNet transaction calldata could not be decoded.");
  }
  if (input.transaction.functionName !== input.call.functionName) {
    throw new Error("The StudioNet transaction called another method.");
  }
  if (
    canonicalHash(
      input.transaction.args.map((value, index) =>
        canonicalArgument(value, input.call.argTypes[index]),
      ),
    ) !==
    canonicalHash(
      input.call.args.map((value, index) =>
        canonicalArgument(value, input.call.argTypes[index]),
      ),
    )
  ) {
    throw new Error("The StudioNet transaction arguments do not match.");
  }
  if (input.transaction.valueAtto !== input.call.value) {
    throw new Error("The StudioNet transaction value does not match.");
  }
}

function canonicalArgument(
  value: unknown,
  type: MarketplaceGenLayerArgType | undefined,
): unknown {
  if (type === "address") {
    if (typeof value === "string") return normalizeAddress(value, "address argument");
    if (value && typeof value === "object" && "bytes" in value) {
      const bytes = (value as { bytes?: unknown }).bytes;
      if (bytes instanceof Uint8Array && bytes.length === 20) {
        return `0x${Buffer.from(bytes).toString("hex")}`;
      }
    }
    throw new Error("The StudioNet transaction address argument is invalid.");
  }
  if (type === "uint256") {
    const normalized = typeof value === "bigint" ? value.toString() : String(value);
    if (!/^(0|[1-9][0-9]{0,77})$/.test(normalized) || BigInt(normalized) >= 1n << 256n) {
      throw new Error("The StudioNet transaction uint256 argument is invalid.");
    }
    return normalized;
  }
  if (type === "string") {
    if (typeof value !== "string") throw new Error("The StudioNet transaction string argument is invalid.");
    return value;
  }
  if (type === "bool") {
    if (typeof value !== "boolean") throw new Error("The StudioNet transaction boolean argument is invalid.");
    return value;
  }
  throw new Error("The prepared StudioNet argument type is invalid.");
}

export function canonicalHash(value: unknown): string {
  return `0x${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function canonicalJson(value: unknown): string {
  // Python's contract-side json.dumps uses ensure_ascii=True. JSON.stringify
  // leaves Unicode literal, so escape every non-ASCII UTF-16 code unit (and
  // therefore both halves of a surrogate pair) exactly as Python does.
  return JSON.stringify(canonicalize(value)).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function formatGenAtto(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Native GEN amount is invalid.");
  }
  const padded = value.padStart(MARKETPLACE_NATIVE_DECIMALS + 1, "0");
  const whole = padded.slice(0, -MARKETPLACE_NATIVE_DECIMALS);
  const fraction = padded
    .slice(-MARKETPLACE_NATIVE_DECIMALS)
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function parseGenToAtto(value: unknown, field = "amountGen"): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,38})(?:\.[0-9]{1,18})?$/.test(value)
  ) {
    throw new Error(`${field} must be a positive GEN decimal with at most 18 decimals.`);
  }
  const [whole, fraction = ""] = value.split(".");
  const atto = `${whole}${fraction.padEnd(MARKETPLACE_NATIVE_DECIMALS, "0")}`
    .replace(/^0+(?=[0-9])/, "");
  if (BigInt(atto) <= 0n) throw new Error(`${field} must be greater than zero.`);
  return atto;
}

export function marketplaceCalldataAddress(value: string): CalldataAddress {
  const normalized = normalizeAddress(value, "calldata address");
  return new CalldataAddress(
    Uint8Array.from(
      normalized
        .slice(2)
        .match(/.{2}/g)!
        .map((byte) => Number.parseInt(byte, 16)),
    ),
  );
}

export class MarketplaceGenLayerFinalityError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "MarketplaceGenLayerFinalityError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function finalizedExecution(transaction: Record<string, unknown>): {
  success: boolean;
  executionResult: string;
  consensusResult: string;
} {
  const consensusResult =
    stringValue(transaction.result_name) ??
    stringValue(transaction.resultName) ??
    "";
  const consensus = objectValue(transaction.consensus_data);
  const receipts = Array.isArray(consensus?.leader_receipt)
    ? consensus.leader_receipt
    : [];
  const leaders = receipts
    .map(objectValue)
    .filter((receipt): receipt is Record<string, unknown> => receipt?.mode === "leader");
  if (consensusResult !== "MAJORITY_AGREE" || leaders.length !== 1) {
    return { success: false, executionResult: "", consensusResult };
  }
  const leader = leaders[0];
  const result = objectValue(leader.result);
  const executionResult = stringValue(leader.execution_result) ?? "";
  return {
    success: executionResult === "SUCCESS" && result?.status === "return",
    executionResult,
    consensusResult,
  };
}

export function configuredStudioNetRpcUrl(): string {
  const value =
    process.env.GENLAYER_STUDIONET_RPC_URL?.trim() ||
    process.env.GENLAYER_RPC_URL?.trim() ||
    DEFAULT_STUDIONET_RPC_URL;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("GENLAYER_STUDIONET_RPC_URL is invalid.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("GENLAYER_STUDIONET_RPC_URL must be a clean HTTPS URL.");
  }
  return parsed.toString();
}

export async function loadRawTransactionValueAtto(hash: string): Promise<string> {
  const transactionHash = normalizeHash(hash, "transaction hash");
  const response = await fetch(configuredStudioNetRpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionByHash",
      params: [transactionHash],
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error("The StudioNet transaction value could not be loaded.");
  }
  const text = await response.text();
  if (text.length > 4_000_000) {
    throw new Error("The StudioNet transaction response is too large.");
  }
  // Preserve arbitrary precision. JSON.parse would coerce Studio's numeric
  // `value` field through a JavaScript Number before the backend can compare it.
  const match = /"value"\s*:\s*(?:"(0x[0-9a-fA-F]+|[0-9]+)"|([0-9]+))/.exec(
    text,
  );
  const raw = match?.[1] ?? match?.[2];
  if (!raw) {
    throw new Error("The StudioNet transaction value is missing.");
  }
  const value = raw.startsWith("0x") ? BigInt(raw).toString() : raw;
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value)) {
    throw new Error("The StudioNet transaction value is invalid.");
  }
  return value;
}

function decodeMarketplaceCall(
  transaction: GenLayerTransaction,
  recipient: string,
): { functionName: string; args: readonly unknown[] } | null {
  const transactionRecord = transaction as GenLayerTransaction &
    Record<string, unknown>;
  let callData: unknown = (
    transaction.txDataDecoded as { callData?: unknown } | undefined
  )?.callData;
  if (callData === undefined) {
    const readable = (
      transaction.data as
        | { calldata?: { readable?: unknown } | string }
        | undefined
    )?.calldata;
    const candidate =
      typeof readable === "object" && readable !== null
        ? readable.readable
        : readable;
    if (typeof candidate === "string" && candidate.trim()) {
      try {
        callData = JSON.parse(candidate) as unknown;
      } catch {
        callData = undefined;
      }
    }
  }
  const encoded =
    typeof transaction.txData === "string"
      ? transaction.txData
      : typeof transactionRecord.tx_data === "string"
        ? transactionRecord.tx_data
        : null;
  if (callData === undefined && encoded) {
    try {
      callData = (
        decodeInputData(
          (encoded.startsWith("0x") ? encoded : `0x${encoded}`) as `0x${string}`,
          recipient as `0x${string}`,
        ) as { callData?: unknown } | null
      )?.callData;
    } catch {
      callData = undefined;
    }
  }
  if (callData instanceof Map) {
    const functionName =
      stringValue(callData.get("method")) ??
      stringValue(callData.get("functionName")) ??
      stringValue(callData.get("function_name")) ??
      stringValue(callData.get("name"));
    const args =
      callData.get("args") ??
      callData.get("arguments") ??
      callData.get("params");
    if (!functionName || !Array.isArray(args)) return null;
    return { functionName, args };
  }
  if (!callData || typeof callData !== "object" || Array.isArray(callData)) {
    return null;
  }
  const record = callData as Record<string, unknown>;
  const functionName =
    stringValue(record.method) ??
    stringValue(record.functionName) ??
    stringValue(record.function_name) ??
    stringValue(record.name);
  const args = record.args ?? record.arguments ?? record.params;
  if (!functionName || !Array.isArray(args)) return null;
  return { functionName, args };
}

function parseJsonResult(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("The GenLayer marketplace returned malformed JSON.");
  }
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString("hex")}`;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function transactionTimestamp(transaction: GenLayerTransaction): number {
  const record = transaction as GenLayerTransaction & Record<string, unknown>;
  const raw =
    transaction.createdTimestamp ??
    record.created_timestamp ??
    transaction.lastVoteTimestamp ??
    record.last_vote_timestamp ??
    transaction.currentTimestamp ??
    record.current_timestamp;
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (Number.isSafeInteger(numeric) && numeric > 0) {
      return numeric >= 1_000_000_000_000 ? Math.floor(numeric / 1_000) : numeric;
    }
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1_000);
  }
  if (typeof raw === "bigint" && raw > 0n) {
    const seconds = raw >= 1_000_000_000_000n ? raw / 1_000n : raw;
    if (seconds <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(seconds);
  }
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) {
    return raw >= 1_000_000_000_000 ? Math.floor(raw / 1_000) : raw;
  }
  throw new MarketplaceGenLayerFinalityError(
    "GENLAYER_FINALITY_TIMESTAMP_MISSING",
    "The finalized StudioNet transaction has no trusted consensus timestamp.",
    false,
  );
}

function normalizeAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value.toLowerCase();
}

function normalizeHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value.toLowerCase();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
