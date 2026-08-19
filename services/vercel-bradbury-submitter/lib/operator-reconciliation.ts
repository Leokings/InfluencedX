import { assertResolverResult, project, transactionBindingError } from "./submission-service";
import { SubmitterProblem } from "./problem";
import type {
  GenLayerReader,
  ResolverOutcome,
  SubmissionProjection,
  SubmissionRecord,
} from "./types";

export const LEGACY_VALUE_OMISSION_ERROR = "TRANSACTION_VALUE_MISSING" as const;

export type ReconciliationObservation = Readonly<{
  state: "PENDING" | "FINALIZED" | "EXECUTION_FAILED" | "NETWORK_TERMINATED";
  lifecycleStatus: string;
  executionResult: string | null;
  resultOutcome: ResolverOutcome | null;
  errorCode: string | null;
  submission: SubmissionProjection;
}>;

/**
 * Read-only inspection for the one legacy quarantine caused by requiring a
 * `value` property that historical Bradbury consensus receipts did not expose.
 *
 * This function has no writer in its dependency type and cannot submit or
 * unlock the signer. The operator script applies a terminal observation only
 * through a separate, conditional database transaction.
 */
export async function inspectLegacyValueOmission(
  record: SubmissionRecord,
  reader: GenLayerReader,
): Promise<ReconciliationObservation> {
  if (
    record.status !== "RECONCILIATION_REQUIRED" ||
    record.errorCode !== LEGACY_VALUE_OMISSION_ERROR ||
    !record.txHash
  ) {
    throw new SubmitterProblem(
      409,
      "LEGACY_RECONCILIATION_NOT_APPLICABLE",
      "The submission is not the exact legacy value-omission quarantine.",
    );
  }

  const receipt = await reader.getTransaction(record.txHash);
  const bindingError = transactionBindingError(
    receipt,
    record,
    reader.signerAddress,
    reader.resolverAddress,
  );
  if (bindingError) {
    throw new SubmitterProblem(
      409,
      "RECONCILIATION_BINDING_FAILED",
      `The existing historical GenLayer transaction failed exact binding: ${bindingError}.`,
    );
  }

  const lifecycleStatus = normalizedString(receipt.statusName ?? receipt.status) ?? "UNKNOWN";
  const executionResult = normalizedString(receipt.txExecutionResultName ?? receipt.txExecutionResult);
  const base = {
    lifecycleStatus,
    executionResult,
    submission: project(record),
  } as const;

  if (lifecycleStatus === "CANCELED") {
    return Object.freeze({
      ...base,
      state: "NETWORK_TERMINATED",
      resultOutcome: null,
      errorCode: "TRANSACTION_CANCELED",
    });
  }
  if (lifecycleStatus !== "FINALIZED") {
    return Object.freeze({
      ...base,
      state: "PENDING",
      resultOutcome: null,
      errorCode: null,
    });
  }
  if (executionResult === "FINISHED_WITH_ERROR") {
    return Object.freeze({
      ...base,
      state: "EXECUTION_FAILED",
      resultOutcome: null,
      errorCode: "GENLAYER_EXECUTION_FAILED",
    });
  }
  if (executionResult !== "FINISHED_WITH_RETURN") {
    throw new SubmitterProblem(
      409,
      "RECONCILIATION_EXECUTION_RESULT_UNKNOWN",
      "The finalized transaction has no recognized execution result; no durable state was changed.",
    );
  }

  const resultOutcome = assertResolverResult(
    await reader.readFinalResult(record.requestId),
    record.requestId,
  );
  return Object.freeze({
    ...base,
    state: "FINALIZED",
    resultOutcome,
    errorCode: null,
  });
}

function normalizedString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
