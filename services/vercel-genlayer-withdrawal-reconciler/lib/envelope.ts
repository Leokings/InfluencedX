import { createHash } from "node:crypto";

import type { ReconcilerConfig } from "./config";
import {
  RECONCILER_NETWORK,
  RECONCILER_SCHEMA_VERSION,
  STUDIONET_CHAIN_ID,
} from "./constants";
import { PoisonMessageError, ReconcilerProblem } from "./problem";
import type { QueueMessage, ReconciliationRequest } from "./types";

const HASH = /^0x[0-9a-f]{64}$/;

export function validateReconciliationRequest(raw: unknown, _config: ReconcilerConfig): ReconciliationRequest {
  const value = object(raw, "The reconciliation request must be an object.");
  exactKeys(value, ["schemaVersion", "withdrawalId"]);
  if (value.schemaVersion !== RECONCILER_SCHEMA_VERSION) invalid("The reconciliation schema version is invalid.");
  return Object.freeze({
    schemaVersion: RECONCILER_SCHEMA_VERSION,
    withdrawalId: canonicalHash(value.withdrawalId, "withdrawalId"),
  });
}

export function validateQueueMessage(raw: unknown): QueueMessage {
  try {
    const value = object(raw, "The queue message must be an object.");
    exactKeys(value, ["schemaVersion", "withdrawalId"]);
    if (value.schemaVersion !== RECONCILER_SCHEMA_VERSION) throw new Error("schema");
    return Object.freeze({
      schemaVersion: RECONCILER_SCHEMA_VERSION,
      withdrawalId: canonicalHash(value.withdrawalId, "withdrawalId"),
    });
  } catch {
    throw new PoisonMessageError("QUEUE_MESSAGE_INVALID", "The withdrawal queue message is invalid.");
  }
}

export function validateWithdrawalId(raw: unknown): string {
  return canonicalHash(raw, "withdrawalId");
}

export function requestFingerprint(request: ReconciliationRequest, config: ReconcilerConfig): string {
  return fingerprint({
    domain: "influencedx-withdrawal-reconciliation-request-v1",
    network: RECONCILER_NETWORK,
    chainId: STUDIONET_CHAIN_ID,
    contractAddress: config.contractAddress,
    withdrawalConfirmer: config.contractWithdrawalConfirmer,
    withdrawalId: request.withdrawalId,
  });
}

export function proofFingerprint(value: unknown): string {
  return fingerprint(value);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function fingerprint(value: unknown): string {
  return `0x${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
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

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(message);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid("The reconciliation request contains missing or unsupported fields.");
  }
}

function canonicalHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) invalid(`${label} must be a lowercase 32-byte hash.`);
  return value as string;
}

function invalid(message: string): never {
  throw new ReconcilerProblem(400, "RECONCILIATION_REQUEST_INVALID", message);
}
