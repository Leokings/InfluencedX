import { createAccount, createClient, decodeInputData } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import {
  TransactionHashVariant,
  type CalldataEncodable,
  type TransactionHash,
} from "genlayer-js/types";

import type { ReconcilerConfig } from "./config";
import {
  CONFIRM_METHOD,
  MAX_HISTORY_CANDIDATES,
  STUDIONET_CHAIN_ID,
  WITHDRAWAL_RECOVERY_DELAY_SECONDS,
} from "./constants";
import { fingerprint } from "./envelope";
import { assertEmittedWithdrawal, parseCounts, parseWithdrawal } from "./state";
import type {
  MarketplaceCounts,
  Receipt,
  TransferDiscovery,
  TransferProof,
  WithdrawalClient,
  WithdrawalState,
} from "./types";

const HASH = /^0x[0-9a-f]{64}$/;

export function createPinnedWithdrawalClient(config: ReconcilerConfig): WithdrawalClient {
  if (studionet.id !== STUDIONET_CHAIN_ID || config.chainId !== STUDIONET_CHAIN_ID) {
    throw new Error("STUDIONET_CHAIN_MISMATCH");
  }
  const account = createAccount(config.privateKey);
  if (account.address.toLowerCase() !== config.contractOwner) {
    throw new Error("WITHDRAWAL_SIGNER_IS_NOT_PINNED_OWNER");
  }
  const client = createClient({ chain: studionet, endpoint: config.rpcUrl, account });

  async function read(functionName: string, args: readonly CalldataEncodable[]) {
    const value = await client.readContract({
      address: config.contractAddress,
      functionName,
      args: [...args],
      jsonSafeReturn: true,
      transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
    });
    return normalizeResult(value);
  }

  async function assertBoundary(): Promise<void> {
    const chainId = await rawRpc(config.rpcUrl, "eth_chainId", []);
    if (chainId !== "0xf22f" && chainId !== STUDIONET_CHAIN_ID) throw new Error("STUDIONET_CHAIN_MISMATCH");
    const identity = requiredRecord(await read("get_config", []), "MARKETPLACE_CONFIG_INVALID");
    if (
      identity.protocol_version !== config.contractProtocol ||
      Number(identity.storage_schema_version) !== config.contractSchemaVersion ||
      text(identity.owner)?.toLowerCase() !== config.contractOwner ||
      identity.native_token_symbol !== "GEN" ||
      Number(identity.native_token_decimals) !== 18 ||
      Number(identity.withdrawal_recovery_delay_seconds) !== WITHDRAWAL_RECOVERY_DELAY_SECONDS
    ) throw new Error("MARKETPLACE_CONTRACT_IDENTITY_MISMATCH");
  }

  async function getTransaction(txHash: string): Promise<Receipt> {
    const hash = canonicalHash(txHash, "transaction hash");
    const [transaction, raw] = await Promise.all([
      client.getTransaction({ hash: hash as TransactionHash }),
      rawRpc(config.rpcUrl, "eth_getTransactionByHash", [hash]),
    ]);
    const rawTransaction = requiredRecord(raw, "TRANSACTION_RPC_INVALID");
    return {
      ...(transaction as unknown as Receipt),
      rawValueAtto: canonicalQuantity(rawTransaction.value ?? (transaction as unknown as Receipt).value),
    };
  }

  return Object.freeze({
    signerAddress: account.address.toLowerCase(),
    contractAddress: config.contractAddress,
    async readWithdrawal(withdrawalId: string): Promise<WithdrawalState | null> {
      await assertBoundary();
      const normalized = canonicalHash(withdrawalId, "withdrawal ID");
      return parseWithdrawal(await read("get_withdrawal", [normalized]), normalized);
    },
    async readCounts(): Promise<MarketplaceCounts> {
      await assertBoundary();
      return parseCounts(await read("get_counts", []));
    },
    async discoverTransfer(withdrawal: WithdrawalState, nowEpoch: number): Promise<TransferDiscovery> {
      await assertBoundary();
      assertEmittedWithdrawal(withdrawal);
      const rawHistory = await rawRpc(config.rpcUrl, "sim_getTransactionsForAddress", [config.contractAddress]);
      if (!Array.isArray(rawHistory)) throw new Error("STUDIONET_HISTORY_INVALID");
      const candidateHashes = rawHistory
        .filter((candidate) => coarseParentCandidate(candidate, withdrawal, config.contractAddress))
        .map((candidate) => canonicalHash(requiredRecord(candidate, "HISTORY_TRANSACTION_INVALID").hash, "history transaction hash"));
      if (candidateHashes.length > MAX_HISTORY_CANDIDATES) {
        return { kind: "MANUAL", code: "TRANSFER_HISTORY_CANDIDATE_LIMIT" };
      }

      const exactParents: Receipt[] = [];
      for (const hash of candidateHashes) {
        const candidate = await getTransaction(hash);
        if (finalizedSuccessful(candidate) && exactExecuteCall(candidate, withdrawal.withdrawalId)) {
          exactParents.push(candidate);
        }
      }
      if (exactParents.length > 1) return { kind: "MANUAL", code: "MULTIPLE_FINALIZED_EXECUTION_PARENTS" };
      if (exactParents.length === 0) return delayedOutcome(withdrawal, nowEpoch, "EXECUTION_PARENT_NOT_FINALIZED");

      const parent = exactParents[0];
      const parentHash = receiptHash(parent);
      const childIds = await client.getTriggeredTransactionIds({ hash: parentHash as TransactionHash });
      const children = [...new Set(childIds.map((value) => canonicalHash(value, "child transaction hash")))];
      if (children.length === 0) return delayedOutcome(withdrawal, nowEpoch, "TRANSFER_CHILD_NOT_CREATED");
      if (children.length !== 1) return { kind: "MANUAL", code: "TRANSFER_CHILD_CARDINALITY_MISMATCH" };

      const child = await getTransaction(children[0]);
      const childStatus = lifecycleStatus(child);
      if (childStatus !== "FINALIZED") {
        if (["CANCELED", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT"].includes(childStatus)) {
          return delayedOutcome(withdrawal, nowEpoch, "TRANSFER_CHILD_TERMINATED");
        }
        return { kind: "PENDING", code: "TRANSFER_CHILD_NOT_FINALIZED" };
      }
      const bindingError = externalTransferBindingError(child, parentHash, withdrawal, config.contractAddress);
      if (bindingError) {
        if (bindingError === "TRANSFER_VALUE_NOT_CREDITED") return delayedOutcome(withdrawal, nowEpoch, bindingError);
        return { kind: "MANUAL", code: bindingError };
      }

      const base = Object.freeze({
        schemaVersion: 1 as const,
        domain: "influencedx-withdrawal-transfer-evidence-v1" as const,
        network: "studionet" as const,
        chainId: STUDIONET_CHAIN_ID,
        contractAddress: config.contractAddress,
        withdrawalId: withdrawal.withdrawalId,
        account: withdrawal.account,
        amountAtto: withdrawal.amountAtto,
        emittedAtEpoch: withdrawal.emittedAtEpoch,
        parentTxHash: parentHash,
        childTxHash: receiptHash(child),
        valueCredited: true as const,
      });
      const proof: TransferProof = Object.freeze({ ...base, evidenceHash: fingerprint(base) });
      return { kind: "PROVEN", proof };
    },
    async submitConfirmation(withdrawalId: string, evidenceHash: string): Promise<string> {
      await assertBoundary();
      return client.writeContract({
        account,
        address: config.contractAddress,
        functionName: CONFIRM_METHOD,
        args: [canonicalHash(withdrawalId, "withdrawal ID"), canonicalHash(evidenceHash, "evidence hash")],
        value: 0n,
      });
    },
    getTransaction,
  });
}

export function externalTransferBindingError(
  child: Receipt,
  parentTxHash: string,
  withdrawal: WithdrawalState,
  contractAddress: string,
): string | null {
  if (receiptHash(child) === parentTxHash) return "TRANSFER_CHILD_EQUALS_PARENT";
  const triggeredBy = text(child.triggered_by ?? child.triggeredBy);
  if (!triggeredBy || triggeredBy.toLowerCase() !== parentTxHash) return "TRANSFER_PARENT_LINK_MISMATCH";
  const triggeredOn = text(child.triggered_on ?? child.triggeredOn);
  if (!triggeredOn || triggeredOn.toUpperCase() !== "FINALIZED") return "TRANSFER_TRIGGER_STATE_MISMATCH";
  const sender = text(child.sender ?? child.from_address)?.toLowerCase();
  if (sender !== contractAddress) return "TRANSFER_SENDER_MISMATCH";
  const recipient = text(child.recipient ?? child.to_address)?.toLowerCase();
  if (recipient !== withdrawal.account) return "TRANSFER_RECIPIENT_MISMATCH";
  if (canonicalQuantity(child.rawValueAtto ?? child.value) !== withdrawal.amountAtto) return "TRANSFER_AMOUNT_MISMATCH";
  if (child.value_credited !== true && child.valueCredited !== true) return "TRANSFER_VALUE_NOT_CREDITED";
  return null;
}

function coarseParentCandidate(value: unknown, withdrawal: WithdrawalState, contractAddress: string): boolean {
  const row = asRecord(value);
  if (!row) return false;
  return text(row.from_address ?? row.sender)?.toLowerCase() === withdrawal.account &&
    text(row.to_address ?? row.recipient)?.toLowerCase() === contractAddress &&
    lifecycleStatus(row) === "FINALIZED" &&
    canonicalQuantity(row.value ?? 0) === "0";
}

function exactExecuteCall(receipt: Receipt, withdrawalId: string): boolean {
  const decoded = decodedCall(receipt);
  return decoded.method === "execute_withdrawal" &&
    decoded.args !== null &&
    decoded.args.length === 1 &&
    decoded.args[0] === withdrawalId;
}

export function confirmationBindingError(
  receipt: Receipt,
  expected: Readonly<{
    txHash: string;
    signerAddress: string;
    contractAddress: string;
    withdrawalId: string;
    evidenceHash: string;
  }>,
): string | null {
  if (receiptHash(receipt) !== expected.txHash) return "CONFIRMATION_HASH_MISMATCH";
  if (text(receipt.sender ?? receipt.from_address)?.toLowerCase() !== expected.signerAddress) return "CONFIRMATION_SENDER_MISMATCH";
  if (text(receipt.recipient ?? receipt.to_address)?.toLowerCase() !== expected.contractAddress) return "CONFIRMATION_CONTRACT_MISMATCH";
  if (canonicalQuantity(receipt.rawValueAtto ?? receipt.value) !== "0") return "CONFIRMATION_VALUE_MISMATCH";
  const decoded = decodedCall(receipt);
  if (decoded.method !== CONFIRM_METHOD) return "CONFIRMATION_METHOD_MISMATCH";
  if (!decoded.args || decoded.args.length !== 2) return "CONFIRMATION_ARGUMENTS_MISSING";
  if (decoded.args[0] !== expected.withdrawalId || decoded.args[1] !== expected.evidenceHash) return "CONFIRMATION_ARGUMENTS_MISMATCH";
  return null;
}

export function finalizedSuccessful(receipt: Receipt): boolean {
  if (lifecycleStatus(receipt) !== "FINALIZED") return false;
  const result = text(receipt.result_name ?? receipt.resultName);
  if (result !== "MAJORITY_AGREE") return false;
  const consensus = asRecord(receipt.consensus_data);
  const rawLeaders = consensus?.leader_receipt;
  if (!Array.isArray(rawLeaders)) return false;
  const leaders = rawLeaders.map(asRecord).filter((row): row is Record<string, unknown> => row?.mode === "leader");
  if (leaders.length !== 1) return false;
  const leaderResult = asRecord(leaders[0].result);
  return leaders[0].execution_result === "SUCCESS" && leaderResult?.status === "return";
}

function decodedCall(receipt: Receipt): { method: string | null; args: readonly string[] | null } {
  let rawCall: unknown;
  const decoded = asRecord(receipt.txDataDecoded ?? receipt.tx_data_decoded);
  rawCall = decoded?.callData ?? decoded?.call_data;
  if (rawCall === undefined) {
    const txData = receipt.txData ?? receipt.tx_data;
    if (typeof txData === "string" && /^(?:0x)?[0-9a-fA-F]+$/.test(txData)) {
      try {
        const encoded = txData.startsWith("0x") ? txData : `0x${txData}`;
        const recipient = text(receipt.recipient ?? receipt.to_address);
        if (!recipient) throw new Error("recipient unavailable");
        rawCall = (decodeInputData(encoded as `0x${string}`, recipient as `0x${string}`) as { callData?: unknown } | null)?.callData;
      } catch {
        rawCall = undefined;
      }
    }
  }
  if (rawCall === undefined) {
    const data = asRecord(receipt.data);
    const calldata = asRecord(data?.calldata);
    const readable = text(calldata?.readable);
    if (readable) {
      try { rawCall = JSON.parse(readable) as unknown; } catch { rawCall = undefined; }
    }
  }
  let method: string | null = null;
  let args: unknown;
  if (rawCall instanceof Map) {
    method = text(rawCall.get("method"));
    args = rawCall.get("args");
  } else {
    const row = asRecord(rawCall);
    method = text(row?.method);
    args = row?.args;
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return { method, args: null };
  return { method, args: args as string[] };
}

function delayedOutcome(withdrawal: WithdrawalState, nowEpoch: number, code: string): TransferDiscovery {
  return nowEpoch >= withdrawal.emittedAtEpoch + WITHDRAWAL_RECOVERY_DELAY_SECONDS
    ? { kind: "MANUAL", code: `${code}_AFTER_RECOVERY_DELAY` }
    : { kind: "PENDING", code };
}

export function lifecycleStatus(receipt: Receipt): string {
  const value = receipt.statusName ?? receipt.status_name ?? receipt.status;
  if (value === 7) return "FINALIZED";
  return (typeof value === "string" ? value : "UNKNOWN").toUpperCase();
}

function receiptHash(receipt: Receipt): string {
  return canonicalHash(receipt.hash ?? receipt.txId ?? receipt.tx_id ?? receipt.transaction_hash, "transaction hash");
}

async function rawRpc(rpcUrl: string, method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
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
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, child]) => [String(key), normalizeMaps(child)]));
  if (Array.isArray(value)) return value.map(normalizeMaps);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, normalizeMaps(child)]));
  }
  return value;
}

function canonicalHash(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (!HASH.test(normalized)) throw new Error("TRANSACTION_HASH_INVALID");
  return normalized;
}

function canonicalQuantity(value: unknown): string {
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value).toString();
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error("TRANSACTION_VALUE_UNAVAILABLE");
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredRecord(value: unknown, code: string): Record<string, unknown> {
  const row = asRecord(value);
  if (!row) throw new Error(code);
  return row;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
