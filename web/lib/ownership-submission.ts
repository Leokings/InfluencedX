import {
  getAddress,
  isAddress,
  isHash,
  sha256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import {
  normalizeOwnershipChallenge,
  normalizeXHandle,
} from "./verification-core.ts";

export const OWNERSHIP_SUBMISSION_SCHEMA_VERSION = 1 as const;
export const BRADBURY_NETWORK = "testnet-bradbury" as const;
export const BRADBURY_METHOD = "verify_ownership" as const;
export const PINNED_BRADBURY_RESOLVER =
  "0x017311b35dbB9802883bDaE7Fb0Efd7Bd77cB0b2" as const;

export const ownershipSubmissionStatuses = [
  "NOT_SUBMITTED",
  "DISPATCHING",
  "DISPATCH_UNKNOWN",
  "QUEUED",
  "PRECHECKING",
  "PRECHECK_FAILED",
  "BROADCASTING",
  "SUBMITTED",
  "POLLING",
  "FINALIZED",
  "EXECUTION_FAILED",
  "NETWORK_TERMINATED",
  "RECONCILIATION_REQUIRED",
  "POLLING_EXHAUSTED",
  "POISONED",
] as const;

export type OwnershipSubmissionStatus =
  (typeof ownershipSubmissionStatuses)[number];
export type OwnershipOutcome = "VERIFIED" | "REJECTED" | "UNDETERMINED";

export type OwnershipSubmissionEnvelope = {
  schemaVersion: typeof OWNERSHIP_SUBMISSION_SCHEMA_VERSION;
  requestId: Hex;
  baseWallet: Address;
  expectedHandle: string;
  postId: string;
  challenge: string;
  issuedAtEpoch: number;
  expiresAtEpoch: number;
  credentialExpiresAtEpoch: number;
};

export type SubmitterSubmission = {
  requestId: Hex;
  status: Exclude<OwnershipSubmissionStatus, "NOT_SUBMITTED" | "DISPATCHING" | "DISPATCH_UNKNOWN">;
  lifecycleStatus: string | null;
  executionResult: string | null;
  resultOutcome: OwnershipOutcome | null;
  txHash: Hex | null;
  queueMessageId: string | null;
  enqueueAttempts: number;
  deliveryCount: number;
  pollAttempts: number;
  errorCode: string | null;
  broadcastStartedAt: string | null;
  submittedAt: string | null;
  lastPolledAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function buildOwnershipSubmissionEnvelope(input: {
  requestId: unknown;
  baseWallet: unknown;
  expectedHandle: unknown;
  postId: unknown;
  challenge: unknown;
  issuedAtEpoch: unknown;
  expiresAtEpoch: unknown;
  credentialExpiresAtEpoch: unknown;
}): OwnershipSubmissionEnvelope {
  const envelope = {
    schemaVersion: OWNERSHIP_SUBMISSION_SCHEMA_VERSION,
    requestId: normalizeHash(input.requestId, "requestId"),
    baseWallet: normalizeAddress(input.baseWallet),
    expectedHandle: normalizeXHandle(input.expectedHandle),
    postId: normalizePostId(input.postId),
    challenge: normalizeOwnershipChallenge(input.challenge),
    issuedAtEpoch: normalizeEpoch(input.issuedAtEpoch, "issuedAtEpoch"),
    expiresAtEpoch: normalizeEpoch(input.expiresAtEpoch, "expiresAtEpoch"),
    credentialExpiresAtEpoch: normalizeEpoch(
      input.credentialExpiresAtEpoch,
      "credentialExpiresAtEpoch",
    ),
  } satisfies OwnershipSubmissionEnvelope;
  if (envelope.expiresAtEpoch <= envelope.issuedAtEpoch) {
    throw new Error("The ownership challenge window is invalid.");
  }
  if (envelope.credentialExpiresAtEpoch <= envelope.expiresAtEpoch) {
    throw new Error("The ownership credential window is invalid.");
  }
  if (ownershipSubmissionRequestId(envelope) !== envelope.requestId) {
    throw new Error("The APV2 request ID does not bind the ownership envelope.");
  }
  return Object.freeze(envelope);
}

export function ownershipSubmissionRequestId(
  envelope: Omit<OwnershipSubmissionEnvelope, "schemaVersion" | "requestId">,
): Hex {
  return sha256(
    stringToHex(
      [
        "xproof-x-ownership-v2",
        envelope.baseWallet.toLowerCase(),
        envelope.expectedHandle.toLowerCase(),
        envelope.postId,
        envelope.challenge,
        String(envelope.issuedAtEpoch),
        String(envelope.expiresAtEpoch),
        String(envelope.credentialExpiresAtEpoch),
      ].join("|"),
    ),
  );
}

export function parseSubmitterSubmission(value: unknown): SubmitterSubmission {
  if (!isPlainObject(value)) throw new Error("The submitter response is invalid.");
  const requestId = normalizeHash(value.requestId, "requestId");
  const allowed = new Set(ownershipSubmissionStatuses.slice(3));
  if (typeof value.status !== "string" || !allowed.has(value.status as never)) {
    throw new Error("The submitter status is invalid.");
  }
  const outcome = normalizeOutcome(value.resultOutcome);
  const txHash = value.txHash === null ? null : normalizeHash(value.txHash, "txHash");
  const pollAttempts = normalizeNonnegativeInteger(value.pollAttempts, "pollAttempts");
  const submission = {
    requestId,
    status: value.status,
    lifecycleStatus: normalizeNullableShortString(value.lifecycleStatus),
    executionResult: normalizeNullableShortString(value.executionResult),
    resultOutcome: outcome,
    txHash,
    queueMessageId: normalizeNullableShortString(value.queueMessageId),
    enqueueAttempts: normalizeNonnegativeInteger(value.enqueueAttempts, "enqueueAttempts"),
    deliveryCount: normalizeNonnegativeInteger(value.deliveryCount, "deliveryCount"),
    pollAttempts,
    errorCode: normalizeNullableShortString(value.errorCode),
    broadcastStartedAt: normalizeNullableIso(value.broadcastStartedAt),
    submittedAt: normalizeNullableIso(value.submittedAt),
    lastPolledAt: normalizeNullableIso(value.lastPolledAt),
    finalizedAt: normalizeNullableIso(value.finalizedAt),
    createdAt: normalizeIso(value.createdAt),
    updatedAt: normalizeIso(value.updatedAt),
  } as SubmitterSubmission;
  if (submission.status === "FINALIZED" && !submission.resultOutcome) {
    throw new Error("A finalized ownership submission has no resolver outcome.");
  }
  return Object.freeze(submission);
}

function normalizeHash(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHash(value)) {
    throw new Error(`${label} must be a 32-byte hash.`);
  }
  return value.toLowerCase() as Hex;
}

function normalizeAddress(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new Error("baseWallet must be an EVM address.");
  }
  return getAddress(value);
}

function normalizePostId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{5,24}$/.test(value)) {
    throw new Error("postId must be an X post ID.");
  }
  if (BigInt(value) > 18_446_744_073_709_551_615n) {
    throw new Error("postId is outside the supported range.");
  }
  return value;
}

function normalizeEpoch(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be an epoch-second integer.`);
  }
  return Number(value);
}

function normalizeNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a nonnegative integer.`);
  }
  return Number(value);
}

function normalizeOutcome(value: unknown): OwnershipOutcome | null {
  if (value === null) return null;
  if (value === "VERIFIED" || value === "REJECTED" || value === "UNDETERMINED") {
    return value;
  }
  throw new Error("The submitter outcome is invalid.");
}

function normalizeNullableShortString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 128) {
    throw new Error("The submitter response contains an invalid string.");
  }
  return value;
}

function normalizeIso(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("The submitter response contains an invalid timestamp.");
  }
  return value;
}

function normalizeNullableIso(value: unknown): string | null {
  return value === null ? null : normalizeIso(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
