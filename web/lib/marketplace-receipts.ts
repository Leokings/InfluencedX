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

function marketplacePublicClient() {
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
