import { createHash, randomUUID } from "node:crypto";

import { canonicalHash, canonicalJson } from "./marketplace-genlayer-rpc.ts";

export const GENLAYER_CAMPAIGN_STATUSES = [
  "OPEN",
  "CANCELLED",
  "CLOSED",
] as const;

export const GENLAYER_ASSIGNMENT_STATUSES = [
  "SELECTED",
  "ACCEPTED",
  "SUBMITTED",
  "UNDETERMINED",
  "SETTLED_PASS",
  "SETTLED_FAIL",
  "DECLINED",
  "EXPIRED",
  "REFUNDED",
] as const;

export const GENLAYER_CONTENT_SOURCES = ["X", "FARCASTER"] as const;
export type GenLayerContentSource =
  (typeof GENLAYER_CONTENT_SOURCES)[number];

export type GenLayerCampaignState = Readonly<{
  campaignId: string;
  brand: string;
  clientNonce: string;
  contentSource: GenLayerContentSource;
  title: string;
  brief: string;
  requiredPhrases: string[];
  forbiddenPhrases: string[];
  requireAdDisclosure: boolean;
  termsHash: string;
  status: (typeof GENLAYER_CAMPAIGN_STATUSES)[number];
  applicationDeadlineEpoch: number;
  selectionDeadlineEpoch: number;
  submissionDeadlineEpoch: number;
  retentionSeconds: number;
  maxUndeterminedRetries: number;
  feeBps: number;
  treasury: string;
  budgetAtto: string;
  availableAtto: string;
  reservedAtto: string;
  settledAtto: string;
  creatorPaidAtto: string;
  brandRefundedAtto: string;
  feeAtto: string;
  applicationCount: number;
  assignmentCount: number;
  createdAtEpoch: number;
  closedAtEpoch: number;
}>;

export type GenLayerProfileState = Readonly<{
  wallet: string;
  source: GenLayerContentSource;
  handle: string;
  externalUserId: string;
  identityHash: string;
  status: "ACTIVE";
  verifiedAtEpoch: number;
  expiresAtEpoch: number;
  ownershipRequestId: string;
  exists: true;
  active: boolean;
}>;

export type GenLayerOwnershipOutcome = "VERIFIED" | "REJECTED" | "UNDETERMINED";

export type GenLayerOwnershipResult = Readonly<{
  requestId: string;
  wallet: string;
  source: GenLayerContentSource;
  handle: string;
  externalUserId: string;
  identityHash: string;
  contentId: string;
  issuedAtEpoch: number;
  expiresAtEpoch: number;
  profileExpiresAtEpoch: number;
  verifiedAtEpoch: number;
  outcome: GenLayerOwnershipOutcome;
  checks: Readonly<Record<string, boolean>>;
}>;

export type GenLayerIdentityBundleResult = Readonly<{
  requestId: string;
  wallet: string;
  kind: "IDENTITY_BUNDLE";
  xRequestId: string;
  farcasterRequestId: string;
  xOutcome: GenLayerOwnershipOutcome;
  farcasterOutcome: GenLayerOwnershipOutcome;
  verifiedAtEpoch: number;
  outcome: GenLayerOwnershipOutcome;
}>;

export type GenLayerRejectedBundleOwnershipResult = GenLayerOwnershipResult &
  Readonly<{
    bundleRequestId: string;
    evidenceOutcome: GenLayerOwnershipOutcome;
  }>;

export type GenLayerApplicationState = Readonly<{
  applicationId: string;
  campaignId: string;
  creator: string;
  contentSource: GenLayerContentSource;
  creatorHandle: string;
  creatorExternalUserId: string;
  creatorIdentityHash: string;
  requestedRateAtto: string;
  pitchCommitment: string;
  status: "APPLIED" | "WITHDRAWN" | "SELECTED" | "DECLINED";
  appliedAtEpoch: number;
  updatedAtEpoch: number;
}>;

export type GenLayerClaimableState = Readonly<{
  account: string;
  claimableAtto: string;
  nextWithdrawalNonce: number;
}>;

export type GenLayerWithdrawalState = Readonly<{
  withdrawalId: string;
  account: string;
  nonce: number;
  amountAtto: string;
  status: "PENDING" | "EMITTED_UNCONFIRMED" | "CONFIRMED" | "RESTORED_FAILED";
  requestedAtEpoch: number;
  emittedAtEpoch: number;
  reconciledAtEpoch: number;
  evidenceHash: string;
  recapitalizedAtto: string;
}>;

export type GenLayerAssignmentState = Readonly<{
  assignmentId: string;
  campaignId: string;
  brand: string;
  creator: string;
  contentSource: GenLayerContentSource;
  creatorHandle: string;
  creatorExternalUserId: string;
  creatorIdentityHash: string;
  applicationId: string;
  agreementHash: string;
  agreedRateAtto: string;
  status: (typeof GENLAYER_ASSIGNMENT_STATUSES)[number];
  selectedAtEpoch: number;
  acceptanceDeadlineEpoch: number;
  acceptedAtEpoch: number;
  postId: string;
  submissionHash: string | null;
  resolutionRequestId: string | null;
  resolutionRound: number;
  resolutionAttempts: number;
  resolutionEligibleAtEpoch: number;
  lastResolutionAtEpoch: number;
  outcome: "PASS" | "FAIL" | "UNDETERMINED" | null;
  reasoning: string;
  resolutionChecks: Readonly<{
    authorMatch: boolean;
    postIdMatch: boolean;
    publicationInWindow: boolean;
    requiredChecks: boolean[];
    forbiddenChecks: boolean[];
    disclosurePresent: boolean;
    semanticPass: boolean;
  }>;
  evidenceHash: string | null;
  creatorCreditAtto: string;
  brandCreditAtto: string;
  feeAtto: string;
  submittedAtEpoch: number;
  settledAtEpoch: number;
  closedAtEpoch: number;
}>;

export const GENLAYER_UNDETERMINED_REFUND_DELAY_SECONDS = 24 * 60 * 60;

export function genLayerCampaignApplicationAvailability(
  campaign: Pick<GenLayerCampaignState, "status" | "applicationDeadlineEpoch">,
  nowEpoch = Math.floor(Date.now() / 1_000),
): Readonly<{
  canApply: boolean;
  reason: "STATE" | "CLOSED" | null;
}> {
  assertEligibilityClock(nowEpoch);
  if (campaign.status !== "OPEN") {
    return Object.freeze({ canApply: false, reason: "STATE" });
  }
  if (nowEpoch >= campaign.applicationDeadlineEpoch) {
    return Object.freeze({ canApply: false, reason: "CLOSED" });
  }
  return Object.freeze({ canApply: true, reason: null });
}

export function genLayerCampaignSelectionAvailability(
  campaign: Pick<GenLayerCampaignState, "status" | "selectionDeadlineEpoch">,
  nowEpoch = Math.floor(Date.now() / 1_000),
): Readonly<{
  canSelect: boolean;
  reason: "STATE" | "CLOSED" | null;
}> {
  assertEligibilityClock(nowEpoch);
  if (campaign.status !== "OPEN") {
    return Object.freeze({ canSelect: false, reason: "STATE" });
  }
  if (nowEpoch >= campaign.selectionDeadlineEpoch) {
    return Object.freeze({ canSelect: false, reason: "CLOSED" });
  }
  return Object.freeze({ canSelect: true, reason: null });
}

export function genLayerApplicationWithdrawalAvailability(
  application: Pick<GenLayerApplicationState, "status">,
  campaign: Pick<GenLayerCampaignState, "selectionDeadlineEpoch">,
  nowEpoch = Math.floor(Date.now() / 1_000),
): Readonly<{
  canWithdraw: boolean;
  reason: "STATE" | "CLOSED" | null;
}> {
  assertEligibilityClock(nowEpoch);
  if (application.status !== "APPLIED") {
    return Object.freeze({ canWithdraw: false, reason: "STATE" });
  }
  if (nowEpoch >= campaign.selectionDeadlineEpoch) {
    return Object.freeze({ canWithdraw: false, reason: "CLOSED" });
  }
  return Object.freeze({ canWithdraw: true, reason: null });
}

export function genLayerAssignmentAcceptanceAvailability(
  assignment: Pick<GenLayerAssignmentState, "status" | "acceptanceDeadlineEpoch">,
  nowEpoch = Math.floor(Date.now() / 1_000),
): Readonly<{
  canAccept: boolean;
  reason: "STATE" | "EXPIRED" | null;
}> {
  assertEligibilityClock(nowEpoch);
  if (assignment.status !== "SELECTED") {
    return Object.freeze({ canAccept: false, reason: "STATE" });
  }
  if (nowEpoch > assignment.acceptanceDeadlineEpoch) {
    return Object.freeze({ canAccept: false, reason: "EXPIRED" });
  }
  return Object.freeze({ canAccept: true, reason: null });
}

export function genLayerAssignmentSubmissionAvailability(
  assignment: Pick<GenLayerAssignmentState, "status">,
  campaign: Pick<GenLayerCampaignState, "submissionDeadlineEpoch">,
  nowEpoch = Math.floor(Date.now() / 1_000),
): Readonly<{
  canSubmit: boolean;
  reason: "STATE" | "EXPIRED" | null;
}> {
  assertEligibilityClock(nowEpoch);
  if (assignment.status !== "ACCEPTED") {
    return Object.freeze({ canSubmit: false, reason: "STATE" });
  }
  if (nowEpoch > campaign.submissionDeadlineEpoch) {
    return Object.freeze({ canSubmit: false, reason: "EXPIRED" });
  }
  return Object.freeze({ canSubmit: true, reason: null });
}

export function genLayerUndeterminedRefundEligibleAtEpoch(
  assignment: Pick<GenLayerAssignmentState, "lastResolutionAtEpoch">,
  campaign: Pick<GenLayerCampaignState, "submissionDeadlineEpoch">,
): number {
  const basis = Math.max(
    campaign.submissionDeadlineEpoch,
    assignment.lastResolutionAtEpoch,
  );
  assertEligibilityClock(basis);
  const eligibleAtEpoch = basis + GENLAYER_UNDETERMINED_REFUND_DELAY_SECONDS;
  if (!Number.isSafeInteger(eligibleAtEpoch)) {
    throw new Error("The undetermined refund clock exceeds the supported range.");
  }
  return eligibleAtEpoch;
}

export function genLayerUndeterminedRefundAvailability(
  assignment: Pick<
    GenLayerAssignmentState,
    "status" | "resolutionAttempts" | "lastResolutionAtEpoch"
  >,
  campaign: Pick<
    GenLayerCampaignState,
    "maxUndeterminedRetries" | "submissionDeadlineEpoch"
  >,
  nowEpoch = Math.floor(Date.now() / 1_000),
): Readonly<{
  canRefund: boolean;
  reason: "STATE" | "RETRIES_REMAIN" | "EARLY" | null;
  unlocksAt: string;
}> {
  assertEligibilityClock(nowEpoch);
  const eligibleAtEpoch = genLayerUndeterminedRefundEligibleAtEpoch(assignment, campaign);
  const unlocksAt = new Date(eligibleAtEpoch * 1_000).toISOString();
  if (assignment.status !== "UNDETERMINED") {
    return Object.freeze({ canRefund: false, reason: "STATE", unlocksAt });
  }
  if (assignment.resolutionAttempts < campaign.maxUndeterminedRetries) {
    return Object.freeze({ canRefund: false, reason: "RETRIES_REMAIN", unlocksAt });
  }
  if (nowEpoch < eligibleAtEpoch) {
    return Object.freeze({ canRefund: false, reason: "EARLY", unlocksAt });
  }
  return Object.freeze({ canRefund: true, reason: null, unlocksAt });
}

function assertEligibilityClock(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("The marketplace eligibility clock is invalid.");
  }
}

export function genLayerResolutionAvailability(
  assignment: Pick<
    GenLayerAssignmentState,
    "status" | "resolutionEligibleAtEpoch" | "resolutionAttempts"
  >,
  campaign: Pick<GenLayerCampaignState, "maxUndeterminedRetries">,
  nowEpoch = Math.floor(Date.now() / 1_000),
): Readonly<{
  canResolve: boolean;
  reason: "STATE" | "EARLY" | "RETRIES_EXHAUSTED" | null;
  unlocksAt: string;
}> {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) {
    throw new Error("The resolution eligibility clock is invalid.");
  }
  const unlocksAt = new Date(assignment.resolutionEligibleAtEpoch * 1_000).toISOString();
  if (!["SUBMITTED", "UNDETERMINED"].includes(assignment.status)) {
    return Object.freeze({ canResolve: false, reason: "STATE", unlocksAt });
  }
  if (nowEpoch < assignment.resolutionEligibleAtEpoch) {
    return Object.freeze({ canResolve: false, reason: "EARLY", unlocksAt });
  }
  if (
    assignment.status === "UNDETERMINED"
    && assignment.resolutionAttempts >= campaign.maxUndeterminedRetries
  ) {
    return Object.freeze({ canResolve: false, reason: "RETRIES_EXHAUSTED", unlocksAt });
  }
  return Object.freeze({ canResolve: true, reason: null, unlocksAt });
}

export function genLayerCampaignCancellationAvailability(
  campaign: Pick<
    GenLayerCampaignState,
    "status" | "applicationDeadlineEpoch" | "reservedAtto"
  >,
  nowEpoch = Math.floor(Date.now() / 1_000),
): Readonly<{
  canCancel: boolean;
  reason: "STATE" | "LATE" | "RESERVED" | null;
}> {
  if (!Number.isSafeInteger(nowEpoch) || nowEpoch < 0) {
    throw new Error("The cancellation eligibility clock is invalid.");
  }
  if (campaign.status !== "OPEN") {
    return Object.freeze({ canCancel: false, reason: "STATE" });
  }
  if (nowEpoch >= campaign.applicationDeadlineEpoch) {
    return Object.freeze({ canCancel: false, reason: "LATE" });
  }
  if (BigInt(campaign.reservedAtto) !== 0n) {
    return Object.freeze({ canCancel: false, reason: "RESERVED" });
  }
  return Object.freeze({ canCancel: true, reason: null });
}

export function normalizeMarketplaceAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.trim())) {
    throw new Error(`${label} is not a valid address.`);
  }
  return value.trim().toLowerCase();
}

export function normalizeMarketplaceHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value.trim())) {
    throw new Error(`${label} is not a valid 32-byte hash.`);
  }
  return value.trim().toLowerCase();
}

export function campaignTerms(input: {
  contentSource: GenLayerContentSource;
  title: string;
  brief: string;
  requiredPhrases: readonly string[];
  forbiddenPhrases: readonly string[];
  requireAdDisclosure: boolean;
  applicationDeadlineEpoch: number;
  selectionDeadlineEpoch: number;
  submissionDeadlineEpoch: number;
  retentionSeconds: number;
  maxUndeterminedRetries: number;
}): Record<string, unknown> {
  return {
    content_source: normalizeContentSource(input.contentSource),
    title: normalizeContractText(input.title, "title", 5, 120),
    brief: normalizeContractText(input.brief, "brief", 10, 4_000),
    required_phrases: input.requiredPhrases.map((phrase) =>
      normalizeContractText(phrase, "required phrase", 1, 160)),
    forbidden_phrases: input.forbiddenPhrases.map((phrase) =>
      normalizeContractText(phrase, "forbidden phrase", 1, 160)),
    require_ad_disclosure: input.requireAdDisclosure,
    application_deadline_epoch: input.applicationDeadlineEpoch,
    selection_deadline_epoch: input.selectionDeadlineEpoch,
    submission_deadline_epoch: input.submissionDeadlineEpoch,
    retention_seconds: input.retentionSeconds,
    max_undetermined_retries: input.maxUndeterminedRetries,
  };
}

export function deriveCampaignTermsHash(
  input: Parameters<typeof campaignTerms>[0],
): string {
  return canonicalHash(campaignTerms(input));
}

export function deriveCampaignId(input: {
  brand: string;
  clientNonce: string;
  termsHash: string;
  budgetAtto: string;
}): string {
  return domainHash(
    "influencedx-campaign-v2",
    normalizeMarketplaceAddress(input.brand, "brand"),
    normalizeClientNonce(input.clientNonce),
    normalizeMarketplaceHash(input.termsHash, "termsHash"),
    decimal(input.budgetAtto, "budgetAtto", true),
  );
}

export function deriveApplicationId(campaignId: string, creator: string): string {
  return domainHash(
    "influencedx-application-v1",
    normalizeMarketplaceHash(campaignId, "campaignId"),
    normalizeMarketplaceAddress(creator, "creator"),
  );
}

export function deriveProjectionId(input: {
  network: string;
  chainId: number;
  contractAddress: string;
  entityId: string;
}): string {
  const network = input.network.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(network)) throw new Error("network is invalid.");
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error("chainId is invalid.");
  return domainHash(
    "influencedx-projection-v1",
    network,
    input.chainId.toString(),
    normalizeMarketplaceAddress(input.contractAddress, "contractAddress"),
    normalizeMarketplaceHash(input.entityId, "entityId"),
  );
}

export function deriveAssignmentId(input: {
  campaignId: string;
  creator: string;
  agreedRateAtto: string;
  agreementHash: string;
}): string {
  return domainHash(
    "influencedx-assignment-v1",
    normalizeMarketplaceHash(input.campaignId, "campaignId"),
    normalizeMarketplaceAddress(input.creator, "creator"),
    decimal(input.agreedRateAtto, "agreedRateAtto", true),
    normalizeMarketplaceHash(input.agreementHash, "agreementHash"),
  );
}

export function deriveOwnershipRequestId(input: {
  wallet: string;
  handle: string;
  postId: string;
  challenge: string;
  issuedAtEpoch: number;
  expiresAtEpoch: number;
  profileExpiresAtEpoch: number;
}): string {
  const handle = input.handle.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw new Error("handle is invalid.");
  if (!/^\d{5,25}$/.test(input.postId)) throw new Error("postId is invalid.");
  if (!/^APV2-[A-Za-z0-9_-]{24}$/.test(input.challenge)) {
    throw new Error("challenge is invalid.");
  }
  return domainHash(
    "xproof-x-ownership-v2",
    normalizeMarketplaceAddress(input.wallet, "wallet"),
    handle,
    input.postId,
    input.challenge,
    epoch(input.issuedAtEpoch, "issuedAtEpoch").toString(),
    epoch(input.expiresAtEpoch, "expiresAtEpoch").toString(),
    epoch(input.profileExpiresAtEpoch, "profileExpiresAtEpoch").toString(),
  );
}

export function deriveFarcasterOwnershipRequestId(input: {
  wallet: string;
  username: string;
  fid: string | number | bigint;
  castHash: string;
  challenge: string;
  issuedAtEpoch: number;
  expiresAtEpoch: number;
  profileExpiresAtEpoch: number;
}): string {
  const username = input.username.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,15}$/.test(username)) {
    throw new Error("username is invalid.");
  }
  const fid = decimal(input.fid, "fid", true);
  const castHash = String(input.castHash).trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(castHash)) {
    throw new Error("castHash is invalid.");
  }
  if (!/^APV2-[A-Za-z0-9_-]{24}$/.test(input.challenge)) {
    throw new Error("challenge is invalid.");
  }
  return domainHash(
    "influencedx-farcaster-ownership-v1",
    normalizeMarketplaceAddress(input.wallet, "wallet"),
    username,
    fid,
    castHash,
    input.challenge,
    epoch(input.issuedAtEpoch, "issuedAtEpoch").toString(),
    epoch(input.expiresAtEpoch, "expiresAtEpoch").toString(),
    epoch(input.profileExpiresAtEpoch, "profileExpiresAtEpoch").toString(),
  );
}

export function deriveIdentityBundleRequestId(input: {
  wallet: string;
  xRequestId: string;
  farcasterRequestId: string;
}): string {
  return domainHash(
    "influencedx-identity-bundle-v1",
    normalizeMarketplaceAddress(input.wallet, "wallet"),
    normalizeMarketplaceHash(input.xRequestId, "xRequestId"),
    normalizeMarketplaceHash(input.farcasterRequestId, "farcasterRequestId"),
  );
}

export function deriveResolutionRequestId(input: {
  assignmentId: string;
  agreementHash: string;
  submissionHash: string;
  contentSource: GenLayerContentSource;
  postId: string;
  roundIndex: number;
}): string {
  return domainHash(
    "influencedx-resolution-v2",
    normalizeMarketplaceHash(input.assignmentId, "assignmentId"),
    normalizeMarketplaceHash(input.agreementHash, "agreementHash"),
    normalizeMarketplaceHash(input.submissionHash, "submissionHash"),
    normalizeContentSource(input.contentSource),
    normalizeContentId(input.contentSource, input.postId),
    epoch(input.roundIndex, "roundIndex").toString(),
  );
}

export function deriveWithdrawalId(input: {
  account: string;
  nonce: string | number | bigint;
  amountAtto: string | number | bigint;
}): string {
  return domainHash(
    "influencedx-withdrawal-v1",
    normalizeMarketplaceAddress(input.account, "account"),
    decimal(input.nonce, "nonce"),
    decimal(input.amountAtto, "amountAtto", true),
  );
}

export function normalizeContractText(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const normalized = value.trim().split(/\s+/u).join(" ");
  const length = [...normalized].length;
  if (length < minimum || length > maximum) {
    throw new Error(`${label} length is invalid.`);
  }
  return normalized;
}

export function createCampaignClientNonce(): string {
  return randomUUID().toLowerCase();
}

export function parseCampaignState(value: unknown): GenLayerCampaignState {
  const row = record(value, "campaign");
  const status = stringEnum(row.status, "campaign.status", GENLAYER_CAMPAIGN_STATUSES);
  const state: GenLayerCampaignState = {
    campaignId: hashField(row, "campaign_id"),
    brand: addressField(row, "brand"),
    clientNonce: textField(row, "client_nonce", 8, 128),
    contentSource: sourceField(row, "content_source"),
    title: textField(row, "title", 5, 120),
    brief: textField(row, "brief", 10, 4_000),
    requiredPhrases: stringArray(row.required_phrases, "required_phrases"),
    forbiddenPhrases: stringArray(row.forbidden_phrases, "forbidden_phrases"),
    requireAdDisclosure: booleanField(row, "require_ad_disclosure"),
    termsHash: hashField(row, "terms_hash"),
    status,
    applicationDeadlineEpoch: integerField(row, "application_deadline_epoch"),
    selectionDeadlineEpoch: integerField(row, "selection_deadline_epoch"),
    submissionDeadlineEpoch: integerField(row, "submission_deadline_epoch"),
    retentionSeconds: integerField(row, "retention_seconds"),
    maxUndeterminedRetries: integerField(row, "max_undetermined_retries"),
    feeBps: integerField(row, "fee_bps"),
    treasury: addressField(row, "treasury"),
    budgetAtto: decimalField(row, "budget_atto", true),
    availableAtto: decimalField(row, "available_atto"),
    reservedAtto: decimalField(row, "reserved_atto"),
    settledAtto: decimalField(row, "settled_atto"),
    creatorPaidAtto: decimalField(row, "creator_paid_atto"),
    brandRefundedAtto: decimalField(row, "brand_refunded_atto"),
    feeAtto: decimalField(row, "fee_atto"),
    applicationCount: integerField(row, "application_count"),
    assignmentCount: integerField(row, "assignment_count"),
    createdAtEpoch: integerField(row, "created_at_epoch"),
    closedAtEpoch: integerField(row, "closed_at_epoch"),
  };
  assertCampaignStateAccounting(state);
  if (
    state.maxUndeterminedRetries < 1 ||
    state.maxUndeterminedRetries > 5 ||
    state.retentionSeconds < 60 ||
    state.retentionSeconds > 604_800 ||
    (state.status !== "OPEN" && (state.availableAtto !== "0" || state.reservedAtto !== "0"))
  ) {
    throw new Error("The campaign state violates contract bounds.");
  }
  return state;
}

export function parseProfileState(value: unknown): GenLayerProfileState {
  const row = record(value, "profile");
  if (row.exists !== true) throw new Error("The creator profile does not exist.");
  if (row.status !== "ACTIVE") throw new Error("The creator profile is not active.");
  return {
    wallet: addressField(row, "wallet"),
    source: sourceField(row, "source"),
    handle: textField(row, "handle", 1, 64),
    externalUserId: textField(row, "external_user_id", 1, 64),
    identityHash: hashField(row, "identity_hash"),
    status: "ACTIVE",
    verifiedAtEpoch: integerField(row, "verified_at_epoch"),
    expiresAtEpoch: integerField(row, "expires_at_epoch"),
    ownershipRequestId: hashField(row, "ownership_request_id"),
    exists: true,
    active: booleanField(row, "active"),
  };
}

export function parseOwnershipResult(
  value: unknown,
  expected: Readonly<{
    requestId: string;
    wallet: string;
    source: GenLayerContentSource;
    handle: string;
    externalUserId?: string;
    contentId: string;
    issuedAtEpoch: number;
    expiresAtEpoch: number;
    profileExpiresAtEpoch: number;
  }>,
): GenLayerOwnershipResult {
  const row = record(value, "ownership result");
  const common = [
    "request_id", "wallet", "source", "handle", "external_user_id",
    "identity_hash", "post_id", "issued_at_epoch", "expires_at_epoch",
    "profile_expires_at_epoch", "verified_at_epoch", "outcome",
    "protocol_match", "challenge_match", "wallet_match", "issued_at_match",
    "expires_at_match", "profile_expires_at_match", "publication_in_window",
  ];
  const sourceFields = expected.source === "X"
    ? ["x_user_id", "author_match", "post_id_match"]
    : ["fid", "username_match", "fid_match", "cast_hash_match"];
  if (Object.keys(row).sort().join(",") !== [...common, ...sourceFields].sort().join(",")) {
    throw new Error("ownership result fields are invalid.");
  }
  const source = sourceField(row, "source");
  const outcome = stringEnum(row.outcome, "ownership result outcome", [
    "VERIFIED", "REJECTED", "UNDETERMINED",
  ] as const);
  const externalUserId = allowEmptyText(row.external_user_id, "external_user_id", 64);
  const identityHash = hashField(row, "identity_hash");
  const result = {
    requestId: hashField(row, "request_id"),
    wallet: addressField(row, "wallet"),
    source,
    handle: textField(row, "handle", 1, 64),
    externalUserId,
    identityHash,
    contentId: normalizeContentId(source, textField(row, "post_id", 1, 66)),
    issuedAtEpoch: integerField(row, "issued_at_epoch"),
    expiresAtEpoch: integerField(row, "expires_at_epoch"),
    profileExpiresAtEpoch: integerField(row, "profile_expires_at_epoch"),
    verifiedAtEpoch: integerField(row, "verified_at_epoch"),
    outcome,
    checks: Object.freeze(Object.fromEntries(
      [...common, ...sourceFields]
        .filter((key) => key.endsWith("_match") || key === "publication_in_window")
        .map((key) => [key, booleanField(row, key)]),
    )),
  } satisfies GenLayerOwnershipResult;
  const normalizedWallet = normalizeMarketplaceAddress(expected.wallet, "wallet");
  const sourceIdentityMatches = source === "X"
    ? allowEmptyText(row.x_user_id, "x_user_id", 64) === externalUserId
    : decimalField(row, "fid", true) === externalUserId;
  if (
    result.requestId !== expected.requestId.toLowerCase() ||
    result.wallet !== normalizedWallet ||
    result.source !== expected.source ||
    result.handle !== expected.handle ||
    (expected.externalUserId !== undefined && result.externalUserId !== expected.externalUserId) ||
    result.contentId !== expected.contentId ||
    result.issuedAtEpoch !== expected.issuedAtEpoch ||
    result.expiresAtEpoch !== expected.expiresAtEpoch ||
    result.profileExpiresAtEpoch !== expected.profileExpiresAtEpoch ||
    !sourceIdentityMatches ||
    (outcome === "VERIFIED" && (externalUserId.length === 0 || /^0x0{64}$/.test(identityHash)))
  ) {
    throw new Error("ownership result binding is invalid.");
  }
  return Object.freeze(result);
}

export function parseIdentityBundleResult(
  value: unknown,
  expected: Readonly<{
    requestId: string;
    wallet: string;
    xRequestId: string;
    farcasterRequestId: string;
  }>,
): GenLayerIdentityBundleResult {
  const row = record(value, "identity bundle result");
  const fields = [
    "request_id",
    "wallet",
    "kind",
    "x_request_id",
    "farcaster_request_id",
    "x_outcome",
    "farcaster_outcome",
    "verified_at_epoch",
    "outcome",
  ];
  if (Object.keys(row).sort().join(",") !== fields.sort().join(",")) {
    throw new Error("identity bundle result fields are invalid.");
  }
  const outcomes = ["VERIFIED", "REJECTED", "UNDETERMINED"] as const;
  const xOutcome = stringEnum(row.x_outcome, "identity bundle X outcome", outcomes);
  const farcasterOutcome = stringEnum(
    row.farcaster_outcome,
    "identity bundle Farcaster outcome",
    outcomes,
  );
  const outcome = stringEnum(row.outcome, "identity bundle outcome", outcomes);
  const expectedOutcome: GenLayerOwnershipOutcome =
    xOutcome === "VERIFIED" && farcasterOutcome === "VERIFIED"
      ? "VERIFIED"
      : xOutcome === "UNDETERMINED" || farcasterOutcome === "UNDETERMINED"
        ? "UNDETERMINED"
        : "REJECTED";
  const result = {
    requestId: hashField(row, "request_id"),
    wallet: addressField(row, "wallet"),
    kind: textField(row, "kind", 1, 32),
    xRequestId: hashField(row, "x_request_id"),
    farcasterRequestId: hashField(row, "farcaster_request_id"),
    xOutcome,
    farcasterOutcome,
    verifiedAtEpoch: integerField(row, "verified_at_epoch"),
    outcome,
  };
  if (
    result.kind !== "IDENTITY_BUNDLE" ||
    result.requestId !== normalizeMarketplaceHash(expected.requestId, "requestId") ||
    result.wallet !== normalizeMarketplaceAddress(expected.wallet, "wallet") ||
    result.xRequestId !== normalizeMarketplaceHash(expected.xRequestId, "xRequestId") ||
    result.farcasterRequestId !== normalizeMarketplaceHash(
      expected.farcasterRequestId,
      "farcasterRequestId",
    ) ||
    result.outcome !== expectedOutcome
  ) {
    throw new Error("identity bundle result binding is invalid.");
  }
  return Object.freeze(result as GenLayerIdentityBundleResult);
}

export function parseRejectedBundleOwnershipResult(
  value: unknown,
  expected: Parameters<typeof parseOwnershipResult>[1] &
    Readonly<{
      bundleRequestId: string;
      evidenceOutcome: GenLayerOwnershipOutcome;
    }>,
): GenLayerRejectedBundleOwnershipResult {
  const row = record(value, "rejected bundle ownership result");
  if (
    !Object.prototype.hasOwnProperty.call(row, "bundle_request_id") ||
    !Object.prototype.hasOwnProperty.call(row, "evidence_outcome")
  ) {
    throw new Error("rejected bundle ownership result fields are invalid.");
  }
  const bundleRequestId = hashField(row, "bundle_request_id");
  const evidenceOutcome = stringEnum(
    row.evidence_outcome,
    "bundle evidence outcome",
    ["VERIFIED", "REJECTED", "UNDETERMINED"] as const,
  );
  const base = { ...row };
  delete base.bundle_request_id;
  delete base.evidence_outcome;
  const parsed = parseOwnershipResult(base, expected);
  if (
    parsed.outcome !== "REJECTED" ||
    bundleRequestId !==
      normalizeMarketplaceHash(expected.bundleRequestId, "bundleRequestId") ||
    evidenceOutcome !== expected.evidenceOutcome
  ) {
    throw new Error("rejected bundle ownership result binding is invalid.");
  }
  return Object.freeze({ ...parsed, bundleRequestId, evidenceOutcome });
}

export function ownershipOutcomeAllowsRetry(
  outcome: string | null | undefined,
): boolean {
  return outcome === null || outcome === undefined || outcome === "UNDETERMINED";
}

export function parseApplicationState(value: unknown): GenLayerApplicationState {
  const row = record(value, "application");
  return {
    applicationId: hashField(row, "application_id"),
    campaignId: hashField(row, "campaign_id"),
    creator: addressField(row, "creator"),
    contentSource: sourceField(row, "content_source"),
    creatorHandle: textField(row, "creator_handle", 1, 64),
    creatorExternalUserId: textField(row, "creator_external_user_id", 1, 64),
    creatorIdentityHash: hashField(row, "creator_identity_hash"),
    requestedRateAtto: decimalField(row, "requested_rate_atto", true),
    pitchCommitment: hashField(row, "pitch_commitment"),
    status: stringEnum(row.status, "application.status", [
      "APPLIED",
      "WITHDRAWN",
      "SELECTED",
      "DECLINED",
    ] as const),
    appliedAtEpoch: integerField(row, "applied_at_epoch"),
    updatedAtEpoch: integerField(row, "updated_at_epoch"),
  };
}

export function parseClaimableState(value: unknown): GenLayerClaimableState {
  const row = record(value, "claimable");
  return {
    account: addressField(row, "account"),
    claimableAtto: decimalField(row, "claimable_atto"),
    nextWithdrawalNonce: integerField(row, "next_withdrawal_nonce"),
  };
}

export function parseWithdrawalState(value: unknown): GenLayerWithdrawalState {
  const row = record(value, "withdrawal");
  return {
    withdrawalId: hashField(row, "withdrawal_id"),
    account: addressField(row, "account"),
    nonce: integerField(row, "nonce"),
    amountAtto: decimalField(row, "amount_atto", true),
    status: stringEnum(row.status, "withdrawal.status", [
      "PENDING",
      "EMITTED_UNCONFIRMED",
      "CONFIRMED",
      "RESTORED_FAILED",
    ] as const),
    requestedAtEpoch: integerField(row, "requested_at_epoch"),
    emittedAtEpoch: integerField(row, "emitted_at_epoch"),
    reconciledAtEpoch: integerField(row, "reconciled_at_epoch"),
    evidenceHash: hashField(row, "evidence_hash"),
    recapitalizedAtto: decimalField(row, "recapitalized_atto"),
  };
}

export function parseAssignmentState(value: unknown): GenLayerAssignmentState {
  const row = record(value, "assignment");
  const rawOutcome = row.outcome;
  const outcome = rawOutcome === "" || rawOutcome == null
    ? null
    : stringEnum(rawOutcome, "assignment.outcome", ["PASS", "FAIL", "UNDETERMINED"] as const);
  const rawChecks = record(row.resolution_checks ?? {}, "resolution_checks");
  return {
    assignmentId: hashField(row, "assignment_id"),
    campaignId: hashField(row, "campaign_id"),
    brand: addressField(row, "brand"),
    creator: addressField(row, "creator"),
    contentSource: sourceField(row, "content_source"),
    creatorHandle: textField(row, "creator_handle", 1, 64),
    creatorExternalUserId: textField(row, "creator_external_user_id", 1, 64),
    creatorIdentityHash: hashField(row, "creator_identity_hash"),
    applicationId: hashField(row, "application_id"),
    agreementHash: hashField(row, "agreement_hash"),
    agreedRateAtto: decimalField(row, "agreed_rate_atto", true),
    status: stringEnum(row.status, "assignment.status", GENLAYER_ASSIGNMENT_STATUSES),
    selectedAtEpoch: integerField(row, "selected_at_epoch"),
    acceptanceDeadlineEpoch: integerField(row, "acceptance_deadline_epoch"),
    acceptedAtEpoch: integerField(row, "accepted_at_epoch"),
    postId: optionalString(row.post_id),
    submissionHash: optionalHash(row.submission_hash),
    resolutionRequestId: optionalHash(row.resolution_request_id),
    resolutionRound: integerField(row, "resolution_round"),
    resolutionAttempts: integerField(row, "resolution_attempts"),
    resolutionEligibleAtEpoch: integerField(row, "resolution_eligible_at_epoch"),
    lastResolutionAtEpoch: integerField(row, "last_resolution_at_epoch"),
    outcome,
    reasoning: optionalString(row.reasoning),
    resolutionChecks: {
      authorMatch: optionalBoolean(rawChecks.author_match),
      postIdMatch: optionalBoolean(rawChecks.post_id_match),
      publicationInWindow: optionalBoolean(rawChecks.publication_in_window),
      requiredChecks: booleanArray(rawChecks.required_checks),
      forbiddenChecks: booleanArray(rawChecks.forbidden_checks),
      disclosurePresent: optionalBoolean(rawChecks.disclosure_present),
      semanticPass: optionalBoolean(rawChecks.semantic_pass),
    },
    evidenceHash: optionalHash(row.evidence_hash),
    creatorCreditAtto: decimalField(row, "creator_credit_atto"),
    brandCreditAtto: decimalField(row, "brand_credit_atto"),
    feeAtto: decimalField(row, "fee_atto"),
    submittedAtEpoch: optionalInteger(row.submitted_at_epoch),
    settledAtEpoch: integerField(row, "settled_at_epoch"),
    closedAtEpoch: integerField(row, "closed_at_epoch"),
  };
}

export function campaignSnapshotHash(state: GenLayerCampaignState): string {
  return canonicalHash(state);
}

export function assertCampaignStateAccounting(state: Pick<
  GenLayerCampaignState,
  | "budgetAtto"
  | "availableAtto"
  | "reservedAtto"
  | "settledAtto"
  | "creatorPaidAtto"
  | "brandRefundedAtto"
  | "feeAtto"
>): void {
  const budget = BigInt(state.budgetAtto);
  const available = BigInt(state.availableAtto);
  const reserved = BigInt(state.reservedAtto);
  const settled = BigInt(state.settledAtto);
  const creator = BigInt(state.creatorPaidAtto);
  const refunded = BigInt(state.brandRefundedAtto);
  const fee = BigInt(state.feeAtto);
  if (
    available + reserved + creator + refunded + fee !== budget ||
    settled < creator + fee ||
    settled > creator + fee + refunded
  ) {
    throw new Error("The campaign state violates GEN conservation.");
  }
}

export function normalizeClientNonce(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 128) {
    throw new Error("clientNonce is invalid.");
  }
  return normalized;
}

function domainHash(...parts: string[]): string {
  return `0x${createHash("sha256").update(parts.join("|")).digest("hex")}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ${label} state is malformed.`);
  }
  return value as Record<string, unknown>;
}

function textField(row: Record<string, unknown>, key: string, min: number, max: number): string {
  const value = row[key];
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new Error(`The ${key} state field is invalid.`);
  }
  return value;
}

function allowEmptyText(value: unknown, key: string, max: number): string {
  if (typeof value !== "string" || value.length > max) {
    throw new Error(`The ${key} state field is invalid.`);
  }
  return value;
}

function addressField(row: Record<string, unknown>, key: string): string {
  return normalizeMarketplaceAddress(row[key], key);
}

function hashField(row: Record<string, unknown>, key: string): string {
  return normalizeMarketplaceHash(row[key], key);
}

function optionalHash(value: unknown): string | null {
  if (value === "" || value == null || value === `0x${"0".repeat(64)}`) return null;
  return normalizeMarketplaceHash(value, "optional hash");
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanField(row: Record<string, unknown>, key: string): boolean {
  if (typeof row[key] !== "boolean") throw new Error(`The ${key} state field is invalid.`);
  return row[key];
}

function optionalBoolean(value: unknown): boolean {
  return value === true;
}

function booleanArray(value: unknown): boolean[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "boolean")) {
    throw new Error("The resolution checks are malformed.");
  }
  return [...value];
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`The ${label} state field is invalid.`);
  }
  return [...value];
}

function integerField(row: Record<string, unknown>, key: string): number {
  return epoch(row[key], key);
}

function optionalInteger(value: unknown): number {
  return value == null ? 0 : epoch(value, "optional epoch");
}

function epoch(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is invalid.`);
  return number;
}

function decimalField(row: Record<string, unknown>, key: string, positive = false): string {
  return decimal(row[key], key, positive);
}

function decimal(value: unknown, label: string, positive = false): string {
  const normalized = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^(0|[1-9][0-9]{0,77})$/.test(normalized) || (positive && normalized === "0")) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

export function normalizeContentSource(value: unknown): GenLayerContentSource {
  if (value !== "X" && value !== "FARCASTER") {
    throw new Error("contentSource is invalid.");
  }
  return value;
}

function sourceField(
  row: Record<string, unknown>,
  key: string,
): GenLayerContentSource {
  return normalizeContentSource(row[key]);
}

function normalizeContentId(
  source: GenLayerContentSource,
  value: string,
): string {
  const normalized = value.trim().toLowerCase();
  if (source === "X" && /^\d{5,25}$/.test(normalized)) return normalized;
  if (source === "FARCASTER" && /^0x[0-9a-f]{40}$/.test(normalized)) {
    return normalized;
  }
  throw new Error("postId is invalid for contentSource.");
}

function stringEnum<const T extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as T[number];
}

// Exported for parity tests against the contract's Python canonical JSON.
export function campaignTermsCanonicalJson(input: Parameters<typeof campaignTerms>[0]): string {
  return canonicalJson(campaignTerms(input));
}
