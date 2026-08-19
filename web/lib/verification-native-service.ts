import { and, desc, eq, gt, inArray, lte, ne } from "drizzle-orm";
import { isHex, keccak256, sha256, stringToHex, verifyMessage, type Hex } from "viem";

import { getDb } from "../db/index.ts";
import { verificationRequests, type VerificationStatus } from "../db/schema.ts";
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
import { MARKETPLACE_GENLAYER_CHAIN_ID } from "./marketplace-genlayer-rpc.ts";
import { ApiProblem } from "./verification-api.ts";

type VerificationRow = typeof verificationRequests.$inferSelect;

export type NativeVerificationProjection = Readonly<{
  id: string;
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

export async function createNativeVerificationRequest(input: {
  ownerUserId: string;
  wallet: unknown;
  origin: string;
  nowMs?: number;
}): Promise<{ request: NativeVerificationProjection; message: string | null }> {
  const nowMs = input.nowMs ?? Date.now();
  const normalizedWallet = normalizeWallet(input.wallet);
  const wallet = normalizedWallet.toLowerCase();
  await expireStale(input.ownerUserId, nowMs);
  const existing = await activeOwned(input.ownerUserId, nowMs);
  if (existing) {
    if (existing.wallet !== wallet) {
      throw problem(409, "ACTIVE_REQUEST_EXISTS", "Finish the current verification request before using another wallet.");
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
  const [row] = await getDb().insert(verificationRequests).values({
    id,
    ownerUserId: input.ownerUserId,
    activeOwnerUserId: input.ownerUserId,
    activeWallet: wallet,
    status: "WALLET_CHALLENGE_PENDING",
    statusUpdatedAt: nowMs,
    requestExpiresAt: expiresAt,
    wallet,
    walletNonce: nonce,
    walletNonceHash: sha256(stringToHex(nonce)),
    walletMessage: message,
    walletMessageHash: sha256(stringToHex(message)),
    walletChallengeExpiresAt: expiresAt,
    createdAt: nowMs,
    updatedAt: nowMs,
  }).returning();
  if (!row) throw problem(503, "VERIFICATION_STORAGE_FAILED", "Verification could not be saved.");
  return { request: projection(row), message };
}

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

async function owned(ownerUserId: string, requestId: string): Promise<VerificationRow> {
  if (!requestId || requestId.length > 128) throw problem(400, "INVALID_REQUEST", "requestId is invalid.");
  const [row] = await getDb().select().from(verificationRequests).where(and(
    eq(verificationRequests.id, requestId),
    eq(verificationRequests.ownerUserId, ownerUserId),
  )).limit(1);
  if (!row) throw problem(404, "REQUEST_NOT_FOUND", "Verification request not found.");
  return row;
}

async function activeOwned(ownerUserId: string, nowMs: number) {
  const [row] = await getDb().select().from(verificationRequests).where(and(
    eq(verificationRequests.activeOwnerUserId, ownerUserId),
    gt(verificationRequests.requestExpiresAt, nowMs),
  )).limit(1);
  return row ?? null;
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
  const [updated] = await getDb().update(verificationRequests).set({
    status: "EXPIRED",
    statusUpdatedAt: nowMs,
    activeOwnerUserId: null,
    activeWallet: null,
    walletNonce: null,
    walletMessage: null,
    xChallenge: null,
    tweetText: null,
    farcasterChallenge: null,
    farcasterCastText: null,
    revision: row.revision + 1,
    updatedAt: nowMs,
  }).where(and(
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

function projection(row: VerificationRow): NativeVerificationProjection {
  return Object.freeze({
    id: row.id,
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
