import { createHash } from "node:crypto";

import {
  CAMPAIGN_SUBMITTER_METHOD,
  MAX_METRICS_SECONDS,
  MAX_CHALLENGE_SECONDS,
  MAX_CREDENTIAL_SECONDS,
  MIN_CHALLENGE_SECONDS,
  MIN_CREDENTIAL_SECONDS,
  SUBMITTER_SCHEMA_VERSION,
  SUBMITTER_METHOD,
  METRICS_SUBMITTER_METHOD,
  X_EPOCH_MS,
} from "./constants";
import { PoisonMessageError, SubmitterProblem } from "./problem";
import type {
  CampaignEnvelope,
  MetricsEnvelope,
  OwnershipEnvelope,
  QueueMessage,
  SubmissionEnvelope,
  SubmitterFunctionName,
} from "./types";

const ENVELOPE_KEYS = Object.freeze([
  "baseWallet",
  "challenge",
  "credentialExpiresAtEpoch",
  "expectedHandle",
  "expiresAtEpoch",
  "issuedAtEpoch",
  "postId",
  "requestId",
  "schemaVersion",
]);
const QUEUE_KEYS = Object.freeze(["requestId", "schemaVersion"]);
const CAMPAIGN_ENVELOPE_KEYS = Object.freeze([
  "agreementHash",
  "assignmentId",
  "expectedHandle",
  "forbiddenPhrasesJson",
  "kind",
  "postId",
  "requestId",
  "requireAdDisclosure",
  "requiredPhrasesJson",
  "resolveNotBeforeEpoch",
  "schemaVersion",
  "semanticBrief",
  "submissionHash",
]);
const METRICS_ENVELOPE_KEYS = Object.freeze([
  "baseWallet",
  "expectedHandle",
  "identityHash",
  "kind",
  "metricsExpiresAtEpoch",
  "requestId",
  "schemaVersion",
]);
const REQUEST_ID = /^0x[0-9a-fA-F]{64}$/;

export async function validateOwnershipEnvelope(
  value: unknown,
  { nowEpoch = Math.floor(Date.now() / 1_000) }: { nowEpoch?: number } = {},
): Promise<OwnershipEnvelope> {
  if (!isPlainObject(value) || !hasExactKeys(value, ENVELOPE_KEYS)) {
    throw invalid("The submission body contains missing or unsupported fields.");
  }
  if (value.schemaVersion !== SUBMITTER_SCHEMA_VERSION) {
    throw invalid(`schemaVersion must be ${SUBMITTER_SCHEMA_VERSION}.`);
  }

  const requestId = normalizeHash(value.requestId, "requestId");
  const baseWallet = normalizeAddress(value.baseWallet);
  const expectedHandle = normalizeHandle(value.expectedHandle);
  const postId = normalizePostId(value.postId);
  const challenge = normalizeChallenge(value.challenge);
  const issuedAtEpoch = safeEpoch(value.issuedAtEpoch, "issuedAtEpoch");
  const expiresAtEpoch = safeEpoch(value.expiresAtEpoch, "expiresAtEpoch");
  const credentialExpiresAtEpoch = safeEpoch(value.credentialExpiresAtEpoch, "credentialExpiresAtEpoch");
  const now = safeEpoch(nowEpoch, "current time");

  if (issuedAtEpoch > now) throw invalid("The challenge issue time is in the future.");
  if (expiresAtEpoch < now) throw invalid("The ownership challenge has expired.");
  const challengeSeconds = expiresAtEpoch - issuedAtEpoch;
  if (challengeSeconds < MIN_CHALLENGE_SECONDS || challengeSeconds > MAX_CHALLENGE_SECONDS) {
    throw invalid("The challenge window must be between 5 and 60 minutes.");
  }
  const credentialSeconds = credentialExpiresAtEpoch - issuedAtEpoch;
  if (credentialExpiresAtEpoch <= now) throw invalid("The ownership credential has expired.");
  if (credentialSeconds < MIN_CREDENTIAL_SECONDS || credentialSeconds > MAX_CREDENTIAL_SECONDS) {
    throw invalid("The credential lifetime must be between 24 hours and 90 days.");
  }
  const publishedAtEpoch = postEpoch(postId);
  if (publishedAtEpoch < issuedAtEpoch || publishedAtEpoch > expiresAtEpoch) {
    throw invalid("The X post timestamp is outside the challenge window.");
  }

  const envelope = Object.freeze({
    schemaVersion: SUBMITTER_SCHEMA_VERSION,
    requestId,
    baseWallet,
    expectedHandle,
    postId,
    challenge,
    issuedAtEpoch,
    expiresAtEpoch,
    credentialExpiresAtEpoch,
  });
  if (ownershipRequestId(envelope) !== requestId) {
    throw invalid("requestId does not match the APV2 ownership envelope.");
  }
  return envelope;
}

export async function validateCampaignEnvelope(
  value: unknown,
  { nowEpoch = Math.floor(Date.now() / 1_000) }: { nowEpoch?: number } = {},
): Promise<CampaignEnvelope> {
  if (!isPlainObject(value) || !hasExactKeys(value, CAMPAIGN_ENVELOPE_KEYS)) {
    throw invalidCampaign("The campaign submission contains missing or unsupported fields.");
  }
  if (value.schemaVersion !== SUBMITTER_SCHEMA_VERSION || value.kind !== "CAMPAIGN") {
    throw invalidCampaign(`Campaign schemaVersion must be ${SUBMITTER_SCHEMA_VERSION}.`);
  }
  const requestId = normalizeCampaignHash(value.requestId, "requestId");
  const expectedHandle = normalizeCanonicalHandle(value.expectedHandle);
  const postId = normalizeCampaignPostId(value.postId);
  const requiredPhrasesJson = normalizePhrasesJson(value.requiredPhrasesJson, "requiredPhrasesJson");
  const forbiddenPhrasesJson = normalizePhrasesJson(value.forbiddenPhrasesJson, "forbiddenPhrasesJson");
  if (typeof value.requireAdDisclosure !== "boolean") {
    throw invalidCampaign("requireAdDisclosure must be boolean.");
  }
  const semanticBrief = normalizeSemanticBrief(value.semanticBrief);
  const resolveNotBeforeEpoch = safeCampaignEpoch(value.resolveNotBeforeEpoch, "resolveNotBeforeEpoch");
  const now = safeCampaignEpoch(nowEpoch, "current time");
  if (resolveNotBeforeEpoch > now) {
    throw invalidCampaign("Campaign retention has not ended yet.");
  }
  const assignmentId = safePositiveInteger(value.assignmentId, "assignmentId");
  const agreementHash = normalizeCampaignHash(value.agreementHash, "agreementHash");
  const submissionHash = normalizeCampaignHash(value.submissionHash, "submissionHash");
  return Object.freeze({
    schemaVersion: SUBMITTER_SCHEMA_VERSION,
    kind: "CAMPAIGN",
    requestId,
    expectedHandle,
    postId,
    requiredPhrasesJson,
    forbiddenPhrasesJson,
    requireAdDisclosure: value.requireAdDisclosure,
    semanticBrief,
    resolveNotBeforeEpoch,
    assignmentId,
    agreementHash,
    submissionHash,
  });
}

export async function validateMetricsEnvelope(
  value: unknown,
  { nowEpoch = Math.floor(Date.now() / 1_000) }: { nowEpoch?: number } = {},
): Promise<MetricsEnvelope> {
  if (!isPlainObject(value) || !hasExactKeys(value, METRICS_ENVELOPE_KEYS)) {
    throw invalidMetrics("The metrics submission contains missing or unsupported fields.");
  }
  if (value.schemaVersion !== SUBMITTER_SCHEMA_VERSION || value.kind !== "METRICS") {
    throw invalidMetrics(`Metrics schemaVersion must be ${SUBMITTER_SCHEMA_VERSION}.`);
  }
  const envelope = Object.freeze({
    schemaVersion: SUBMITTER_SCHEMA_VERSION,
    kind: "METRICS" as const,
    requestId: normalizeMetricsHash(value.requestId, "requestId"),
    baseWallet: normalizeMetricsAddress(value.baseWallet),
    identityHash: normalizeMetricsHash(value.identityHash, "identityHash"),
    expectedHandle: normalizeMetricsHandle(value.expectedHandle),
    metricsExpiresAtEpoch: safeMetricsEpoch(value.metricsExpiresAtEpoch, "metricsExpiresAtEpoch"),
  });
  const now = safeMetricsEpoch(nowEpoch, "current time");
  if (
    envelope.metricsExpiresAtEpoch <= now ||
    envelope.metricsExpiresAtEpoch > now + MAX_METRICS_SECONDS
  ) {
    throw invalidMetrics("Metrics expiry must be in the next seven days.");
  }
  if (metricsRequestId(envelope) !== envelope.requestId) {
    throw invalidMetrics("requestId does not match the metrics envelope.");
  }
  return envelope;
}

export function validateQueueMessage(value: unknown): QueueMessage {
  const maybeRequestId = isPlainObject(value) && typeof value.requestId === "string" && REQUEST_ID.test(value.requestId)
    ? value.requestId.toLowerCase()
    : null;
  if (!isPlainObject(value) || !hasExactKeys(value, QUEUE_KEYS)) {
    throw new PoisonMessageError("INVALID_QUEUE_MESSAGE", "The queue message has missing or unsupported fields.", maybeRequestId);
  }
  if (value.schemaVersion !== SUBMITTER_SCHEMA_VERSION || typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId)) {
    throw new PoisonMessageError("INVALID_QUEUE_MESSAGE", "The queue message is not an APV2 request reference.", maybeRequestId);
  }
  return Object.freeze({ schemaVersion: 1, requestId: value.requestId.toLowerCase() });
}

export function ownershipRequestId(envelope: Omit<OwnershipEnvelope, "requestId"> | OwnershipEnvelope): string {
  return sha256([
    "xproof-x-ownership-v2",
    envelope.baseWallet.toLowerCase(),
    envelope.expectedHandle.toLowerCase(),
    envelope.postId,
    envelope.challenge,
    envelope.issuedAtEpoch,
    envelope.expiresAtEpoch,
    envelope.credentialExpiresAtEpoch,
  ].join("|"));
}

export function envelopeFingerprint(envelope: SubmissionEnvelope): string {
  const keys = isCampaignEnvelope(envelope)
    ? CAMPAIGN_ENVELOPE_KEYS
    : isMetricsEnvelope(envelope)
      ? METRICS_ENVELOPE_KEYS
      : ENVELOPE_KEYS;
  const record = envelope as unknown as Record<string, unknown>;
  return sha256(JSON.stringify(keys.reduce<Record<string, unknown>>((result, key) => {
    result[key] = record[key];
    return result;
  }, {})));
}

export function submissionArgs(envelope: OwnershipEnvelope): readonly unknown[] {
  return Object.freeze([
    envelope.requestId,
    envelope.baseWallet,
    envelope.expectedHandle,
    envelope.postId,
    envelope.challenge,
    envelope.issuedAtEpoch,
    envelope.expiresAtEpoch,
    envelope.credentialExpiresAtEpoch,
  ]);
}

export function campaignSubmissionArgs(envelope: CampaignEnvelope): readonly unknown[] {
  return Object.freeze([
    envelope.requestId,
    envelope.expectedHandle,
    envelope.postId,
    envelope.requiredPhrasesJson,
    envelope.forbiddenPhrasesJson,
    envelope.requireAdDisclosure,
    envelope.semanticBrief,
    envelope.resolveNotBeforeEpoch,
    envelope.assignmentId,
    envelope.agreementHash,
    envelope.submissionHash,
  ]);
}

export function metricsSubmissionArgs(envelope: MetricsEnvelope): readonly unknown[] {
  return Object.freeze([
    envelope.requestId,
    envelope.baseWallet,
    envelope.identityHash,
    envelope.expectedHandle,
    envelope.metricsExpiresAtEpoch,
  ]);
}

export function metricsRequestId(
  envelope: Omit<MetricsEnvelope, "schemaVersion" | "kind" | "requestId"> | MetricsEnvelope,
): string {
  return sha256([
    "influencedx-x-metrics-v1",
    envelope.baseWallet.toLowerCase(),
    envelope.identityHash.toLowerCase(),
    envelope.expectedHandle,
    envelope.metricsExpiresAtEpoch,
  ].join("|"));
}

export function submitterEnvelopeArgs(envelope: SubmissionEnvelope): readonly unknown[] {
  if (isCampaignEnvelope(envelope)) return campaignSubmissionArgs(envelope);
  if (isMetricsEnvelope(envelope)) return metricsSubmissionArgs(envelope);
  return submissionArgs(envelope);
}

export function submissionFunctionName(envelope: SubmissionEnvelope): SubmitterFunctionName {
  if (isCampaignEnvelope(envelope)) return CAMPAIGN_SUBMITTER_METHOD;
  if (isMetricsEnvelope(envelope)) return METRICS_SUBMITTER_METHOD;
  return SUBMITTER_METHOD;
}

export function isCampaignEnvelope(envelope: SubmissionEnvelope): envelope is CampaignEnvelope {
  return "kind" in envelope && envelope.kind === "CAMPAIGN";
}

export function isMetricsEnvelope(envelope: SubmissionEnvelope): envelope is MetricsEnvelope {
  return "kind" in envelope && envelope.kind === "METRICS";
}

export function submissionCallFingerprint(
  envelopeOrArgs: SubmissionEnvelope | readonly unknown[],
  functionName?: SubmitterFunctionName,
): string {
  const args = Array.isArray(envelopeOrArgs)
    ? normalizeCallArgs(envelopeOrArgs, functionName ?? SUBMITTER_METHOD)
    : submitterEnvelopeArgs(envelopeOrArgs as SubmissionEnvelope);
  return sha256(JSON.stringify(args));
}

export function postEpoch(postId: string): number {
  return Number(((BigInt(postId) >> 22n) + X_EPOCH_MS) / 1_000n);
}

function normalizeSubmissionArgs(value: readonly unknown[]): readonly unknown[] {
  if (value.length !== 8) throw invalid("Decoded verify_ownership arguments are incomplete.");
  return [
    normalizeHash(String(value[0]), "requestId"),
    normalizeAddress(String(value[1])),
    normalizeHandle(String(value[2])),
    normalizePostId(String(value[3])),
    normalizeChallenge(String(value[4])),
    safeDecodedEpoch(value[5], "issuedAtEpoch"),
    safeDecodedEpoch(value[6], "expiresAtEpoch"),
    safeDecodedEpoch(value[7], "credentialExpiresAtEpoch"),
  ];
}

function normalizeCampaignSubmissionArgs(value: readonly unknown[]): readonly unknown[] {
  if (value.length !== 11) throw invalidCampaign("Decoded resolve_submission arguments are incomplete.");
  const requiredPhrasesJson = normalizePhrasesJson(value[3], "requiredPhrasesJson");
  const forbiddenPhrasesJson = normalizePhrasesJson(value[4], "forbiddenPhrasesJson");
  if (typeof value[5] !== "boolean") throw invalidCampaign("requireAdDisclosure must be boolean.");
  return [
    normalizeCampaignHash(value[0], "requestId"),
    normalizeCanonicalHandle(value[1]),
    normalizeCampaignPostId(value[2]),
    requiredPhrasesJson,
    forbiddenPhrasesJson,
    value[5],
    normalizeSemanticBrief(value[6]),
    safeCampaignDecodedEpoch(value[7], "resolveNotBeforeEpoch"),
    safePositiveDecodedInteger(value[8], "assignmentId"),
    normalizeCampaignHash(value[9], "agreementHash"),
    normalizeCampaignHash(value[10], "submissionHash"),
  ];
}

function normalizeMetricsSubmissionArgs(value: readonly unknown[]): readonly unknown[] {
  if (value.length !== 5) throw invalidMetrics("Decoded snapshot_metrics arguments are incomplete.");
  return [
    normalizeMetricsHash(value[0], "requestId"),
    normalizeMetricsAddress(value[1]),
    normalizeMetricsHash(value[2], "identityHash"),
    normalizeMetricsHandle(value[3]),
    safeMetricsDecodedEpoch(value[4], "metricsExpiresAtEpoch"),
  ];
}

function normalizeCallArgs(
  value: readonly unknown[],
  functionName: SubmitterFunctionName,
): readonly unknown[] {
  if (functionName === SUBMITTER_METHOD) return normalizeSubmissionArgs(value);
  if (functionName === CAMPAIGN_SUBMITTER_METHOD) return normalizeCampaignSubmissionArgs(value);
  if (functionName === METRICS_SUBMITTER_METHOD) return normalizeMetricsSubmissionArgs(value);
  throw invalidCampaign("The submitter function is not allowlisted.");
}

export function normalizeSubmissionCallArgs(
  value: readonly unknown[],
  functionName: SubmitterFunctionName,
): readonly unknown[] {
  return Object.freeze([...normalizeCallArgs(value, functionName)]);
}

function normalizeHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) throw invalid(`${label} must be a 32-byte hex hash.`);
  return value.toLowerCase();
}

function normalizeCampaignHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) {
    throw invalidCampaign(`${label} must be a 32-byte hex hash.`);
  }
  return value.toLowerCase();
}

function normalizeMetricsHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) {
    throw invalidMetrics(`${label} must be a 32-byte hex hash.`);
  }
  if (value !== value.toLowerCase()) throw invalidMetrics(`${label} is not canonical.`);
  return value;
}

function normalizeMetricsAddress(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/.test(value)) {
    throw invalidMetrics("baseWallet must be a canonical lowercase EVM address.");
  }
  return value;
}

function normalizeMetricsHandle(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_]{1,15}$/.test(value)) {
    throw invalidMetrics("expectedHandle must be a canonical X handle.");
  }
  return value;
}

function normalizeAddress(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw invalid("baseWallet must be a 20-byte EVM address.");
  return value.toLowerCase();
}

function normalizeHandle(value: unknown): string {
  if (typeof value !== "string") throw invalid("expectedHandle must be an X handle.");
  const handle = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw invalid("expectedHandle is invalid.");
  return handle;
}

function normalizeCanonicalHandle(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9_]{1,15}$/.test(value)) {
    throw invalidCampaign("expectedHandle must be a canonical X handle.");
  }
  return value;
}

function normalizePostId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{5,24}$/.test(value)) throw invalid("postId must be a decimal X post ID.");
  if (BigInt(value) > 18_446_744_073_709_551_615n) throw invalid("postId is outside the supported range.");
  return value;
}

function normalizeCampaignPostId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{5,24}$/.test(value)) {
    throw invalidCampaign("postId must be a decimal X post ID.");
  }
  if (BigInt(value) > 18_446_744_073_709_551_615n) {
    throw invalidCampaign("postId is outside the supported range.");
  }
  return value;
}

function normalizeChallenge(value: unknown): string {
  if (typeof value !== "string" || !/^APV2-[A-Za-z0-9_-]{24}$/.test(value)) throw invalid("challenge must be an APV2 ownership challenge.");
  return value;
}

function safeDecodedEpoch(value: unknown, label: string): number {
  if (typeof value === "bigint" || (typeof value === "string" && /^[1-9][0-9]*$/.test(value))) {
    const big = BigInt(value);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid(`${label} is outside the safe integer range.`);
    return Number(big);
  }
  return safeEpoch(value, label);
}

function safeCampaignDecodedEpoch(value: unknown, label: string): number {
  if (typeof value === "bigint" || (typeof value === "string" && /^[1-9][0-9]*$/.test(value))) {
    const big = BigInt(value);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw invalidCampaign(`${label} is outside the safe integer range.`);
    }
    return Number(big);
  }
  return safeCampaignEpoch(value, label);
}

function safeMetricsDecodedEpoch(value: unknown, label: string): number {
  if (typeof value === "bigint" || (typeof value === "string" && /^[1-9][0-9]*$/.test(value))) {
    const big = BigInt(value);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw invalidMetrics(`${label} is outside the safe integer range.`);
    }
    return Number(big);
  }
  return safeMetricsEpoch(value, label);
}

function safePositiveDecodedInteger(value: unknown, label: string): number {
  if (typeof value === "bigint" || (typeof value === "string" && /^[1-9][0-9]*$/.test(value))) {
    const big = BigInt(value);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidCampaign(`${label} is outside the safe integer range.`);
    return Number(big);
  }
  return safePositiveInteger(value, label);
}

function safePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw invalidCampaign(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

function safeEpoch(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw invalid(`${label} must be a positive epoch-second integer.`);
  return value as number;
}

function safeCampaignEpoch(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw invalidCampaign(`${label} must be a positive epoch-second integer.`);
  }
  return value as number;
}

function safeMetricsEpoch(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw invalidMetrics(`${label} must be a positive epoch-second integer.`);
  }
  return value as number;
}

function sha256(value: string): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function normalizePhrasesJson(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalidCampaign(`${label} must be canonical JSON.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidCampaign(`${label} must be canonical JSON.`);
  }
  if (!Array.isArray(parsed) || parsed.length > 20) {
    throw invalidCampaign(`${label} must be a short JSON string array.`);
  }
  const phrases = parsed.map((item) => {
    if (typeof item !== "string") throw invalidCampaign(`${label} entries must be strings.`);
    const phrase = item.trim();
    if (phrase.length === 0 || phrase.length > 160) {
      throw invalidCampaign(`${label} contains an invalid phrase.`);
    }
    return phrase;
  });
  const canonical = JSON.stringify(phrases);
  if (value !== canonical) throw invalidCampaign(`${label} is not canonical JSON.`);
  return canonical;
}

function normalizeSemanticBrief(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_000 || value !== value.trim()) {
    throw invalidCampaign("semanticBrief must be a canonical string of at most 2000 characters.");
  }
  return value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function invalid(message: string): SubmitterProblem {
  return new SubmitterProblem(400, "INVALID_OWNERSHIP_ENVELOPE", message);
}

function invalidCampaign(message: string): SubmitterProblem {
  return new SubmitterProblem(400, "INVALID_CAMPAIGN_ENVELOPE", message);
}

function invalidMetrics(message: string): SubmitterProblem {
  return new SubmitterProblem(400, "INVALID_METRICS_ENVELOPE", message);
}
