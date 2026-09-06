import {
  and,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { isHex, keccak256, sha256, stringToHex, verifyMessage, type Hex } from "viem";

import { getDb } from "../db/index.ts";
import {
  marketplaceGenLayerTransactions,
  verificationRequests,
  type MarketplaceGenLayerTransactionStatus,
  type VerificationStatus,
} from "../db/schema.ts";
import {
  CREDENTIAL_TTL_MS,
  WALLET_CHALLENGE_TTL_MS,
  X_CHALLENGE_TTL_MS,
  buildOwnershipTweet,
  makeRandomBase64Url,
  makeRandomToken,
  normalizeWallet,
  normalizeXHandle,
} from "./verification-core.ts";
import { parseIdentityBundleResult } from "./marketplace-genlayer-core.ts";
import {
  MARKETPLACE_GENLAYER_CHAIN_ID,
  MARKETPLACE_GENLAYER_NETWORK,
  marketplaceContractAddress,
  readMarketplaceState,
} from "./marketplace-genlayer-rpc.ts";
import { ApiProblem } from "./verification-api.ts";
import {
  isAuthenticatedWalletSession,
  walletSessionMatches,
  type AuthenticatedWalletSession,
  type WalletSession,
} from "./wallet-session.ts";

type VerificationRow = typeof verificationRequests.$inferSelect;

type NativeVerificationActivationGuard = Pick<VerificationRow,
  | "activationConfirmedAt"
  | "activationPreparedId"
  | "activationTxHash"
  | "farcasterOwnershipRequestId"
  | "finalizedRequestId"
  | "genlayerErrorCode"
  | "genlayerFinalizedAt"
  | "genlayerLastPolledAt"
  | "genlayerOutcome"
  | "genlayerSubmittedAt"
  | "genlayerTxHash"
  | "intentPreparedAt"
  | "intentSignatureStatus"
  | "readyForGenLayerAt"
  | "submissionAttempts"
  | "submissionLastAttemptAt"
  | "submissionResponseUpdatedAt"
  | "submissionStatus"
  | "submissionStatusUpdatedAt"
  | "xOwnershipRequestId"
>;

export type NativeVerificationProjection = Readonly<{
  id: string;
  revision: number;
  status: VerificationStatus;
  wallet: string;
  walletChallengeExpiresAt: string;
  walletAuthorizedAt: string | null;
  source: "X" | "FARCASTER" | null;
  handle: string | null;
  tweetText: string | null;
  xChallengeIssuedAt: string | null;
  xChallengeExpiresAt: string | null;
  credentialExpiresAt: string | null;
  normalizedVerificationPostUrl: string | null;
  verificationPostId: string | null;
  farcasterUsername: string | null;
  farcasterFid: string | null;
  farcasterCastText: string | null;
  farcasterCastHash: string | null;
  farcasterChallengeIssuedAt: string | null;
  farcasterChallengeExpiresAt: string | null;
  identityBundleReady: boolean;
  xOwnershipRequestId: string | null;
  farcasterOwnershipRequestId: string | null;
  finalizedRequestId: string | null;
  activationPreparedId: string | null;
  activationTxHash: string | null;
  genlayerTxHash: string | null;
  genlayerOutcome: string | null;
  createdAt: string;
  updatedAt: string;
}>;

type NativeVerificationRequestStore = {
  expireStale: typeof expireStale;
  findActive: (ownerUserId: string) => Promise<VerificationRow | null>;
  insert: (values: typeof verificationRequests.$inferInsert) => Promise<VerificationRow | null>;
  authorizePending: (row: VerificationRow, nowMs: number) => Promise<VerificationRow | null>;
};

export async function createNativeVerificationRequest(input: {
  session: WalletSession;
  wallet: unknown;
  origin: string;
  nowMs?: number;
}, store: NativeVerificationRequestStore = nativeVerificationRequestStore): Promise<{ request: NativeVerificationProjection; message: string | null }> {
  const nowMs = input.nowMs ?? Date.now();
  const normalizedWallet = normalizeWallet(input.wallet);
  const wallet = normalizedWallet.toLowerCase();
  const { session } = input;
  if (session.expiresAt * 1_000 <= nowMs) {
    throw problem(401, "WALLET_AUTHENTICATION_REQUIRED", "Sign in with your wallet again.");
  }
  const authenticated = isAuthenticatedWalletSession(session);
  if (authenticated && !walletSessionMatches(session, wallet)) {
    throw problem(409, "SESSION_WALLET_MISMATCH", "This session is already bound to another wallet.");
  }
  const ownerUserId = session.subject;
  await store.expireStale(ownerUserId, nowMs);
  const existing = await store.findActive(ownerUserId);
  if (existing) {
    if (existing.wallet !== wallet || existing.ownerUserId !== ownerUserId) {
      throw problem(409, "ACTIVE_REQUEST_EXISTS", "Finish the current verification request before using another wallet.");
    }
    if (existing.sessionDetachedAt !== null) stateChanged();
    if (!authenticated && (existing.walletAuthorizedAt !== null || existing.status !== "WALLET_CHALLENGE_PENDING")) {
      throw problem(401, "WALLET_AUTHENTICATION_REQUIRED", "Sign in to resume this verification.");
    }
    if (authenticated && existing.status === "WALLET_CHALLENGE_PENDING") {
      if (
        existing.walletChallengeExpiresAt <= nowMs
        || existing.requestExpiresAt <= nowMs
        || hasNativeVerificationActivationState(existing)
      ) stateChanged();
      const authorized = await store.authorizePending(existing, nowMs);
      if (!authorized) stateChanged();
      return { request: projection(authorized), message: null };
    }
    return { request: projection(existing), message: existing.status === "WALLET_CHALLENGE_PENDING" ? existing.walletMessage : null };
  }
  const id = crypto.randomUUID();
  const nonce = makeRandomToken(16);
  const expiresAt = nowMs + WALLET_CHALLENGE_TTL_MS;
  const message = buildNativeWalletAuthorizationMessage({
    origin: input.origin,
    requestId: id,
    wallet: normalizedWallet,
    nonce,
    issuedAtMs: nowMs,
    expiresAtMs: expiresAt,
  });
  const row = await store.insert({
    id,
    ownerUserId,
    activeOwnerUserId: ownerUserId,
    activeWallet: wallet,
    status: authenticated ? "WALLET_AUTHORIZED" : "WALLET_CHALLENGE_PENDING",
    statusUpdatedAt: nowMs,
    requestExpiresAt: authenticated ? nowMs + 24 * 60 * 60 * 1_000 : expiresAt,
    wallet,
    walletNonce: authenticated ? null : nonce,
    walletNonceHash: sha256(stringToHex(nonce)),
    walletMessage: authenticated ? null : message,
    walletMessageHash: sha256(stringToHex(message)),
    walletChallengeExpiresAt: expiresAt,
    walletAuthorizedAt: authenticated ? nowMs : null,
    // Session authorization has no new per-request signature to record.
    walletSignatureHash: null,
    purgedAt: authenticated ? nowMs : null,
    createdAt: nowMs,
    updatedAt: nowMs,
  });
  if (!row) throw problem(503, "VERIFICATION_STORAGE_FAILED", "Verification could not be saved.");
  return { request: projection(row), message: authenticated ? null : message };
}

const nativeVerificationRequestStore: NativeVerificationRequestStore = {
  expireStale,
  findActive: activeOwned,
  async insert(values) {
    const [row] = await getDb().insert(verificationRequests).values(values).returning();
    return row ?? null;
  },
  async authorizePending(row, nowMs) {
    const [updated] = await getDb().update(verificationRequests).set({
      status: "WALLET_AUTHORIZED",
      statusUpdatedAt: nowMs,
      walletAuthorizedAt: nowMs,
      walletNonce: null,
      walletMessage: null,
      requestExpiresAt: nowMs + 24 * 60 * 60 * 1_000,
      purgedAt: nowMs,
      revision: row.revision + 1,
      updatedAt: nowMs,
    }).where(and(
      eq(verificationRequests.id, row.id),
      eq(verificationRequests.ownerUserId, row.ownerUserId),
      eq(verificationRequests.activeOwnerUserId, row.ownerUserId),
      eq(verificationRequests.wallet, row.wallet),
      eq(verificationRequests.status, "WALLET_CHALLENGE_PENDING"),
      eq(verificationRequests.revision, row.revision),
      isNull(verificationRequests.sessionDetachedAt),
      isNull(verificationRequests.activationPreparedId),
      isNull(verificationRequests.activationTxHash),
      gt(verificationRequests.walletChallengeExpiresAt, nowMs),
      gt(verificationRequests.requestExpiresAt, nowMs),
    )).returning();
    return updated ?? null;
  },
};

function buildNativeWalletAuthorizationMessage(input: {
  origin: string;
  requestId: string;
  wallet: `0x${string}`;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
}): string {
  const origin = new URL(input.origin).origin;
  return [
    "InfluencedX wallet authorization",
    "",
    "Authorize this wallet to create one GenLayer identity verification request.",
    "This signature does not approve a payment or blockchain transaction.",
    "",
    `Domain: ${new URL(origin).host}`,
    `URI: ${origin}/verify`,
    `Chain ID: ${MARKETPLACE_GENLAYER_CHAIN_ID}`,
    `Request ID: ${input.requestId}`,
    `Wallet: ${input.wallet}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${new Date(input.issuedAtMs).toISOString()}`,
    `Expiration Time: ${new Date(input.expiresAtMs).toISOString()}`,
  ].join("\n");
}

export async function authorizeNativeVerificationWallet(input: {
  ownerUserId: string;
  requestId: string;
  signature: string;
  nowMs?: number;
}): Promise<NativeVerificationProjection> {
  const nowMs = input.nowMs ?? Date.now();
  const row = await owned(input.ownerUserId, input.requestId);
  if (row.sessionDetachedAt !== null) stateChanged();
  requireStatus(row, "WALLET_CHALLENGE_PENDING");
  if (row.walletChallengeExpiresAt <= nowMs) {
    await markExpired(row, nowMs);
    throw problem(410, "CHALLENGE_EXPIRED", "The wallet challenge expired.");
  }
  const signature = parseSignature(input.signature);
  let valid = false;
  try {
    valid = await verifyMessage({
      address: row.wallet as `0x${string}`,
      message: row.walletMessage ?? "",
      signature,
    });
  } catch {
    throw problem(503, "SIGNATURE_VERIFIER_UNAVAILABLE", "The wallet signature could not be verified.");
  }
  if (!valid) throw problem(422, "INVALID_WALLET_SIGNATURE", "The signature does not match the requested wallet.");
  const [updated] = await getDb().update(verificationRequests).set({
    status: "WALLET_AUTHORIZED",
    statusUpdatedAt: nowMs,
    walletAuthorizedAt: nowMs,
    walletSignatureHash: keccak256(signature),
    walletNonce: null,
    walletMessage: null,
    requestExpiresAt: nowMs + 24 * 60 * 60 * 1_000,
    purgedAt: nowMs,
    revision: row.revision + 1,
    updatedAt: nowMs,
  }).where(and(
    eq(verificationRequests.id, row.id),
    eq(verificationRequests.ownerUserId, input.ownerUserId),
    eq(verificationRequests.status, "WALLET_CHALLENGE_PENDING"),
    eq(verificationRequests.revision, row.revision),
    isNull(verificationRequests.sessionDetachedAt),
    gt(verificationRequests.requestExpiresAt, nowMs),
  )).returning();
  if (!updated) stateChanged();
  return projection(updated);
}

export async function issueNativeXChallenge(input: {
  ownerUserId: string;
  requestId: string;
  handle: unknown;
  nowMs?: number;
}): Promise<NativeVerificationProjection> {
  const nowMs = input.nowMs ?? Date.now();
  const row = await owned(input.ownerUserId, input.requestId);
  if (row.sessionDetachedAt !== null) stateChanged();
  requireStatus(row, "WALLET_AUTHORIZED");
  const handle = normalizeXHandle(input.handle);
  const challenge = `APV2-${makeRandomBase64Url(18)}`;
  const expiresAt = nowMs + X_CHALLENGE_TTL_MS;
  const credentialExpiresAt = nowMs + CREDENTIAL_TTL_MS;
  const text = buildOwnershipTweet({
    wallet: row.wallet as `0x${string}`,
    challenge,
    issuedAtMs: nowMs,
    challengeExpiresAtMs: expiresAt,
    credentialExpiresAtMs: credentialExpiresAt,
  });
  const [updated] = await getDb().update(verificationRequests).set({
    status: "X_CHALLENGE_ISSUED",
    statusUpdatedAt: nowMs,
    identitySource: "X",
    handle,
    xChallenge: challenge,
    tweetText: text,
    tweetTextHash: sha256(stringToHex(text)),
    challengeHash: sha256(stringToHex(challenge)),
    xChallengeIssuedAt: nowMs,
    xChallengeExpiresAt: expiresAt,
    credentialExpiresAt,
    farcasterUsername: null,
    farcasterFid: null,
    farcasterChallenge: null,
    farcasterCastText: null,
    farcasterChallengeIssuedAt: null,
    farcasterChallengeExpiresAt: null,
    farcasterCastHash: null,
    requestExpiresAt: expiresAt,
    revision: row.revision + 1,
    updatedAt: nowMs,
  }).where(and(
    eq(verificationRequests.id, row.id),
    eq(verificationRequests.ownerUserId, input.ownerUserId),
    eq(verificationRequests.status, "WALLET_AUTHORIZED"),
    eq(verificationRequests.revision, row.revision),
    isNull(verificationRequests.sessionDetachedAt),
    gt(verificationRequests.requestExpiresAt, nowMs),
  )).returning();
  if (!updated) stateChanged();
  return projection(updated);
}

export async function getNativeVerificationStatus(input: {
  ownerUserId: string;
  requestId?: string;
  nowMs?: number;
}): Promise<NativeVerificationProjection | null> {
  const [row] = input.requestId
    ? await getDb().select().from(verificationRequests).where(and(
        eq(verificationRequests.id, input.requestId),
        eq(verificationRequests.ownerUserId, input.ownerUserId),
      )).limit(1)
    : await getDb().select().from(verificationRequests)
        .where(eq(verificationRequests.ownerUserId, input.ownerUserId))
        .orderBy(desc(verificationRequests.createdAt)).limit(1);
  if (!row) return null;
  return projection(row.requestExpiresAt <= (input.nowMs ?? Date.now())
    ? await markExpired(row, input.nowMs ?? Date.now())
    : row);
}

export function hasNativeVerificationActivationState(
  row: NativeVerificationActivationGuard,
): boolean {
  return (
    row.activationPreparedId !== null ||
    row.activationTxHash !== null ||
    row.activationConfirmedAt !== null ||
    row.finalizedRequestId !== null ||
    row.xOwnershipRequestId !== null ||
    row.farcasterOwnershipRequestId !== null ||
    row.intentSignatureStatus !== "NOT_PREPARED" ||
    row.intentPreparedAt !== null ||
    row.readyForGenLayerAt !== null ||
    row.submissionStatus !== "NOT_SUBMITTED" ||
    row.submissionStatusUpdatedAt !== null ||
    row.submissionAttempts !== 0 ||
    row.submissionLastAttemptAt !== null ||
    row.submissionResponseUpdatedAt !== null ||
    row.genlayerTxHash !== null ||
    row.genlayerOutcome !== null ||
    row.genlayerErrorCode !== null ||
    row.genlayerSubmittedAt !== null ||
    row.genlayerLastPolledAt !== null ||
    row.genlayerFinalizedAt !== null
  );
}

export async function endNativeVerificationRun(input: {
  ownerUserId: string;
  requestId: string;
  revision: number;
  nowMs?: number;
}): Promise<Readonly<{ ended: boolean; processing: boolean }>> {
  const nowMs = input.nowMs ?? Date.now();
  if (
    !input.requestId ||
    input.requestId.length > 128 ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0
  ) {
    throw problem(400, "INVALID_REQUEST", "The run binding is invalid.");
  }

  const exactRun = and(
    eq(verificationRequests.id, input.requestId),
    eq(verificationRequests.ownerUserId, input.ownerUserId),
    eq(verificationRequests.activeOwnerUserId, input.ownerUserId),
    eq(verificationRequests.revision, input.revision),
  );
  const [ended] = await getDb().update(verificationRequests).set(
    expiredNativeVerificationValues(nowMs),
  ).where(and(
    exactRun,
    isNull(verificationRequests.activationPreparedId),
    isNull(verificationRequests.activationTxHash),
    isNull(verificationRequests.activationConfirmedAt),
    isNull(verificationRequests.finalizedRequestId),
    isNull(verificationRequests.xOwnershipRequestId),
    isNull(verificationRequests.farcasterOwnershipRequestId),
    eq(verificationRequests.intentSignatureStatus, "NOT_PREPARED"),
    isNull(verificationRequests.intentPreparedAt),
    isNull(verificationRequests.readyForGenLayerAt),
    eq(verificationRequests.submissionStatus, "NOT_SUBMITTED"),
    isNull(verificationRequests.submissionStatusUpdatedAt),
    eq(verificationRequests.submissionAttempts, 0),
    isNull(verificationRequests.submissionLastAttemptAt),
    isNull(verificationRequests.submissionResponseUpdatedAt),
    isNull(verificationRequests.genlayerTxHash),
    isNull(verificationRequests.genlayerOutcome),
    isNull(verificationRequests.genlayerErrorCode),
    isNull(verificationRequests.genlayerSubmittedAt),
    isNull(verificationRequests.genlayerLastPolledAt),
    isNull(verificationRequests.genlayerFinalizedAt),
  )).returning({ id: verificationRequests.id });
  if (ended) return Object.freeze({ ended: true, processing: false });

  // A finalized UNDETERMINED result is safe to release only after its
  // challenge expires and the immutable FINALIZED journal row is bound back
  // to this exact request, transaction, actor, entity, and deployment.
  const finalizedCandidate = await exactActiveOwned(
    input.ownerUserId,
    input.requestId,
    input.revision,
  );
  const expiredFinalized = await releaseExpiredFinalizedUndetermined(
    finalizedCandidate,
    nowMs,
  );
  if (expiredFinalized) {
    return Object.freeze({ ended: true, processing: false });
  }

  // Once the journal owns a transaction hash, the browser session is no
  // longer required for hosted reconciliation. A conditional revision bump
  // makes this proof a CAS: an old journal can never authorize detaching a
  // concurrently replaced PREPARED run. No activation evidence is changed.
  if (await detachHashBoundNativeVerificationSession({
    ownerUserId: input.ownerUserId,
    requestId: input.requestId,
    revision: input.revision,
    nowMs,
  })) {
    return Object.freeze({ ended: false, processing: true });
  }

  const active = await exactActiveOwned(
    input.ownerUserId,
    input.requestId,
    input.revision,
  );
  if (!active) {
    throw problem(409, "STATE_CHANGED", "Run changed. Refresh.");
  }
  if (hasNativeVerificationActivationState(active)) {
    throw problem(
      409,
      "VERIFICATION_TRANSACTION_PENDING",
      "Finish the transaction first.",
    );
  }
  throw problem(409, "STATE_CHANGED", "Run changed. Retry.");
}

type WalletRunOwner = Pick<VerificationRow, "id" | "revision" | "status" | "ownerUserId" | "activeOwnerUserId" | "wallet" | "walletAuthorizedAt">;

/** Called only after fresh signature verification; never by the logout path. */
export async function restoreNativeVerificationWalletSession(
  session: AuthenticatedWalletSession,
  findActive: (wallet: string) => Promise<WalletRunOwner | null> = activeWalletRunOwner,
  nowMs = Date.now(),
  releaseUnsigned: (row: WalletRunOwner, nowMs: number) => Promise<boolean> = releaseUnsignedWalletReservation,
): Promise<AuthenticatedWalletSession> {
  if (!isAuthenticatedWalletSession(session) || session.expiresAt * 1_000 <= nowMs) {
    throw problem(401, "WALLET_AUTHENTICATION_REQUIRED", "Sign in with your wallet again.");
  }
  const active = await findActive(session.wallet);
  if (!active) return session;
  if (
    !walletSessionMatches(session, active.wallet)
    || active.activeOwnerUserId !== active.ownerUserId
    || !/^[A-Za-z0-9_-]{43}$/.test(active.ownerUserId)
  ) stateChanged();
  if (active.walletAuthorizedAt === null && active.ownerUserId !== session.subject) {
    // Anyone could have reserved an address before signing. Never adopt that
    // unproven session's subject; release only its unsigned, idle reservation.
    if (active.status !== "WALLET_CHALLENGE_PENDING" || !await releaseUnsigned(active, nowMs)) stateChanged();
    return session;
  }
  // Keep the existing owner and all exact journal/intent bindings unchanged.
  // Pending cookies cannot read or cancel an authorized run: those endpoints
  // require wallet authentication, even when the opaque subject matches.
  return { ...session, subject: active.ownerUserId };
}

async function activeWalletRunOwner(wallet: string): Promise<WalletRunOwner | null> {
  const [row] = await getDb().select({
    id: verificationRequests.id,
    revision: verificationRequests.revision,
    status: verificationRequests.status,
    ownerUserId: verificationRequests.ownerUserId,
    activeOwnerUserId: verificationRequests.activeOwnerUserId,
    wallet: verificationRequests.wallet,
    walletAuthorizedAt: verificationRequests.walletAuthorizedAt,
  }).from(verificationRequests).where(and(
    eq(verificationRequests.activeWallet, wallet),
    isNotNull(verificationRequests.activeOwnerUserId),
  )).limit(1);
  return row ?? null;
}

async function releaseUnsignedWalletReservation(row: WalletRunOwner, nowMs: number): Promise<boolean> {
  const [released] = await getDb().update(verificationRequests).set(
    expiredNativeVerificationValues(nowMs),
  ).where(and(
    eq(verificationRequests.id, row.id),
    eq(verificationRequests.revision, row.revision),
    eq(verificationRequests.ownerUserId, row.ownerUserId),
    eq(verificationRequests.activeOwnerUserId, row.ownerUserId),
    eq(verificationRequests.activeWallet, row.wallet),
    eq(verificationRequests.status, "WALLET_CHALLENGE_PENDING"),
    isNull(verificationRequests.walletAuthorizedAt),
    isNull(verificationRequests.activationPreparedId),
    isNull(verificationRequests.activationTxHash),
    isNull(verificationRequests.genlayerTxHash),
    eq(verificationRequests.intentSignatureStatus, "NOT_PREPARED"),
    eq(verificationRequests.submissionStatus, "NOT_SUBMITTED"),
  )).returning({ id: verificationRequests.id });
  return Boolean(released);
}

async function owned(ownerUserId: string, requestId: string): Promise<VerificationRow> {
  if (!requestId || requestId.length > 128) throw problem(400, "INVALID_REQUEST", "requestId is invalid.");
  const [row] = await getDb().select().from(verificationRequests).where(and(
    eq(verificationRequests.id, requestId),
    eq(verificationRequests.ownerUserId, ownerUserId),
  )).limit(1);
  if (!row) throw problem(404, "REQUEST_NOT_FOUND", "Verification request not found.");
  return row;
}

async function activeOwned(ownerUserId: string): Promise<VerificationRow | null> {
  const [row] = await getDb().select().from(verificationRequests).where(
    eq(verificationRequests.activeOwnerUserId, ownerUserId),
  ).limit(1);
  return row ?? null;
}

async function exactActiveOwned(
  ownerUserId: string,
  requestId: string,
  revision: number,
): Promise<VerificationRow | null> {
  const [row] = await getDb().select().from(verificationRequests).where(and(
    eq(verificationRequests.id, requestId),
    eq(verificationRequests.ownerUserId, ownerUserId),
    eq(verificationRequests.activeOwnerUserId, ownerUserId),
    eq(verificationRequests.revision, revision),
  )).limit(1);
  return row ?? null;
}

function isExpiredFinalizedUndeterminedCandidate(
  row: VerificationRow | null,
  nowMs: number,
): row is VerificationRow & {
  finalizedRequestId: string;
  xOwnershipRequestId: string;
  farcasterOwnershipRequestId: string;
} {
  return Boolean(
    row
    && row.status === "X_CHALLENGE_ISSUED"
    && row.requestExpiresAt <= nowMs
    && row.xChallengeExpiresAt !== null
    && row.xChallengeExpiresAt <= nowMs
    && row.farcasterChallengeExpiresAt !== null
    && row.farcasterChallengeExpiresAt <= nowMs
    && row.finalizedRequestId
    && row.xOwnershipRequestId
    && row.farcasterOwnershipRequestId
    && row.activationPreparedId
    && row.activationTxHash
    && row.activationConfirmedAt
    && row.genlayerTxHash
    && row.genlayerOutcome === "UNDETERMINED"
    && row.genlayerErrorCode === null
    && row.genlayerFinalizedAt
    && row.activationTxHash === row.genlayerTxHash
    && row.activationConfirmedAt === row.genlayerFinalizedAt
  );
}

async function assertAuthoritativeUndeterminedBundleResult(
  row: VerificationRow & {
    finalizedRequestId: string;
    xOwnershipRequestId: string;
    farcasterOwnershipRequestId: string;
  },
): Promise<void> {
  let raw: unknown;
  try {
    raw = await readMarketplaceState("get_ownership_result", [
      row.finalizedRequestId,
    ]);
  } catch {
    throw problem(
      503,
      "VERIFICATION_RESULT_UNAVAILABLE",
      "Transaction result unavailable. Retry.",
    );
  }
  try {
    const result = parseIdentityBundleResult(raw, {
      requestId: row.finalizedRequestId,
      wallet: row.wallet,
      xRequestId: row.xOwnershipRequestId,
      farcasterRequestId: row.farcasterOwnershipRequestId,
    });
    if (result.outcome !== "UNDETERMINED") {
      throw new Error("The stored outcome changed.");
    }
  } catch {
    throw problem(
      409,
      "VERIFICATION_RESULT_MISMATCH",
      "Transaction result changed. Refresh.",
    );
  }
}

async function releaseExpiredFinalizedUndetermined(
  row: VerificationRow | null,
  nowMs: number,
): Promise<VerificationRow | null> {
  if (!isExpiredFinalizedUndeterminedCandidate(row, nowMs)) return null;
  await assertAuthoritativeUndeterminedBundleResult(row);
  const [released] = await getDb().update(verificationRequests).set(
    expiredNativeVerificationValues(nowMs, { preserveActivationAudit: true }),
  ).where(and(
    eq(verificationRequests.id, row.id),
    eq(verificationRequests.ownerUserId, row.ownerUserId),
    eq(verificationRequests.activeOwnerUserId, row.ownerUserId),
    eq(verificationRequests.revision, row.revision),
    row.sessionDetachedAt === null
      ? isNull(verificationRequests.sessionDetachedAt)
      : eq(verificationRequests.sessionDetachedAt, row.sessionDetachedAt),
    lte(verificationRequests.requestExpiresAt, nowMs),
    eq(verificationRequests.status, "X_CHALLENGE_ISSUED"),
    isNotNull(verificationRequests.activationPreparedId),
    isNotNull(verificationRequests.activationTxHash),
    isNotNull(verificationRequests.activationConfirmedAt),
    isNotNull(verificationRequests.finalizedRequestId),
    isNotNull(verificationRequests.xOwnershipRequestId),
    isNotNull(verificationRequests.farcasterOwnershipRequestId),
    isNotNull(verificationRequests.xChallengeExpiresAt),
    lte(verificationRequests.xChallengeExpiresAt, nowMs),
    isNotNull(verificationRequests.farcasterChallengeExpiresAt),
    lte(verificationRequests.farcasterChallengeExpiresAt, nowMs),
    isNotNull(verificationRequests.genlayerTxHash),
    eq(verificationRequests.genlayerOutcome, "UNDETERMINED"),
    isNull(verificationRequests.genlayerErrorCode),
    isNotNull(verificationRequests.genlayerFinalizedAt),
    eq(verificationRequests.activationTxHash, verificationRequests.genlayerTxHash),
    eq(verificationRequests.activationConfirmedAt, verificationRequests.genlayerFinalizedAt),
    exactActivationJournalExists(["FINALIZED"], {
      requireRequestTransactionBinding: true,
      requireRequestFinalityBinding: true,
      requireSuccessfulFinalization: true,
    }),
  )).returning();
  return released ?? null;
}

async function expireStale(ownerUserId: string, nowMs: number) {
  const rows = await getDb().select().from(verificationRequests).where(and(
    eq(verificationRequests.ownerUserId, ownerUserId),
    ne(verificationRequests.status, "EXPIRED"),
    lte(verificationRequests.requestExpiresAt, nowMs),
  )).limit(50);
  await Promise.all(rows.map((row) => markExpired(row, nowMs)));
}

async function markExpired(row: VerificationRow, nowMs: number): Promise<VerificationRow> {
  if (row.status === "EXPIRED") return row;
  if (hasNativeVerificationActivationState(row)) {
    // Logout is independent of run cancellation. Expiry must therefore not
    // require a logout/detach marker. This helper still requires the exact
    // FINALIZED journal, immutable bindings, and authoritative chain outcome.
    return await releaseExpiredFinalizedUndetermined(row, nowMs) ?? row;
  }
  const [updated] = await getDb().update(verificationRequests).set(
    expiredNativeVerificationValues(nowMs),
  ).where(and(
    eq(verificationRequests.id, row.id),
    eq(verificationRequests.ownerUserId, row.ownerUserId),
    eq(verificationRequests.revision, row.revision),
    inArray(verificationRequests.status, [
      "WALLET_CHALLENGE_PENDING",
      "WALLET_AUTHORIZED",
      "X_CHALLENGE_ISSUED",
      "INTENT_PREPARED",
      "READY_FOR_GENLAYER",
    ]),
  )).returning();
  return updated ?? row;
}

/**
 * Releases expired, finalized UNDETERMINED runs without a browser session.
 * The hosted maintenance loop calls this after journal reconciliation so a
 * finalized inconclusive run cannot retain the per-owner/per-wallet lock.
 */
export async function releaseExpiredFinalizedNativeVerificationRuns(input: {
  nowMs?: number;
  limit?: number;
} = {}) {
  const nowMs = input.nowMs ?? Date.now();
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("The detached verification maintenance clock is invalid.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("The finalized verification maintenance limit is invalid.");
  }
  const rows = await getDb().select().from(verificationRequests).where(and(
    isNotNull(verificationRequests.activeOwnerUserId),
    eq(verificationRequests.status, "X_CHALLENGE_ISSUED"),
    lte(verificationRequests.requestExpiresAt, nowMs),
    eq(verificationRequests.genlayerOutcome, "UNDETERMINED"),
  )).limit(limit);
  const settled = await Promise.allSettled(
    rows.map((row) => releaseExpiredFinalizedUndetermined(row, nowMs)),
  );
  return Object.freeze({
    checked: rows.length,
    released: settled.filter(
      (result) => result.status === "fulfilled" && result.value !== null,
    ).length,
    deferred: settled.filter(
      (result) => result.status === "rejected",
    ).length,
  });
}

function projection(row: VerificationRow): NativeVerificationProjection {
  return Object.freeze({
    id: row.id,
    revision: row.revision,
    status: row.status,
    wallet: row.wallet,
    walletChallengeExpiresAt: iso(row.walletChallengeExpiresAt)!,
    walletAuthorizedAt: iso(row.walletAuthorizedAt),
    source: row.identitySource,
    handle: row.handle,
    tweetText: row.tweetText,
    xChallengeIssuedAt: iso(row.xChallengeIssuedAt),
    xChallengeExpiresAt: iso(row.xChallengeExpiresAt),
    credentialExpiresAt: iso(row.credentialExpiresAt),
    normalizedVerificationPostUrl: row.normalizedVerificationPostUrl,
    verificationPostId: row.verificationPostId,
    farcasterUsername: row.farcasterUsername,
    farcasterFid: row.farcasterFid,
    farcasterCastText: row.farcasterCastText,
    farcasterCastHash: row.farcasterCastHash,
    farcasterChallengeIssuedAt: iso(row.farcasterChallengeIssuedAt),
    farcasterChallengeExpiresAt: iso(row.farcasterChallengeExpiresAt),
    identityBundleReady: Boolean(
      row.tweetText &&
      row.xChallenge &&
      row.farcasterCastText &&
      row.farcasterChallenge,
    ),
    xOwnershipRequestId: row.xOwnershipRequestId,
    farcasterOwnershipRequestId: row.farcasterOwnershipRequestId,
    finalizedRequestId: row.finalizedRequestId,
    activationPreparedId: row.activationPreparedId,
    activationTxHash: row.activationTxHash,
    genlayerTxHash: row.genlayerTxHash,
    genlayerOutcome: row.genlayerOutcome,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  });
}

function expiredNativeVerificationValues(
  nowMs: number,
  options: { preserveActivationAudit?: boolean } = {},
) {
  return {
    status: "EXPIRED" as const,
    statusUpdatedAt: nowMs,
    requestExpiresAt: nowMs,
    activeOwnerUserId: null,
    activeWallet: null,
    walletNonce: null,
    walletMessage: null,
    identitySource: null,
    handle: null,
    xChallenge: null,
    tweetText: null,
    tweetTextHash: null,
    xChallengeIssuedAt: null,
    xChallengeExpiresAt: null,
    credentialExpiresAt: null,
    farcasterUsername: null,
    farcasterFid: null,
    farcasterChallenge: null,
    farcasterCastText: null,
    farcasterChallengeIssuedAt: null,
    farcasterChallengeExpiresAt: null,
    farcasterCastHash: null,
    normalizedVerificationPostUrl: null,
    verificationPostId: null,
    verificationPostCreatedAt: null,
    ...(options.preserveActivationAudit
      ? {}
      : {
          finalizedRequestId: null,
          xOwnershipRequestId: null,
          farcasterOwnershipRequestId: null,
        }),
    handleHash: null,
    verificationPostHash: null,
    challengeHash: null,
    intentTypedDataJson: null,
    sealedEvidenceCiphertext: null,
    sealedEvidenceHash: null,
    sealedEvidenceExpiresAt: null,
    sealedEvidencePurgedAt: nowMs,
    baseProfileIdentityHash: null,
    baseProfileHandleHash: null,
    baseProfileVerificationPostHash: null,
    purgedAt: nowMs,
    revision: sql`${verificationRequests.revision} + 1`,
    updatedAt: nowMs,
  };
}

function exactActivationJournalExists(
  statuses: readonly MarketplaceGenLayerTransactionStatus[],
  options: {
    requireRequestTransactionBinding?: boolean;
    requireRequestFinalityBinding?: boolean;
    requireSuccessfulFinalization?: boolean;
    bindPresentRequestState?: boolean;
  } = {},
) {
  return exists(
    getDb().select({ preparedId: marketplaceGenLayerTransactions.preparedId })
      .from(marketplaceGenLayerTransactions)
      .where(and(
        eq(
          marketplaceGenLayerTransactions.preparedId,
          verificationRequests.activationPreparedId,
        ),
        eq(marketplaceGenLayerTransactions.network, MARKETPLACE_GENLAYER_NETWORK),
        eq(marketplaceGenLayerTransactions.chainId, MARKETPLACE_GENLAYER_CHAIN_ID),
        eq(
          marketplaceGenLayerTransactions.contractAddress,
          marketplaceContractAddress(),
        ),
        eq(marketplaceGenLayerTransactions.operation, "ACTIVATE_IDENTITY_BUNDLE"),
        eq(marketplaceGenLayerTransactions.functionName, "activate_identity_bundle"),
        eq(marketplaceGenLayerTransactions.valueAtto, "0"),
        isNull(marketplaceGenLayerTransactions.localCampaignId),
        isNull(marketplaceGenLayerTransactions.localApplicationId),
        eq(marketplaceGenLayerTransactions.actorWallet, verificationRequests.wallet),
        eq(
          marketplaceGenLayerTransactions.onchainEntityId,
          verificationRequests.finalizedRequestId,
        ),
        isNotNull(marketplaceGenLayerTransactions.transactionHash),
        inArray(marketplaceGenLayerTransactions.status, [...statuses]),
        options.requireRequestTransactionBinding
          ? eq(
              marketplaceGenLayerTransactions.transactionHash,
              verificationRequests.activationTxHash,
            )
          : undefined,
        options.requireRequestFinalityBinding
          ? eq(
              marketplaceGenLayerTransactions.finalizedAt,
              verificationRequests.activationConfirmedAt,
            )
          : undefined,
        options.requireSuccessfulFinalization
          ? eq(marketplaceGenLayerTransactions.lifecycleStatus, "FINALIZED")
          : undefined,
        options.requireSuccessfulFinalization
          ? eq(marketplaceGenLayerTransactions.executionResult, "SUCCESS")
          : undefined,
        options.bindPresentRequestState
          ? or(
              isNull(verificationRequests.activationTxHash),
              eq(
                marketplaceGenLayerTransactions.transactionHash,
                verificationRequests.activationTxHash,
              ),
            )
          : undefined,
        options.bindPresentRequestState
          ? or(
              isNull(verificationRequests.genlayerTxHash),
              eq(
                marketplaceGenLayerTransactions.transactionHash,
                verificationRequests.genlayerTxHash,
              ),
            )
          : undefined,
        options.bindPresentRequestState
          ? or(
              isNull(verificationRequests.activationConfirmedAt),
              eq(
                marketplaceGenLayerTransactions.finalizedAt,
                verificationRequests.activationConfirmedAt,
              ),
            )
          : undefined,
        options.bindPresentRequestState
          ? or(
              isNull(verificationRequests.genlayerFinalizedAt),
              eq(
                marketplaceGenLayerTransactions.finalizedAt,
                verificationRequests.genlayerFinalizedAt,
              ),
            )
          : undefined,
      )),
  );
}

async function detachHashBoundNativeVerificationSession(
  input: {
    ownerUserId: string;
    requestId?: string;
    revision?: number;
    nowMs: number;
  },
): Promise<boolean> {
  const [detached] = await getDb().update(verificationRequests).set({
    sessionDetachedAt: input.nowMs,
    revision: sql`${verificationRequests.revision} + 1`,
    updatedAt: input.nowMs,
  }).where(and(
    eq(verificationRequests.activeOwnerUserId, input.ownerUserId),
    isNull(verificationRequests.sessionDetachedAt),
    input.requestId === undefined
      ? undefined
      : eq(verificationRequests.id, input.requestId),
    input.revision === undefined
      ? undefined
      : eq(verificationRequests.revision, input.revision),
    isNotNull(verificationRequests.activationPreparedId),
    isNotNull(verificationRequests.finalizedRequestId),
    exactActivationJournalExists(
      [
        "SUBMITTED",
        "ACCEPTED",
        "FINALIZED",
        "EXECUTION_FAILED",
        "NETWORK_TERMINATED",
        "RECONCILIATION_REQUIRED",
      ],
      { bindPresentRequestState: true },
    ),
  )).returning({ id: verificationRequests.id });
  if (detached) return true;

  // The detach fence can commit even if the response that clears the cookie
  // is lost. The exact request ID remains safe across a refresh or hosted
  // finalization because the durable fence blocks every browser mutation;
  // a newer run necessarily has a different request ID.
  const [alreadyDetached] = await getDb().select({
    id: verificationRequests.id,
  }).from(verificationRequests).where(and(
    eq(verificationRequests.activeOwnerUserId, input.ownerUserId),
    isNotNull(verificationRequests.sessionDetachedAt),
    input.requestId === undefined
      ? undefined
      : eq(verificationRequests.id, input.requestId),
    isNotNull(verificationRequests.activationPreparedId),
    isNotNull(verificationRequests.finalizedRequestId),
    exactActivationJournalExists(
      [
        "SUBMITTED",
        "ACCEPTED",
        "FINALIZED",
        "EXECUTION_FAILED",
        "NETWORK_TERMINATED",
        "RECONCILIATION_REQUIRED",
      ],
      { bindPresentRequestState: true },
    ),
  )).limit(1);
  return Boolean(alreadyDetached);
}

function requireStatus(row: VerificationRow, expected: VerificationStatus) {
  if (row.status === "EXPIRED") throw problem(410, "CHALLENGE_EXPIRED", "This request expired.");
  if (row.status !== expected) throw problem(409, "INVALID_STATE", `This action requires ${expected}.`);
}

function parseSignature(value: string): Hex {
  if (value.length > 1_000 || !isHex(value) || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw problem(400, "INVALID_SIGNATURE", "Enter a valid hex signature.");
  }
  return value as Hex;
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function stateChanged(): never {
  throw problem(409, "STATE_CHANGED", "The verification request changed. Refresh before continuing.");
}

function problem(status: number, code: string, message: string) {
  return new ApiProblem(status, code, message);
}
