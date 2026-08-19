import { isHash, type Hex } from "viem";
import {
  BRADBURY_NETWORK,
  PINNED_BRADBURY_RESOLVER,
  ownershipSubmissionStatuses,
  requireStudioNetwork,
  requireStudioResolver,
  type OwnershipSubmissionStatus,
} from "./ownership-submission.ts";

export const CAMPAIGN_SUBMISSION_SCHEMA_VERSION = 1 as const;
export const CAMPAIGN_SUBMISSION_KIND = "CAMPAIGN" as const;
export const CAMPAIGN_BRADBURY_METHOD = "resolve_submission" as const;

export type CampaignResolutionOutcome = "PASS" | "FAIL" | "UNDETERMINED";

export type CampaignSubmissionEnvelope = Readonly<{
  schemaVersion: typeof CAMPAIGN_SUBMISSION_SCHEMA_VERSION;
  kind: typeof CAMPAIGN_SUBMISSION_KIND;
  requestId: Hex;
  expectedHandle: string;
  postId: string;
  requiredPhrasesJson: string;
  forbiddenPhrasesJson: string;
  requireAdDisclosure: boolean;
  semanticBrief: string;
  resolveNotBeforeEpoch: number;
  assignmentId: number;
  agreementHash: Hex;
  submissionHash: Hex;
}>;

export type CampaignSubmitterSubmission = Readonly<{
  requestId: Hex;
  network: typeof BRADBURY_NETWORK;
  resolver: typeof PINNED_BRADBURY_RESOLVER;
  functionName: typeof CAMPAIGN_BRADBURY_METHOD;
  status: Exclude<
    OwnershipSubmissionStatus,
    "NOT_SUBMITTED" | "DISPATCHING" | "DISPATCH_UNKNOWN"
  >;
  lifecycleStatus: string | null;
  executionResult: string | null;
  resultOutcome: CampaignResolutionOutcome | null;
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
}>;

export function buildCampaignSubmissionEnvelope(input: {
  requestId: unknown;
  expectedHandle: unknown;
  postId: unknown;
  requiredPhrases: unknown;
  forbiddenPhrases: unknown;
  requireAdDisclosure: unknown;
  semanticBrief: unknown;
  resolveNotBeforeEpoch: unknown;
  assignmentId: unknown;
  agreementHash: unknown;
  submissionHash: unknown;
  nowEpoch?: number;
}): CampaignSubmissionEnvelope {
  const resolveNotBeforeEpoch = positiveSafeInteger(
    input.resolveNotBeforeEpoch,
    "resolveNotBeforeEpoch",
  );
  const nowEpoch = positiveSafeInteger(
    input.nowEpoch ?? Math.floor(Date.now() / 1_000),
    "nowEpoch",
  );
  if (resolveNotBeforeEpoch > nowEpoch) {
    throw new Error("Campaign retention has not ended yet.");
  }
  if (typeof input.requireAdDisclosure !== "boolean") {
    throw new Error("requireAdDisclosure must be boolean.");
  }
  const semanticBrief = canonicalSemanticBrief(input.semanticBrief);
  return Object.freeze({
    schemaVersion: CAMPAIGN_SUBMISSION_SCHEMA_VERSION,
    kind: CAMPAIGN_SUBMISSION_KIND,
    requestId: bytes32(input.requestId, "requestId"),
    expectedHandle: canonicalHandle(input.expectedHandle),
    postId: postId(input.postId),
    requiredPhrasesJson: canonicalPhrasesJson(input.requiredPhrases, "requiredPhrases"),
    forbiddenPhrasesJson: canonicalPhrasesJson(input.forbiddenPhrases, "forbiddenPhrases"),
    requireAdDisclosure: input.requireAdDisclosure,
    semanticBrief,
    resolveNotBeforeEpoch,
    assignmentId: positiveSafeInteger(input.assignmentId, "assignmentId"),
    agreementHash: bytes32(input.agreementHash, "agreementHash"),
    submissionHash: bytes32(input.submissionHash, "submissionHash"),
  });
}

export function parseCampaignSubmitterSubmission(
  value: unknown,
): CampaignSubmitterSubmission {
  if (!plainObject(value)) throw new Error("The campaign submitter response is invalid.");
  if (value.functionName !== CAMPAIGN_BRADBURY_METHOD) {
    throw new Error("The campaign submitter method is invalid.");
  }
  const allowedStatuses = new Set(ownershipSubmissionStatuses.slice(3));
  if (
    typeof value.status !== "string" ||
    !allowedStatuses.has(value.status as never)
  ) {
    throw new Error("The campaign submitter status is invalid.");
  }
  const resultOutcome = campaignOutcome(value.resultOutcome);
  if (value.status === "FINALIZED" && resultOutcome === null) {
    throw new Error("A finalized campaign submission has no resolver outcome.");
  }
  return Object.freeze({
    requestId: bytes32(value.requestId, "requestId"),
    network: requireStudioNetwork(value.network),
    resolver: requireStudioResolver(value.resolver),
    functionName: CAMPAIGN_BRADBURY_METHOD,
    status: value.status as CampaignSubmitterSubmission["status"],
    lifecycleStatus: nullableShortString(value.lifecycleStatus),
    executionResult: nullableShortString(value.executionResult),
    resultOutcome,
    txHash: value.txHash === null ? null : bytes32(value.txHash, "txHash"),
    queueMessageId: nullableShortString(value.queueMessageId),
    enqueueAttempts: nonnegativeSafeInteger(value.enqueueAttempts, "enqueueAttempts"),
    deliveryCount: nonnegativeSafeInteger(value.deliveryCount, "deliveryCount"),
    pollAttempts: nonnegativeSafeInteger(value.pollAttempts, "pollAttempts"),
    errorCode: nullableShortString(value.errorCode),
    broadcastStartedAt: nullableIso(value.broadcastStartedAt),
    submittedAt: nullableIso(value.submittedAt),
    lastPolledAt: nullableIso(value.lastPolledAt),
    finalizedAt: nullableIso(value.finalizedAt),
    createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt),
  });
}

function bytes32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHash(value)) {
    throw new Error(`${label} must be a 32-byte hash.`);
  }
  return value.toLowerCase() as Hex;
}

function canonicalHandle(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_]{1,15}$/.test(value)) {
    throw new Error("expectedHandle must be a canonical X handle.");
  }
  return value;
}

function postId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{5,24}$/.test(value)) {
    throw new Error("postId must be an X post ID.");
  }
  if (BigInt(value) > 18_446_744_073_709_551_615n) {
    throw new Error("postId is outside the supported range.");
  }
  return value;
}

function canonicalPhrasesJson(value: unknown, label: string): string {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error(`${label} must be an array with at most 20 phrases.`);
  }
  const phrases = value.map((item) => {
    if (typeof item !== "string") throw new Error(`${label} entries must be strings.`);
    const phrase = item.trim();
    if (phrase.length === 0 || phrase.length > 160 || item !== phrase) {
      throw new Error(`${label} entries must be canonical 1-160 character strings.`);
    }
    return phrase;
  });
  return JSON.stringify(phrases);
}

function canonicalSemanticBrief(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 2_000 ||
    value !== value.trim()
  ) {
    throw new Error("semanticBrief must be a canonical string of at most 2000 characters.");
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  const normalized = typeof value === "string" && /^[1-9][0-9]*$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(normalized) || Number(normalized) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return Number(normalized);
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a nonnegative safe integer.`);
  }
  return Number(value);
}

function campaignOutcome(value: unknown): CampaignResolutionOutcome | null {
  if (value === null) return null;
  if (value === "PASS" || value === "FAIL" || value === "UNDETERMINED") {
    return value;
  }
  throw new Error("The campaign submitter outcome is invalid.");
}

function nullableShortString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 128) {
    throw new Error("The campaign submitter response contains an invalid string.");
  }
  return value;
}

function iso(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("The campaign submitter response contains an invalid timestamp.");
  }
  return value;
}

function nullableIso(value: unknown): string | null {
  return value === null ? null : iso(value);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
