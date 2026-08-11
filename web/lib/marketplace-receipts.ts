import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import type { PreparedMarketplaceCall } from "./marketplace-chain.ts";
import { ApiProblem } from "./verification-api.ts";

export type ConfirmedMarketplaceTransaction = {
  hash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
  from: Address;
  to: Address | null;
  input: Hex;
  value: bigint;
  receiptStatus: "success" | "reverted";
  logs: ReadonlyArray<{
    address: Address;
    data: Hex;
    topics: readonly Hex[];
  }>;
};

export function requireTransactionHash(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new ApiProblem(
      400,
      "INVALID_TRANSACTION_HASH",
      "txHash must be a Base Sepolia transaction hash.",
    );
  }
  return value.toLowerCase() as Hex;
}

export async function loadConfirmedMarketplaceTransaction(
  txHash: Hex,
): Promise<ConfirmedMarketplaceTransaction> {
  const client = marketplacePublicClient();
  try {
    const [transaction, receipt] = await Promise.all([
      client.getTransaction({ hash: txHash }),
      client.getTransactionReceipt({ hash: txHash }),
    ]);
    if (!transaction.blockHash || receipt.blockHash !== transaction.blockHash) {
      throw new ApiProblem(
        409,
        "TRANSACTION_NOT_CONFIRMED",
        "The Base Sepolia transaction is not confirmed yet.",
      );
    }
    return {
      hash: txHash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
      from: getAddress(transaction.from),
      to: transaction.to ? getAddress(transaction.to) : null,
      input: transaction.input,
      value: transaction.value,
      receiptStatus: receipt.status,
      logs: receipt.logs.map((log) => ({
        address: getAddress(log.address),
        data: log.data,
        topics: log.topics,
      })),
    };
  } catch (error) {
    if (error instanceof ApiProblem) throw error;
    const name =
      error && typeof error === "object" && "name" in error
        ? String((error as { name: unknown }).name)
        : "";
    if (name.includes("NotFound") || name.includes("BlockNotFound")) {
      throw new ApiProblem(
        409,
        "TRANSACTION_NOT_CONFIRMED",
        "The Base Sepolia transaction is not confirmed yet.",
      );
    }
    throw error;
  }
}

export function assertExactMarketplaceCall(
  transaction: ConfirmedMarketplaceTransaction,
  call: PreparedMarketplaceCall,
  expectedActor: string,
): void {
  if (!isAddress(expectedActor, { strict: false })) {
    throw new Error("The persisted marketplace actor is invalid.");
  }
  if (
    transaction.from !== getAddress(expectedActor) ||
    transaction.to !== call.address ||
    transaction.input.toLowerCase() !== call.data.toLowerCase() ||
    transaction.value !== call.value
  ) {
    throw new ApiProblem(
      409,
      "TRANSACTION_CALL_MISMATCH",
      "The confirmed transaction does not match the authorized marketplace action.",
    );
  }
}

export type MarketplaceCallAuthorization = "direct" | "wrapped";

export type MarketplaceTraceCall = Readonly<{
  type?: unknown;
  from?: unknown;
  to?: unknown;
  input?: unknown;
  value?: unknown;
  error?: unknown;
  revertReason?: unknown;
  calls?: unknown;
}>;

/**
 * Wallets may submit an authorized marketplace call through an EIP-7702 or
 * smart-account wrapper instead of making the call the outer transaction. A
 * wrapped receipt is accepted only when a canonical call trace proves exactly
 * one successful inner CALL from the persisted actor to the pinned target with
 * the prepared calldata and zero value. The action-specific receipt decoder
 * must still validate the exact event (and, where an event omits committed
 * fields, the receipt-block contract state).
 */
export async function authorizeMarketplaceCall(
  transaction: ConfirmedMarketplaceTransaction,
  call: PreparedMarketplaceCall,
  expectedActor: string,
  options: Readonly<{ trace?: MarketplaceTraceCall }> = {},
): Promise<MarketplaceCallAuthorization> {
  if (!isAddress(expectedActor, { strict: false })) {
    throw new Error("The persisted marketplace actor is invalid.");
  }
  const actor = getAddress(expectedActor);
  if (
    transaction.from === actor &&
    transaction.to === call.address &&
    transaction.input.toLowerCase() === call.data.toLowerCase() &&
    transaction.value === call.value
  ) {
    return "direct";
  }

  const trace = options.trace ?? (await loadMarketplaceCallTrace(transaction.hash));
  const hasPinnedTargetLog = transaction.logs.some(
    (log) => log.address === call.address,
  );
  if (
    transaction.receiptStatus !== "success" ||
    transaction.value !== 0n ||
    !hasPinnedTargetLog ||
    !traceContainsOnlyExactActorCall(trace, actor, call)
  ) {
    throw new ApiProblem(
      409,
      "TRANSACTION_CALL_MISMATCH",
      "The confirmed transaction does not match the authorized marketplace action.",
    );
  }
  return "wrapped";
}

async function loadMarketplaceCallTrace(
  txHash: Hex,
): Promise<MarketplaceTraceCall> {
  try {
    const response = await fetch(marketplaceRpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "debug_traceTransaction",
        params: [txHash, { tracer: "callTracer", timeout: "10s" }],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const text = await response.text();
    if (!response.ok || text.length > 2_000_000) throw new Error("trace response");
    const parsed = JSON.parse(text) as {
      result?: unknown;
      error?: unknown;
    };
    if (parsed.error || !parsed.result || typeof parsed.result !== "object") {
      throw new Error("trace unavailable");
    }
    return parsed.result as MarketplaceTraceCall;
  } catch {
    throw new ApiProblem(
      503,
      "TRANSACTION_PROOF_UNAVAILABLE",
      "The smart-account transaction proof is temporarily unavailable; retry confirmation shortly.",
    );
  }
}

function traceContainsOnlyExactActorCall(
  root: MarketplaceTraceCall,
  actor: Address,
  call: PreparedMarketplaceCall,
): boolean {
  const actorLower = actor.toLowerCase();
  const targetLower = call.address.toLowerCase();
  const calls: MarketplaceTraceCall[] = [root];
  const actorTargetCalls: MarketplaceTraceCall[] = [];
  let visited = 0;
  while (calls.length > 0) {
    const current = calls.pop();
    if (!current || ++visited > 4_096) return false;
    if (
      current.type === "CALL" &&
      typeof current.from === "string" &&
      typeof current.to === "string" &&
      current.from.toLowerCase() === actorLower &&
      current.to.toLowerCase() === targetLower &&
      current.error == null &&
      current.revertReason == null
    ) {
      actorTargetCalls.push(current);
    }
    if (current.calls != null) {
      if (!Array.isArray(current.calls)) return false;
      for (const nested of current.calls) {
        if (!nested || typeof nested !== "object") return false;
        calls.push(nested as MarketplaceTraceCall);
      }
    }
  }
  if (actorTargetCalls.length !== 1) return false;
  const exact = actorTargetCalls[0];
  return (
    typeof exact.input === "string" &&
    exact.input.toLowerCase() === call.data.toLowerCase() &&
    traceValueIsZero(exact.value)
  );
}

function traceValueIsZero(value: unknown): boolean {
  if (value === 0 || value === 0n) return true;
  return typeof value === "string" && /^0x0+$/.test(value);
}

export function marketplacePublicClient() {
  const rpcUrl = marketplaceRpcUrl();
  return createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl, { timeout: 12_000, retryCount: 1 }),
  });
}

function marketplaceRpcUrl(): string {
  const value =
    process.env.XPROOF_BASE_SEPOLIA_RPC_URL?.trim() ??
    "https://sepolia.base.org";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("XPROOF_BASE_SEPOLIA_RPC_URL is invalid.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("XPROOF_BASE_SEPOLIA_RPC_URL must be an HTTPS URL.");
  }
  return parsed.toString();
}
