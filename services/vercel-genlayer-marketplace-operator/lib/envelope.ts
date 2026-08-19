import { createHash } from "node:crypto";

import type { OperatorConfig } from "./config";
import {
  EXPIRE_ASSIGNMENT,
  FINALIZE_CAMPAIGN,
  OPERATOR_NETWORK,
  OPERATOR_SCHEMA_VERSION,
  RESOLVE_ASSIGNMENT,
  STUDIONET_CHAIN_ID,
  ZERO_VALUE_ATTO,
} from "./constants";
import { OperatorProblem, PoisonMessageError } from "./problem";
import type { OperationEnvelope, OperationRequest, QueueMessage, StateSnapshot } from "./types";

const HASH = /^0x[0-9a-f]{64}$/;

export function validateOperationRequest(raw: unknown, config: OperatorConfig): OperationEnvelope {
  const value = object(raw, "The operation request must be an object.");
  if (value.schemaVersion !== OPERATOR_SCHEMA_VERSION) invalid("The operation schema version is invalid.");
  const action = value.action;
  let request: OperationRequest;
  if (action === RESOLVE_ASSIGNMENT) {
    exactKeys(value, ["schemaVersion", "action", "assignmentId", "requestId"]);
    request = Object.freeze({
      schemaVersion: OPERATOR_SCHEMA_VERSION,
      action,
      assignmentId: canonicalHash(value.assignmentId, "assignmentId"),
      requestId: canonicalHash(value.requestId, "requestId"),
    });
  } else if (action === EXPIRE_ASSIGNMENT) {
    exactKeys(value, ["schemaVersion", "action", "assignmentId"]);
    request = Object.freeze({
      schemaVersion: OPERATOR_SCHEMA_VERSION,
      action,
      assignmentId: canonicalHash(value.assignmentId, "assignmentId"),
    });
  } else if (action === FINALIZE_CAMPAIGN) {
    exactKeys(value, ["schemaVersion", "action", "campaignId"]);
    request = Object.freeze({
      schemaVersion: OPERATOR_SCHEMA_VERSION,
      action,
      campaignId: canonicalHash(value.campaignId, "campaignId"),
    });
  } else {
    invalid("The operation action is not allowlisted.");
  }

  const args = request.action === RESOLVE_ASSIGNMENT
    ? [request.assignmentId, request.requestId]
    : request.action === EXPIRE_ASSIGNMENT
      ? [request.assignmentId]
      : [request.campaignId];
  const binding = {
    domain: "influencedx-genlayer-marketplace-operation-v1",
    network: OPERATOR_NETWORK,
    chainId: STUDIONET_CHAIN_ID,
    contractAddress: config.contractAddress,
    action: request.action,
    args,
    valueAtto: ZERO_VALUE_ATTO,
  };
  return Object.freeze({
    schemaVersion: OPERATOR_SCHEMA_VERSION,
    operationId: fingerprint(binding),
    network: OPERATOR_NETWORK,
    chainId: STUDIONET_CHAIN_ID,
    contractAddress: config.contractAddress,
    action: request.action,
    args: Object.freeze(args),
    valueAtto: ZERO_VALUE_ATTO,
  });
}

export function validateQueueMessage(raw: unknown): QueueMessage {
  try {
    const value = object(raw, "The queue message must be an object.");
    exactKeys(value, ["schemaVersion", "operationId"]);
    if (value.schemaVersion !== OPERATOR_SCHEMA_VERSION) throw new Error("schema");
    return Object.freeze({
      schemaVersion: OPERATOR_SCHEMA_VERSION,
      operationId: canonicalHash(value.operationId, "operationId"),
    });
  } catch {
    throw new PoisonMessageError("QUEUE_MESSAGE_INVALID", "The marketplace queue message is invalid.");
  }
}

export function validateOperationId(raw: unknown): string {
  return canonicalHash(raw, "operationId");
}

export function envelopeFingerprint(envelope: OperationEnvelope): string {
  return fingerprint(envelope);
}

export function callFingerprint(envelope: OperationEnvelope): string {
  return fingerprint({
    network: envelope.network,
    chainId: envelope.chainId,
    contractAddress: envelope.contractAddress,
    functionName: envelope.action,
    args: envelope.args,
    valueAtto: envelope.valueAtto,
  });
}

export function stateFingerprint(state: StateSnapshot): string {
  return fingerprint(state);
}

export function assertEnvelopeIntegrity(envelope: OperationEnvelope): void {
  if (
    envelope.schemaVersion !== OPERATOR_SCHEMA_VERSION ||
    envelope.network !== OPERATOR_NETWORK ||
    envelope.chainId !== STUDIONET_CHAIN_ID ||
    envelope.valueAtto !== ZERO_VALUE_ATTO ||
    !/^0x[0-9a-f]{40}$/.test(envelope.contractAddress)
  ) throw new Error("Envelope boundary mismatch.");
  const allowedLength = envelope.action === RESOLVE_ASSIGNMENT ? 2 : 1;
  if (
    ![RESOLVE_ASSIGNMENT, EXPIRE_ASSIGNMENT, FINALIZE_CAMPAIGN].includes(envelope.action) ||
    envelope.args.length !== allowedLength ||
    envelope.args.some((arg) => !HASH.test(arg))
  ) throw new Error("Envelope call is not canonical.");
  const expected = fingerprint({
    domain: "influencedx-genlayer-marketplace-operation-v1",
    network: envelope.network,
    chainId: envelope.chainId,
    contractAddress: envelope.contractAddress,
    action: envelope.action,
    args: envelope.args,
    valueAtto: envelope.valueAtto,
  });
  if (expected !== envelope.operationId) throw new Error("Envelope operation ID mismatch.");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function fingerprint(value: unknown): string {
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
    invalid("The operation request contains missing or unsupported fields.");
  }
}

function canonicalHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) invalid(`${label} must be a lowercase 32-byte hash.`);
  return value as string;
}

function invalid(message: string): never {
  throw new OperatorProblem(400, "OPERATION_INVALID", message);
}
