import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import {
  TransactionHashVariant,
  type CalldataEncodable,
  type TransactionHash,
} from "genlayer-js/types";

import type { OperatorConfig } from "./config";
import {
  FINALIZE_CAMPAIGN,
  STUDIONET_CHAIN_ID,
} from "./constants";
import type {
  MarketplaceClient,
  OperationEnvelope,
  Receipt,
  StateSnapshot,
} from "./types";

export function createPinnedMarketplaceClient(config: OperatorConfig): MarketplaceClient {
  if (studionet.id !== STUDIONET_CHAIN_ID || config.chainId !== STUDIONET_CHAIN_ID) {
    throw new Error("The genlayer-js StudioNet chain ID does not match the pinned operator chain ID.");
  }
  const account = createAccount(config.privateKey);
  const client = createClient({ chain: studionet, endpoint: config.rpcUrl, account });

  async function read(functionName: string, args: readonly CalldataEncodable[], finalized: boolean) {
    const value = await client.readContract({
      address: config.rpcContractAddress,
      functionName,
      args: [...args],
      jsonSafeReturn: true,
      transactionHashVariant: finalized
        ? TransactionHashVariant.LATEST_FINAL
        : TransactionHashVariant.LATEST_NONFINAL,
    });
    return normalizeResult(value);
  }

  async function assertBoundary(finalized: boolean): Promise<void> {
    const chainId = await rawRpc(config.rpcUrl, "eth_chainId", []);
    if (chainId !== "0xf22f" && chainId !== STUDIONET_CHAIN_ID) {
      throw new Error("STUDIONET_CHAIN_MISMATCH");
    }
    const identity = asRecord(await read("get_config", [], finalized));
    if (
      identity.protocol_version !== config.contractProtocol ||
      Number(identity.storage_schema_version) !== config.contractSchemaVersion ||
      identity.native_token_symbol !== "GEN" ||
      Number(identity.native_token_decimals) !== 18
    ) throw new Error("MARKETPLACE_CONTRACT_IDENTITY_MISMATCH");
  }

  return Object.freeze({
    signerAddress: account.address.toLowerCase(),
    contractAddress: config.contractAddress,
    async readState(envelope: OperationEnvelope, finalized: boolean): Promise<StateSnapshot> {
      assertEnvelopeBoundary(envelope, config);
      await assertBoundary(finalized);
      if (envelope.action === FINALIZE_CAMPAIGN) {
        return Object.freeze({
          action: envelope.action,
          assignment: null,
          campaign: asRecord(await read("get_campaign", [envelope.args[0]], finalized)),
        });
      }
      const assignment = asRecord(await read("get_assignment", [envelope.args[0]], finalized));
      const campaignId = canonicalHash(assignment.campaign_id, "assignment campaign ID");
      const campaign = asRecord(await read("get_campaign", [campaignId], finalized));
      return Object.freeze({ action: envelope.action, assignment, campaign });
    },
    async submit(envelope: OperationEnvelope): Promise<string> {
      assertEnvelopeBoundary(envelope, config);
      return client.writeContract({
        account,
        address: config.rpcContractAddress,
        functionName: envelope.action,
        args: [...envelope.args] as CalldataEncodable[],
        value: 0n,
      });
    },
    async getTransaction(txHash: string): Promise<Receipt> {
      const hash = canonicalHash(txHash, "transaction hash");
      const [transaction, raw] = await Promise.all([
        client.getTransaction({ hash: hash as TransactionHash }),
        rawRpc(config.rpcUrl, "eth_getTransactionByHash", [hash]),
      ]);
      const rawTransaction = asRecord(raw);
      return {
        ...(transaction as unknown as Receipt),
        rawValueAtto: canonicalQuantity(rawTransaction.value),
      };
    },
  });
}

function assertEnvelopeBoundary(envelope: OperationEnvelope, config: OperatorConfig): void {
  if (
    envelope.network !== config.network ||
    envelope.chainId !== config.chainId ||
    envelope.contractAddress !== config.contractAddress ||
    envelope.valueAtto !== "0"
  ) throw new Error("OPERATOR_ENVELOPE_BOUNDARY_MISMATCH");
}

async function rawRpc(rpcUrl: string, method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("STUDIONET_RPC_UNAVAILABLE");
  const payload = await response.json() as { result?: unknown; error?: unknown };
  if (payload.error !== undefined || payload.result === undefined) throw new Error("STUDIONET_RPC_INVALID");
  return payload.result;
}

function normalizeResult(value: unknown): unknown {
  if (typeof value !== "string") return normalizeMaps(value);
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  return normalizeMaps(JSON.parse(trimmed) as unknown);
}

function normalizeMaps(value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([key, child]) => [String(key), normalizeMaps(child)]));
  }
  if (Array.isArray(value)) return value.map(normalizeMaps);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, normalizeMaps(child)]),
    );
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MARKETPLACE_STATE_INVALID");
  }
  return value as Record<string, unknown>;
}

function canonicalHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function canonicalQuantity(value: unknown): string {
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value).toString();
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error("TRANSACTION_VALUE_UNAVAILABLE");
}
