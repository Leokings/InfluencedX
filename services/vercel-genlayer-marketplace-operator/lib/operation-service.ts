import { randomUUID } from "node:crypto";

import { decodeInputData } from "genlayer-js";

import {
  MAX_POLL_ATTEMPTS,
  OPERATOR_NETWORK,
  PRECHECK_LEASE_MS,
  STUDIONET_CHAIN_ID,
  TERMINAL_STATUSES,
  ZERO_VALUE_ATTO,
} from "./constants";
import {
  assertEnvelopeIntegrity,
  callFingerprint,
  canonicalJson,
  envelopeFingerprint,
  stateFingerprint,
} from "./envelope";
import { GateBusyError, OperatorProblem, PoisonMessageError } from "./problem";
import type { QueuePublisher } from "./queue-publisher";
import { assertPostState, assertPreState } from "./state";
import type {
  MarketplaceClient,
  OperationEnvelope,
  OperationProjection,
  OperationRecord,
  OperatorRepository,
  QueueMessage,
  Receipt,
} from "./types";

const TX_HASH = /^0x[0-9a-f]{64}$/;

export class OperationService {
  constructor(
    private readonly repository: OperatorRepository,
    private readonly client: MarketplaceClient,
    private readonly queue: QueuePublisher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async process(message: QueueMessage, deliveryCount: number): Promise<void> {
    await this.repository.noteDelivery(message.operationId, deliveryCount);
    const record = await this.repository.get(message.operationId);
    if (!record) {
      throw new PoisonMessageError(
        "OPERATION_NOT_FOUND",
        "The queue message has no durable marketplace operation.",
        message.operationId,
      );
    }
    const boundaryError = recordBoundaryError(record, this.client.contractAddress);
    if (boundaryError) {
      await this.repository.markPoisoned(record.operationId, boundaryError);
      throw new PoisonMessageError(boundaryError, "The durable operation crossed its security boundary.", record.operationId);
    }
    if (TERMINAL_STATUSES.has(record.status)) return;
    if (record.status === "BROADCASTING") {
      await this.repository.quarantineAmbiguousBroadcast(
        record.operationId,
        "CRASH_DURING_BROADCAST_REQUIRES_RECONCILIATION",
      );
      return;
    }
    if (record.status === "SUBMITTED" || record.status === "POLLING") {
      await this.poll(record);
      return;
    }
    if (!["QUEUED", "PRECHECKING", "PRECHECK_FAILED"].includes(record.status)) return;
    await this.submit(record);
  }

  private async submit(record: OperationRecord): Promise<void> {
    const envelope = record.envelope;
    if (!envelope) {
      await this.repository.markPoisoned(record.operationId, "OPERATION_ENVELOPE_MISSING");
      throw new PoisonMessageError("OPERATION_ENVELOPE_MISSING", "The exact call envelope is missing.", record.operationId);
    }
    try {
      assertEnvelopeIntegrity(envelope);
    } catch {
      await this.repository.markPoisoned(record.operationId, "OPERATION_ENVELOPE_INVALID");
      throw new PoisonMessageError("OPERATION_ENVELOPE_INVALID", "The exact call envelope is invalid.", record.operationId);
    }
    if (
      envelopeFingerprint(envelope) !== record.envelopeFingerprint ||
      callFingerprint(envelope) !== record.callFingerprint
    ) {
      await this.repository.markPoisoned(record.operationId, "OPERATION_ENVELOPE_INTEGRITY_MISMATCH");
      throw new PoisonMessageError(
        "OPERATION_ENVELOPE_INTEGRITY_MISMATCH",
        "The exact call envelope no longer matches its accepted fingerprints.",
        record.operationId,
      );
    }
    const claim = await this.repository.claimPrecheck(record.operationId, randomUUID(), PRECHECK_LEASE_MS);
    if (!claim) throw new GateBusyError();

    let preState;
    try {
      preState = await this.client.readState(envelope, false);
      assertPreState(envelope, preState, Math.floor(this.now().getTime() / 1_000));
      await this.repository.recordPreState(claim, preState, stateFingerprint(preState));
    } catch (error) {
      const code = sanitizedCode(error, "MARKETPLACE_PRECHECK_FAILED");
      await this.repository.failPrecheck(claim, code);
      if (code === "STUDIONET_RPC_UNAVAILABLE" || code === "STUDIONET_RPC_INVALID") {
        throw new OperatorProblem(503, code, "StudioNet could not be checked safely; nothing was signed.");
      }
      return;
    }

    if (!(await this.repository.beginBroadcast(claim))) throw new GateBusyError();
    let txHash: string;
    try {
      txHash = await this.client.submit(envelope);
    } catch {
      await this.repository.quarantineBroadcast(claim, "BROADCAST_OUTCOME_UNKNOWN");
      return;
    }
    if (!TX_HASH.test(txHash)) {
      await this.repository.quarantineBroadcast(claim, "TRANSACTION_HASH_INVALID");
      return;
    }
    await this.repository.recordSubmitted(claim, txHash);
    await this.queue.poll(record.operationId, 0);
  }

  private async poll(record: OperationRecord): Promise<void> {
    if (!record.txHash || !record.preState || !record.preStateFingerprint) {
      await this.repository.recordPoll(record.operationId, {
        status: "RECONCILIATION_REQUIRED",
        errorCode: "POLL_BINDING_MISSING",
      });
      return;
    }
    if (stateFingerprint(record.preState) !== record.preStateFingerprint) {
      await this.repository.recordPoll(record.operationId, {
        status: "RECONCILIATION_REQUIRED",
        errorCode: "PRE_STATE_INTEGRITY_MISMATCH",
      });
      return;
    }
    const attempt = record.pollAttempts + 1;
    if (attempt > MAX_POLL_ATTEMPTS) {
      await this.repository.recordPoll(record.operationId, {
        status: "POLLING_EXHAUSTED",
        pollAttempts: attempt,
        errorCode: "POLLING_ATTEMPTS_EXHAUSTED",
      });
      return;
    }

    let receipt: Receipt;
    try {
      receipt = await this.client.getTransaction(record.txHash);
    } catch {
      await this.repository.recordPoll(record.operationId, {
        pollAttempts: attempt,
        lastPolledAt: this.now(),
        errorCode: "STUDIONET_POLL_UNAVAILABLE",
      });
      throw new OperatorProblem(503, "STUDIONET_POLL_UNAVAILABLE", "StudioNet transaction polling is temporarily unavailable.");
    }
    const bindingError = transactionBindingError(receipt, record, this.client.signerAddress);
    if (bindingError) {
      await this.repository.recordPoll(record.operationId, {
        status: "RECONCILIATION_REQUIRED",
        pollAttempts: attempt,
        lastPolledAt: this.now(),
        errorCode: bindingError,
      });
      return;
    }
    const lifecycleStatus = (text(receipt.statusName ?? receipt.status_name ?? receipt.status) ?? "UNKNOWN").toUpperCase();
    const nestedExecutionResult = finalizedExecutionResult(receipt);
    const declaredExecutionResult = text(
      receipt.txExecutionResultName ??
      receipt.tx_execution_result_name ??
      receipt.txExecutionResult ??
      receipt.tx_execution_result,
    );
    const executionResult = nestedExecutionResult === "FINISHED_WITH_RETURN"
      ? "FINISHED_WITH_RETURN"
      : declaredExecutionResult;
    if (["CANCELED", "VALIDATORS_TIMEOUT", "LEADER_TIMEOUT"].includes(lifecycleStatus)) {
      await this.repository.recordPoll(record.operationId, {
        status: "NETWORK_TERMINATED",
        lifecycleStatus,
        executionResult,
        pollAttempts: attempt,
        lastPolledAt: this.now(),
        errorCode: "TRANSACTION_TERMINATED",
      });
      return;
    }
    if (lifecycleStatus === "FINALIZED") {
      if (
        nestedExecutionResult !== "FINISHED_WITH_RETURN" ||
        (declaredExecutionResult !== null && declaredExecutionResult !== "FINISHED_WITH_RETURN")
      ) {
        await this.repository.recordPoll(record.operationId, {
          status: "EXECUTION_FAILED",
          lifecycleStatus,
          executionResult,
          pollAttempts: attempt,
          lastPolledAt: this.now(),
          finalizedAt: this.now(),
          errorCode: nestedExecutionResult === null
            ? "GENLAYER_NESTED_EXECUTION_MISSING"
            : "GENLAYER_EXECUTION_FAILED",
        });
        return;
      }
      try {
        const envelope = record.envelope;
        if (!envelope) throw new Error("OPERATION_ENVELOPE_MISSING");
        const finalState = await this.client.readState(envelope, true);
        assertPostState(envelope, record.preState, finalState);
        await this.repository.recordPoll(record.operationId, {
          status: "FINALIZED",
          lifecycleStatus,
          executionResult,
          postStateFingerprint: stateFingerprint(finalState),
          pollAttempts: attempt,
          lastPolledAt: this.now(),
          finalizedAt: this.now(),
          errorCode: null,
        });
      } catch (error) {
        await this.repository.recordPoll(record.operationId, {
          status: "RECONCILIATION_REQUIRED",
          lifecycleStatus,
          executionResult,
          pollAttempts: attempt,
          lastPolledAt: this.now(),
          errorCode: sanitizedCode(error, "FINAL_STATE_MISMATCH"),
        });
      }
      return;
    }
    await this.repository.recordPoll(record.operationId, {
      status: "POLLING",
      lifecycleStatus,
      executionResult,
      pollAttempts: attempt,
      lastPolledAt: this.now(),
      errorCode: null,
    });
    await this.queue.poll(record.operationId, attempt);
  }
}

export function transactionBindingError(
  receipt: Receipt,
  record: Pick<OperationRecord, "txHash" | "contractAddress" | "functionName" | "callFingerprint" | "envelope">,
  signerAddress: string,
): string | null {
  const hash = text(receipt.hash ?? receipt.txId ?? receipt.transaction_hash);
  if (!hash) return "TRANSACTION_HASH_MISSING";
  if (!record.txHash || hash.toLowerCase() !== record.txHash.toLowerCase()) return "TRANSACTION_HASH_MISMATCH";
  const sender = text(receipt.sender ?? receipt.from_address);
  if (!sender) return "TRANSACTION_SENDER_MISSING";
  if (sender.toLowerCase() !== signerAddress.toLowerCase()) return "TRANSACTION_SENDER_MISMATCH";
  const recipient = text(receipt.recipient ?? receipt.toAddress ?? receipt.to_address);
  if (!recipient) return "TRANSACTION_CONTRACT_MISSING";
  if (recipient.toLowerCase() !== record.contractAddress.toLowerCase()) return "TRANSACTION_CONTRACT_MISMATCH";
  if (receipt.rawValueAtto !== "0") return "TRANSACTION_VALUE_MISMATCH";
  const decoded = decodedCall(receipt, record.contractAddress);
  if (!decoded.method) return "TRANSACTION_METHOD_MISSING";
  if (decoded.method !== record.functionName) return "TRANSACTION_METHOD_MISMATCH";
  if (!decoded.args) return "TRANSACTION_ARGUMENTS_MISSING";
  if (!record.envelope) return "TRANSACTION_ENVELOPE_MISSING";
  if (canonicalJson(decoded.args) !== canonicalJson(record.envelope.args)) return "TRANSACTION_ARGUMENTS_MISMATCH";
  if (callFingerprint(record.envelope) !== record.callFingerprint) return "TRANSACTION_CALL_FINGERPRINT_MISMATCH";
  return null;
}

export function project(record: OperationRecord): OperationProjection {
  const {
    envelope: _envelope,
    envelopeFingerprint: _envelopeFingerprint,
    callFingerprint: _callFingerprint,
    preState: _preState,
    ...projection
  } = record;
  return Object.freeze(projection);
}

function recordBoundaryError(record: OperationRecord, expectedContract: string): string | null {
  if (record.network !== OPERATOR_NETWORK || record.chainId !== STUDIONET_CHAIN_ID) return "OPERATION_NETWORK_BINDING_MISMATCH";
  if (record.contractAddress !== expectedContract.toLowerCase()) return "OPERATION_CONTRACT_BINDING_MISMATCH";
  if (record.action !== record.functionName) return "OPERATION_METHOD_BINDING_MISMATCH";
  if (record.valueAtto !== ZERO_VALUE_ATTO) return "OPERATION_VALUE_BINDING_MISMATCH";
  return null;
}

function decodedCall(
  receipt: Receipt,
  recipient: string,
): { method: string | null; args: readonly unknown[] | null } {
  const decoded = asRecord(receipt.txDataDecoded ?? receipt.tx_data_decoded);
  let rawCall: unknown = decoded?.callData ?? decoded?.call_data;
  if (rawCall === undefined) {
    const data = asRecord(receipt.data);
    const calldata = asRecord(data?.calldata);
    const readable = calldata?.readable ?? data?.calldata;
    if (typeof readable === "string" && readable.trim()) {
      try {
        rawCall = JSON.parse(readable) as unknown;
      } catch {
        rawCall = undefined;
      }
    }
  }
  if (rawCall === undefined) {
    const txData = receipt.txData ?? receipt.tx_data;
    if (
      typeof txData === "string" &&
      /^(?:0x)?[0-9a-fA-F]+$/.test(txData) &&
      (txData.startsWith("0x") ? txData.length - 2 : txData.length) % 2 === 0
    ) {
      try {
        const encoded = txData.startsWith("0x") ? txData : `0x${txData}`;
        const decodedInput = decodeInputData(
          encoded as `0x${string}`,
          recipient as `0x${string}`,
        ) as { callData?: unknown } | null;
        rawCall = decodedInput?.callData;
      } catch {
        rawCall = undefined;
      }
    }
  }
  let method: string | null;
  let args: unknown;
  if (rawCall instanceof Map) {
    method = text(rawCall.get("method"));
    args = rawCall.get("args");
  } else {
    const call = asRecord(rawCall);
    method = text(call?.method);
    args = call?.args;
  }
  return { method, args: Array.isArray(args) ? args : null };
}

function finalizedExecutionResult(receipt: Receipt): "FINISHED_WITH_RETURN" | "FAILED" | null {
  const consensusResult = text(receipt.result_name ?? receipt.resultName);
  if (consensusResult === null) return null;
  if (consensusResult !== "MAJORITY_AGREE") return "FAILED";
  const consensus = asRecord(receipt.consensus_data);
  const leaderReceipts = consensus?.leader_receipt;
  if (!Array.isArray(leaderReceipts) || leaderReceipts.length === 0) return null;
  const leaders = leaderReceipts
    .map(asRecord)
    .filter((candidate): candidate is Record<string, unknown> => candidate?.mode === "leader");
  if (leaders.length !== 1) return "FAILED";
  const leader = leaders[0];
  const result = asRecord(leader?.result);
  if (!leader || !result) return null;
  return leader.execution_result === "SUCCESS" && result.status === "return"
    ? "FINISHED_WITH_RETURN"
    : "FAILED";
}

function sanitizedCode(error: unknown, fallback: string): string {
  const candidate = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{2,100}$/.test(candidate) ? candidate : fallback;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
