import { and, eq, gt, inArray } from "drizzle-orm";
import { sha256, stringToHex } from "viem";

import { getDb } from "../db/index.ts";
import { verificationRequests } from "../db/schema.ts";
import {
  CREDENTIAL_TTL_MS,
  X_CHALLENGE_TTL_MS,
  buildOwnershipTweet,
  makeRandomBase64Url,
  normalizeXHandle,
  parseVerificationPostUrl,
  validateVerificationPostTiming,
} from "./verification-core.ts";
import {
  getNativeVerificationStatus,
  type NativeVerificationProjection,
} from "./verification-native-service.ts";
import {
  deriveFarcasterOwnershipRequestId,
  deriveIdentityBundleRequestId,
  deriveOwnershipRequestId,
  normalizeMarketplaceAddress,
  ownershipOutcomeAllowsRetry,
  parseOwnershipResult,
  parseIdentityBundleResult,
  parseRejectedBundleOwnershipResult,
  parseProfileState,
  type GenLayerContentSource,
  type GenLayerProfileState,
} from "./marketplace-genlayer-core.ts";
import {
  bindGenLayerTransactionHash,
  findGenLayerPreparedTransaction,
  prepareGenLayerMarketplaceTransaction,
  recordGenLayerTransactionStatus,
  updateGenLayerProjectionCursor,
  upsertGenLayerProfileProjection,
  type GenLayerTransactionRow,
} from "./marketplace-genlayer-repository.ts";
import {
  MARKETPLACE_GENLAYER_CHAIN_ID,
  MARKETPLACE_GENLAYER_NETWORK,
  MarketplaceGenLayerFinalityError,
  assertTransactionMatchesPreparedCall,
  canonicalHash,
  loadFinalizedMarketplaceTransaction,
  marketplaceCalldataAddress,
  marketplaceContractAddress,
  readMarketplaceState,
  type MarketplaceGenLayerCall,
} from "./marketplace-genlayer-rpc.ts";
import { ApiProblem } from "./verification-api.ts";
import type { AuthenticatedWalletSession } from "./wallet-session.ts";

const TX_HASH = /^0x[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FARCASTER_HASH = /^0x[0-9a-f]{40}$/;

type VerificationRow = typeof verificationRequests.$inferSelect;
type ActivationEnvelope = Readonly<{
  requestId: string;
  contentId: string;
  normalizedUrl: string | null;
  contentCreatedAtMs: number | null;
  challenge: string;
  issuedAtMs: number;
  expiresAtMs: number;
  profileExpiresAtMs: number;
}>;

type IdentityBundleEnvelope = Readonly<{
  bundleRequestId: string;
  x: ActivationEnvelope;
  farcaster: ActivationEnvelope;
}>;

export async function issueIdentityBundleChallenge(input: {
  session: AuthenticatedWalletSession;
  requestId: string;
  handle: unknown;
  farcasterUsername: unknown;
  farcasterFid: unknown;
  nowMs?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const row = await ownedRow(input.session, input.requestId);
  if (
    !["WALLET_AUTHORIZED", "X_CHALLENGE_ISSUED"].includes(row.status) ||
    row.requestExpiresAt <= nowMs
  ) {
    stateChanged();
  }
  if (row.activationPreparedId || row.activationTxHash || row.activationConfirmedAt) {
    throw problem(
      409,
      "ACTIVATION_ALREADY_PREPARED",
      "Resume the prepared activation before replacing its identity challenge.",
    );
  }
  let handle: string;
  try {
    handle = normalizeXHandle(input.handle);
  } catch {
    throw problem(400, "INVALID_X_HANDLE", "Enter a valid X handle.");
  }
  const farcasterUsername = normalizeFarcasterUsername(input.farcasterUsername);
  const farcasterFid = positiveDecimal(input.farcasterFid, "farcasterFid");
  const expiresAt = nowMs + X_CHALLENGE_TTL_MS;
  const credentialExpiresAt = nowMs + CREDENTIAL_TTL_MS;
  const xChallenge = `APV2-${makeRandomBase64Url(18)}`;
  const farcasterChallenge = `APV2-${makeRandomBase64Url(18)}`;
  const tweetText = buildOwnershipTweet({
    wallet: row.wallet as `0x${string}`,
    challenge: xChallenge,
    issuedAtMs: nowMs,
    challengeExpiresAtMs: expiresAt,
    credentialExpiresAtMs: credentialExpiresAt,
  });
  const castText = [
    "InfluencedX identity",
    `n=${farcasterChallenge}`,
    `w=${row.wallet.toLowerCase()}`,
    `i=${Math.floor(nowMs / 1_000)}`,
    `e=${Math.floor(expiresAt / 1_000)}`,
    `c=${Math.floor(credentialExpiresAt / 1_000)}`,
  ].join(" ");
  const [updated] = await getDb()
    .update(verificationRequests)
    .set({
      status: "X_CHALLENGE_ISSUED",
      statusUpdatedAt: nowMs,
      identitySource: null,
      handle,
      xChallenge,
      tweetText,
      tweetTextHash: sha256(stringToHex(tweetText)),
      challengeHash: sha256(stringToHex(xChallenge)),
      xChallengeIssuedAt: nowMs,
      xChallengeExpiresAt: expiresAt,
      credentialExpiresAt,
      farcasterUsername,
      farcasterFid,
      farcasterChallenge,
      farcasterCastText: castText,
      farcasterChallengeIssuedAt: nowMs,
      farcasterChallengeExpiresAt: expiresAt,
      farcasterCastHash: null,
      normalizedVerificationPostUrl: null,
      verificationPostId: null,
      verificationPostCreatedAt: null,
      finalizedRequestId: null,
      xOwnershipRequestId: null,
      farcasterOwnershipRequestId: null,
      readyForGenLayerAt: null,
      genlayerOutcome: null,
      genlayerErrorCode: null,
      requestExpiresAt: expiresAt,
      revision: row.revision + 1,
      updatedAt: nowMs,
    })
    .where(and(
      eq(verificationRequests.id, row.id),
      eq(verificationRequests.ownerUserId, input.session.subject),
      inArray(verificationRequests.status, ["WALLET_AUTHORIZED", "X_CHALLENGE_ISSUED"]),
      eq(verificationRequests.revision, row.revision),
      gt(verificationRequests.requestExpiresAt, nowMs),
    ))
    .returning();
  if (!updated) stateChanged();
  const request = await requireProjection(input.session.subject, row.id, nowMs);
  return Object.freeze({
    request,
    xChallenge: Object.freeze({
      handle,
      tweetText,
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      credentialExpiresAt: new Date(credentialExpiresAt).toISOString(),
    }),
    farcasterChallenge: Object.freeze({
      username: farcasterUsername,
      fid: farcasterFid,
      castText,
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      credentialExpiresAt: new Date(credentialExpiresAt).toISOString(),
    }),
  });
}

export async function issueFarcasterChallenge(input: {
  session: AuthenticatedWalletSession;
  requestId: string;
  username: unknown;
  fid: unknown;
  nowMs?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const row = await ownedRow(input.session, input.requestId);
  if (row.status !== "WALLET_AUTHORIZED" || row.requestExpiresAt <= nowMs) stateChanged();
  const username = normalizeFarcasterUsername(input.username);
  const fid = positiveDecimal(input.fid, "fid");
  const challenge = `APV2-${makeRandomBase64Url(18)}`;
  const challengeExpiresAt = nowMs + X_CHALLENGE_TTL_MS;
  const credentialExpiresAt = nowMs + CREDENTIAL_TTL_MS;
  const castText = [
    "InfluencedX identity",
    `n=${challenge}`,
    `w=${row.wallet.toLowerCase()}`,
    `i=${Math.floor(nowMs / 1_000)}`,
    `e=${Math.floor(challengeExpiresAt / 1_000)}`,
    `c=${Math.floor(credentialExpiresAt / 1_000)}`,
  ].join(" ");
  const [updated] = await getDb()
    .update(verificationRequests)
    .set({
      status: "X_CHALLENGE_ISSUED",
      statusUpdatedAt: nowMs,
      identitySource: "FARCASTER",
      handle: username,
      farcasterUsername: username,
      farcasterFid: fid,
      farcasterChallenge: challenge,
      farcasterCastText: castText,
      farcasterChallengeIssuedAt: nowMs,
      farcasterChallengeExpiresAt: challengeExpiresAt,
      farcasterCastHash: null,
      credentialExpiresAt,
      requestExpiresAt: challengeExpiresAt,
      revision: row.revision + 1,
      updatedAt: nowMs,
    })
    .where(and(
      eq(verificationRequests.id, row.id),
      eq(verificationRequests.ownerUserId, input.session.subject),
      eq(verificationRequests.status, "WALLET_AUTHORIZED"),
      eq(verificationRequests.revision, row.revision),
      gt(verificationRequests.requestExpiresAt, nowMs),
    ))
    .returning();
  if (!updated) stateChanged();
  const request = await requireProjection(input.session.subject, row.id, nowMs);
  return Object.freeze({
    request,
    farcasterChallenge: Object.freeze({
      username,
      fid,
      castText,
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(challengeExpiresAt).toISOString(),
      credentialExpiresAt: new Date(credentialExpiresAt).toISOString(),
    }),
  });
}

export async function prepareGenLayerIdentityBundleActivation(input: {
  session: AuthenticatedWalletSession;
  requestId: string;
  verificationPostUrl: unknown;
  castHash: unknown;
  nowMs?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const row = await ownedRow(input.session, input.requestId);
  if (row.status !== "X_CHALLENGE_ISSUED" || row.requestExpiresAt <= nowMs) {
    stateChanged();
  }
  if (!ownershipOutcomeAllowsRetry(row.genlayerOutcome)) {
    throw problem(
      409,
      "ACTIVATION_OUTCOME_TERMINAL",
      "This identity bundle already has a terminal GenLayer outcome.",
    );
  }
  if (
    !row.handle ||
    !row.xChallenge ||
    !row.farcasterUsername ||
    !row.farcasterFid ||
    !row.farcasterChallenge
  ) {
    throw problem(
      409,
      "IDENTITY_BUNDLE_INCOMPLETE",
      "Create both identity challenges before preparing activation.",
    );
  }
  const envelope = prepareIdentityBundleEnvelope(row, {
    verificationPostUrl: input.verificationPostUrl,
    castHash: input.castHash,
    nowMs,
  });
  if (
    row.activationPreparedId &&
    (row.verificationPostId !== envelope.x.contentId ||
      row.farcasterCastHash !== envelope.farcaster.contentId)
  ) {
    throw problem(
      409,
      "ACTIVATION_ALREADY_PREPARED",
      "Resume the prepared activation; its published evidence cannot be replaced.",
    );
  }
  const call = identityBundleActivationCall(row, envelope);
  const prepared = await prepareGenLayerMarketplaceTransaction({
    operation: "ACTIVATE_IDENTITY_BUNDLE",
    call,
    actorWallet: row.wallet,
    onchainEntityId: envelope.bundleRequestId,
    reuseFinalized: row.genlayerOutcome !== "UNDETERMINED",
    nowMs,
  });
  const [updated] = await getDb()
    .update(verificationRequests)
    .set({
      identitySource: null,
      normalizedVerificationPostUrl: envelope.x.normalizedUrl,
      verificationPostId: envelope.x.contentId,
      verificationPostCreatedAt: envelope.x.contentCreatedAtMs,
      farcasterCastHash: envelope.farcaster.contentId,
      finalizedRequestId: envelope.bundleRequestId,
      xOwnershipRequestId: envelope.x.requestId,
      farcasterOwnershipRequestId: envelope.farcaster.requestId,
      activationPreparedId: prepared.preparedId,
      readyForGenLayerAt: nowMs,
      revision: row.revision + 1,
      updatedAt: nowMs,
    })
    .where(and(
      eq(verificationRequests.id, row.id),
      eq(verificationRequests.ownerUserId, input.session.subject),
      eq(verificationRequests.status, "X_CHALLENGE_ISSUED"),
      eq(verificationRequests.revision, row.revision),
      gt(verificationRequests.requestExpiresAt, nowMs),
    ))
    .returning();
  if (!updated) stateChanged();
  return Object.freeze({
    request: await requireProjection(input.session.subject, row.id, nowMs),
    preparedId: prepared.preparedId,
    bundleRequestId: envelope.bundleRequestId,
    transaction: prepared.call,
  });
}

export async function confirmGenLayerCreatorActivation(input: {
  session: AuthenticatedWalletSession;
  preparedId: unknown;
  txHash: unknown;
  nowMs?: number;
  reconciliationFenceToken?: string;
}) {
  const preparedId = uuid(input.preparedId, "preparedId");
  const prepared = await findGenLayerPreparedTransaction(preparedId);
  if (prepared?.operation === "ACTIVATE_IDENTITY_BUNDLE") {
    return confirmGenLayerIdentityBundleActivation({ ...input, preparedId });
  }
  if (
    prepared?.operation === "ACTIVATE_CREATOR" &&
    prepared.status === "FINALIZED"
  ) {
    return confirmLegacyGenLayerCreatorActivation({ ...input, preparedId });
  }
  if (prepared?.operation === "ACTIVATE_CREATOR") {
    throw problem(
      410,
      "IDENTITY_BUNDLE_REQUIRED",
      "Single-source activation is retired. Start a new bundled verification.",
    );
  }
  preparedMismatch();
}

export async function bindGenLayerIdentityBundleActivationSubmission(input: {
  session: AuthenticatedWalletSession;
  preparedId: unknown;
  txHash: unknown;
  nowMs?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const preparedId = uuid(input.preparedId, "preparedId");
  const transactionHash = hash(input.txHash, "txHash");
  const [row] = await getDb()
    .select()
    .from(verificationRequests)
    .where(and(
      eq(verificationRequests.ownerUserId, input.session.subject),
      eq(verificationRequests.wallet, input.session.wallet.toLowerCase()),
      eq(verificationRequests.activationPreparedId, preparedId),
    ))
    .limit(1);
  const prepared = await findGenLayerPreparedTransaction(preparedId);
  if (
    !row ||
    !prepared ||
    prepared.operation !== "ACTIVATE_IDENTITY_BUNDLE" ||
    prepared.actorWallet !== row.wallet ||
    !row.finalizedRequestId ||
    prepared.onchainEntityId !== row.finalizedRequestId
  ) {
    preparedMismatch();
  }
  const envelope = storedIdentityBundleEnvelope(row, prepared);
  assertPreparedActivation(prepared, identityBundleActivationCall(row, envelope));
  const bound = await bindGenLayerTransactionHash({
    preparedId,
    actorWallet: row.wallet,
    transactionHash,
    nowMs,
  });
  if (!bound || bound.transactionHash !== transactionHash) preparedMismatch();
  return Object.freeze({
    accepted: true as const,
    preparedId,
    txHash: transactionHash,
  });
}

async function confirmLegacyGenLayerCreatorActivation(input: {
  session: AuthenticatedWalletSession;
  preparedId: unknown;
  txHash: unknown;
  nowMs?: number;
  reconciliationFenceToken?: string;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const preparedId = uuid(input.preparedId, "preparedId");
  const transactionHash = hash(input.txHash, "txHash");
  const [row] = await getDb()
    .select()
    .from(verificationRequests)
    .where(and(
      eq(verificationRequests.ownerUserId, input.session.subject),
      eq(verificationRequests.wallet, input.session.wallet.toLowerCase()),
      eq(verificationRequests.activationPreparedId, preparedId),
    ))
    .limit(1);
  if (!row || !row.identitySource || !row.finalizedRequestId) preparedMismatch();
  const prepared = await findGenLayerPreparedTransaction(preparedId);
  if (
    !prepared ||
    prepared.operation !== "ACTIVATE_CREATOR" ||
    prepared.actorWallet !== row.wallet ||
    prepared.onchainEntityId !== row.finalizedRequestId
  ) preparedMismatch();
  const envelope = storedActivationEnvelope(row, row.identitySource, prepared);
  const call = activationCall(row, row.identitySource, envelope);
  assertPreparedActivation(prepared, call);
  const bound = await bindGenLayerTransactionHash({
    preparedId,
    actorWallet: row.wallet,
    transactionHash,
    nowMs,
  });
  if (!bound) preparedMismatch();
  let finalized;
  try {
    finalized = await loadFinalizedMarketplaceTransaction(transactionHash);
    assertTransactionMatchesPreparedCall({ transaction: finalized, call, actorWallet: row.wallet });
  } catch (error) {
    const retryable = error instanceof MarketplaceGenLayerFinalityError && error.retryable;
    await recordGenLayerTransactionStatus({
      preparedId,
      status: retryable ? "ACCEPTED" : "RECONCILIATION_REQUIRED",
      lifecycleStatus: null,
      executionResult: null,
      errorCode: error instanceof MarketplaceGenLayerFinalityError ? error.code : "GENLAYER_TRANSACTION_MISMATCH",
      retryAtMs: retryable ? nowMs + 15_000 : 0,
      nowMs,
      fenceToken: input.reconciliationFenceToken,
    });
    if (error instanceof MarketplaceGenLayerFinalityError) {
      throw problem(retryable ? 202 : 409, error.code, error.message);
    }
    throw problem(409, "GENLAYER_TRANSACTION_MISMATCH", "The finalized activation does not match the prepared call.");
  }
  let ownershipResult;
  try {
    ownershipResult = parseOwnershipResult(
      await readMarketplaceState("get_ownership_result", [row.finalizedRequestId]),
      {
        requestId: row.finalizedRequestId,
        wallet: row.wallet,
        source: row.identitySource,
        handle: row.identitySource === "X" ? normalizeXHandle(row.handle) : normalizeFarcasterUsername(row.farcasterUsername),
        externalUserId: row.identitySource === "FARCASTER" ? positiveDecimal(row.farcasterFid, "fid") : undefined,
        contentId: envelope.contentId,
        issuedAtEpoch: Math.floor(envelope.issuedAtMs / 1_000),
        expiresAtEpoch: Math.floor(envelope.expiresAtMs / 1_000),
        profileExpiresAtEpoch: Math.floor(envelope.profileExpiresAtMs / 1_000),
      },
    );
  } catch {
    corrupt();
  }
  try {
    assertFinalizedOwnershipTiming({
      verifiedAtEpoch: ownershipResult.verifiedAtEpoch,
      finalizedAtEpoch: finalized.finalizedAt,
      preparedAtMs: prepared.createdAt,
      readyForGenLayerAtMs: row.readyForGenLayerAt ?? 0,
      issuedAtMs: envelope.issuedAtMs,
      expiresAtMs: envelope.expiresAtMs,
      profileExpiresAtMs: envelope.profileExpiresAtMs,
    });
  } catch {
    corrupt();
  }
  if (
    ownershipResult.outcome === "VERIFIED" &&
    !Object.values(ownershipResult.checks).every((value) => value === true)
  ) {
    corrupt();
  }
  let identity: GenLayerProfileState | null = null;
  if (ownershipResult.outcome === "VERIFIED") {
    const identityRaw = await readMarketplaceState("get_identity", [
      marketplaceCalldataAddress(row.wallet),
      row.identitySource,
    ]);
    identity = activeIdentity(identityRaw, row.wallet, row.identitySource, row.finalizedRequestId);
    if (
      !identity ||
      identity.identityHash !== ownershipResult.identityHash ||
      identity.externalUserId !== ownershipResult.externalUserId ||
      identity.handle !== ownershipResult.handle ||
      identity.verifiedAtEpoch !== ownershipResult.verifiedAtEpoch ||
      identity.expiresAtEpoch !== ownershipResult.profileExpiresAtEpoch
    ) corrupt();
  }
  const finalizedAtMs = finalized.finalizedAt * 1_000;
  const projectedIdentity = identity
    ? {
        ...identity,
        active: projectIdentityActiveAt({
          contractActive: identity.active,
          expiresAtEpoch: identity.expiresAtEpoch,
          nowMs,
        }),
      }
    : null;
  if (projectedIdentity) {
    await upsertGenLayerProfileProjection({
      contractAddress: marketplaceContractAddress(),
      ownerWallet: projectedIdentity.wallet,
      identityHash: projectedIdentity.identityHash,
      source: projectedIdentity.source,
      handle: projectedIdentity.handle,
      externalUserId: projectedIdentity.externalUserId,
      ownershipRequestId: projectedIdentity.ownershipRequestId,
      activationTxHash: transactionHash,
      publicHandle: projectedIdentity.handle,
      active: projectedIdentity.active,
      verifiedAt: projectedIdentity.verifiedAtEpoch * 1_000,
      expiresAt: projectedIdentity.expiresAtEpoch * 1_000,
      finalizedAt: finalizedAtMs,
      snapshotHash: canonicalHash(identity),
      nowMs,
    });
  }
  await Promise.all([
    updateGenLayerProjectionCursor({
      contractAddress: marketplaceContractAddress(),
      transactionHash,
      finalizedAt: finalizedAtMs,
      snapshotHash: canonicalHash(ownershipResult),
      nowMs,
    }),
    getDb().update(verificationRequests).set({
      activationTxHash: transactionHash,
      activationConfirmedAt: finalizedAtMs,
      genlayerTxHash: transactionHash,
      genlayerOutcome: ownershipResult.outcome,
      genlayerFinalizedAt: finalizedAtMs,
      activeOwnerUserId: ownershipResult.outcome === "UNDETERMINED" ? row.activeOwnerUserId : null,
      activeWallet: ownershipResult.outcome === "UNDETERMINED" ? row.activeWallet : null,
      requestExpiresAt: projectedIdentity
        ? projectedIdentity.expiresAtEpoch * 1_000
        : row.requestExpiresAt,
      revision: row.revision + 1,
      updatedAt: finalizedAtMs,
    }).where(and(
      eq(verificationRequests.id, row.id),
      eq(verificationRequests.ownerUserId, input.session.subject),
      eq(verificationRequests.activationPreparedId, preparedId),
    )),
  ]);
  const journal = await recordGenLayerTransactionStatus({
    preparedId,
    status: "FINALIZED",
    lifecycleStatus: finalized.lifecycleStatus,
    executionResult: finalized.executionResult,
    errorCode: null,
    finalizedAt: finalizedAtMs,
    nowMs,
    fenceToken: input.reconciliationFenceToken,
  });
  if (journal?.status !== "FINALIZED") {
    throw new Error("The finalized activation journal fence was lost.");
  }
  const request = await requireProjection(input.session.subject, row.id, nowMs);
  const retryable = ownershipResult.outcome === "UNDETERMINED" && row.requestExpiresAt > nowMs;
  return Object.freeze({
    request: {
      ...request,
      genlayerOutcome: ownershipResult.outcome,
      genlayerRetryable: retryable,
      genlayerProfileActive: projectedIdentity?.active ?? false,
    },
    profile: projectedIdentity
      ? { ...profileDto(projectedIdentity, transactionHash), outcome: "VERIFIED" as const, retryable: false }
      : Object.freeze({
          active: false,
          source: row.identitySource,
          transactionHash,
          outcome: ownershipResult.outcome,
          retryable,
        }),
  });
}

async function confirmGenLayerIdentityBundleActivation(input: {
  session: AuthenticatedWalletSession;
  preparedId: unknown;
  txHash: unknown;
  nowMs?: number;
  reconciliationFenceToken?: string;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const preparedId = uuid(input.preparedId, "preparedId");
  const transactionHash = hash(input.txHash, "txHash");
  const [row] = await getDb()
    .select()
    .from(verificationRequests)
    .where(and(
      eq(verificationRequests.ownerUserId, input.session.subject),
      eq(verificationRequests.wallet, input.session.wallet.toLowerCase()),
      eq(verificationRequests.activationPreparedId, preparedId),
    ))
    .limit(1);
  if (
    !row ||
    !row.finalizedRequestId ||
    !row.xOwnershipRequestId ||
    !row.farcasterOwnershipRequestId
  ) {
    preparedMismatch();
  }
  const prepared = await findGenLayerPreparedTransaction(preparedId);
  if (
    !prepared ||
    prepared.operation !== "ACTIVATE_IDENTITY_BUNDLE" ||
    prepared.actorWallet !== row.wallet ||
    prepared.onchainEntityId !== row.finalizedRequestId
  ) {
    preparedMismatch();
  }
  const envelope = storedIdentityBundleEnvelope(row, prepared);
  const call = identityBundleActivationCall(row, envelope);
  assertPreparedActivation(prepared, call);
  const bound = await bindGenLayerTransactionHash({
    preparedId,
    actorWallet: row.wallet,
    transactionHash,
    nowMs,
  });
  if (!bound) preparedMismatch();

  let finalized;
  try {
    finalized = await loadFinalizedMarketplaceTransaction(transactionHash);
    assertTransactionMatchesPreparedCall({
      transaction: finalized,
      call,
      actorWallet: row.wallet,
    });
  } catch (error) {
    const retryable =
      error instanceof MarketplaceGenLayerFinalityError && error.retryable;
    await recordGenLayerTransactionStatus({
      preparedId,
      status: retryable ? "ACCEPTED" : "RECONCILIATION_REQUIRED",
      lifecycleStatus: null,
      executionResult: null,
      errorCode:
        error instanceof MarketplaceGenLayerFinalityError
          ? error.code
          : "GENLAYER_TRANSACTION_MISMATCH",
      retryAtMs: retryable ? nowMs + 15_000 : 0,
      nowMs,
      fenceToken: input.reconciliationFenceToken,
    });
    if (error instanceof MarketplaceGenLayerFinalityError) {
      throw problem(retryable ? 202 : 409, error.code, error.message);
    }
    throw problem(
      409,
      "GENLAYER_TRANSACTION_MISMATCH",
      "The finalized identity activation does not match the prepared call.",
    );
  }

  let bundleResult;
  try {
    bundleResult = parseIdentityBundleResult(
      await readMarketplaceState("get_ownership_result", [
        envelope.bundleRequestId,
      ]),
      {
        requestId: envelope.bundleRequestId,
        wallet: row.wallet,
        xRequestId: envelope.x.requestId,
        farcasterRequestId: envelope.farcaster.requestId,
      },
    );
    for (const child of [envelope.x, envelope.farcaster]) {
      assertFinalizedOwnershipTiming({
        verifiedAtEpoch: bundleResult.verifiedAtEpoch,
        finalizedAtEpoch: finalized.finalizedAt,
        preparedAtMs: prepared.createdAt,
        readyForGenLayerAtMs: row.readyForGenLayerAt ?? 0,
        issuedAtMs: child.issuedAtMs,
        expiresAtMs: child.expiresAtMs,
        profileExpiresAtMs: child.profileExpiresAtMs,
      });
    }
  } catch {
    corrupt();
  }

  let xResult: ReturnType<typeof parseOwnershipResult> | null = null;
  let farcasterResult: ReturnType<typeof parseOwnershipResult> | null = null;
  if (bundleResult.outcome !== "UNDETERMINED") {
    try {
      const [xRaw, farcasterRaw] = await Promise.all([
        readMarketplaceState("get_ownership_result", [envelope.x.requestId]),
        readMarketplaceState("get_ownership_result", [envelope.farcaster.requestId]),
      ]);
      const xExpected = {
        requestId: envelope.x.requestId,
        wallet: row.wallet,
        source: "X",
        handle: normalizeXHandle(row.handle),
        contentId: envelope.x.contentId,
        issuedAtEpoch: Math.floor(envelope.x.issuedAtMs / 1_000),
        expiresAtEpoch: Math.floor(envelope.x.expiresAtMs / 1_000),
        profileExpiresAtEpoch: Math.floor(envelope.x.profileExpiresAtMs / 1_000),
      } as const;
      const farcasterExpected = {
        requestId: envelope.farcaster.requestId,
        wallet: row.wallet,
        source: "FARCASTER",
        handle: normalizeFarcasterUsername(row.farcasterUsername),
        externalUserId: positiveDecimal(row.farcasterFid, "fid"),
        contentId: envelope.farcaster.contentId,
        issuedAtEpoch: Math.floor(envelope.farcaster.issuedAtMs / 1_000),
        expiresAtEpoch: Math.floor(envelope.farcaster.expiresAtMs / 1_000),
        profileExpiresAtEpoch: Math.floor(
          envelope.farcaster.profileExpiresAtMs / 1_000,
        ),
      } as const;
      if (bundleResult.outcome === "REJECTED") {
        xResult = parseRejectedBundleOwnershipResult(xRaw, {
          ...xExpected,
          bundleRequestId: envelope.bundleRequestId,
          evidenceOutcome: bundleResult.xOutcome,
        });
        farcasterResult = parseRejectedBundleOwnershipResult(farcasterRaw, {
          ...farcasterExpected,
          bundleRequestId: envelope.bundleRequestId,
          evidenceOutcome: bundleResult.farcasterOutcome,
        });
      } else {
        xResult = parseOwnershipResult(xRaw, xExpected);
        farcasterResult = parseOwnershipResult(farcasterRaw, farcasterExpected);
      }
      if (
        (bundleResult.outcome === "VERIFIED" &&
          (xResult.outcome !== bundleResult.xOutcome ||
            farcasterResult.outcome !== bundleResult.farcasterOutcome)) ||
        xResult.verifiedAtEpoch !== bundleResult.verifiedAtEpoch ||
        farcasterResult.verifiedAtEpoch !== bundleResult.verifiedAtEpoch ||
        (xResult.outcome === "VERIFIED" &&
          !Object.values(xResult.checks).every(Boolean)) ||
        (farcasterResult.outcome === "VERIFIED" &&
          !Object.values(farcasterResult.checks).every(Boolean))
      ) {
        corrupt();
      }
    } catch {
      corrupt();
    }
  }

  let xIdentity: GenLayerProfileState | null = null;
  let farcasterIdentity: GenLayerProfileState | null = null;
  if (bundleResult.outcome === "VERIFIED") {
    try {
      const [xRaw, farcasterRaw] = await Promise.all([
        readMarketplaceState("get_identity", [
          marketplaceCalldataAddress(row.wallet),
          "X",
        ]),
        readMarketplaceState("get_identity", [
          marketplaceCalldataAddress(row.wallet),
          "FARCASTER",
        ]),
      ]);
      xIdentity = activeIdentity(
        xRaw,
        row.wallet,
        "X",
        envelope.x.requestId,
      );
      farcasterIdentity = activeIdentity(
        farcasterRaw,
        row.wallet,
        "FARCASTER",
        envelope.farcaster.requestId,
      );
      if (
        !xIdentity ||
        !farcasterIdentity ||
        !xResult ||
        !farcasterResult ||
        !identityMatchesOwnership(xIdentity, xResult) ||
        !identityMatchesOwnership(farcasterIdentity, farcasterResult)
      ) {
        corrupt();
      }
    } catch {
      corrupt();
    }
  }

  const project = (identity: GenLayerProfileState | null) =>
    identity
      ? {
          ...identity,
          active: projectIdentityActiveAt({
            contractActive: identity.active,
            expiresAtEpoch: identity.expiresAtEpoch,
            nowMs,
          }),
        }
      : null;
  const projectedX = project(xIdentity);
  const projectedFarcaster = project(farcasterIdentity);
  const finalizedAtMs = finalized.finalizedAt * 1_000;
  const projectionWrites = [projectedX, projectedFarcaster]
    .filter((identity): identity is NonNullable<typeof identity> => Boolean(identity))
    .map((identity) =>
      upsertGenLayerProfileProjection({
        contractAddress: marketplaceContractAddress(),
        ownerWallet: identity.wallet,
        identityHash: identity.identityHash,
        source: identity.source,
        handle: identity.handle,
        externalUserId: identity.externalUserId,
        ownershipRequestId: identity.ownershipRequestId,
        activationTxHash: transactionHash,
        publicHandle: identity.handle,
        active: identity.active,
        verifiedAt: identity.verifiedAtEpoch * 1_000,
        expiresAt: identity.expiresAtEpoch * 1_000,
        finalizedAt: finalizedAtMs,
        snapshotHash: canonicalHash(identity),
        nowMs,
      }),
    );
  await Promise.all([
    ...projectionWrites,
    updateGenLayerProjectionCursor({
      contractAddress: marketplaceContractAddress(),
      transactionHash,
      finalizedAt: finalizedAtMs,
      snapshotHash: canonicalHash({
        bundle: bundleResult,
        x: xResult,
        farcaster: farcasterResult,
      }),
      nowMs,
    }),
    getDb()
      .update(verificationRequests)
      .set({
        activationTxHash: transactionHash,
        activationConfirmedAt: finalizedAtMs,
        genlayerTxHash: transactionHash,
        genlayerOutcome: bundleResult.outcome,
        genlayerFinalizedAt: finalizedAtMs,
        activeOwnerUserId:
          bundleResult.outcome === "UNDETERMINED" ? row.activeOwnerUserId : null,
        activeWallet:
          bundleResult.outcome === "UNDETERMINED" ? row.activeWallet : null,
        requestExpiresAt:
          projectedX && projectedFarcaster
            ? Math.min(
                projectedX.expiresAtEpoch,
                projectedFarcaster.expiresAtEpoch,
              ) * 1_000
            : row.requestExpiresAt,
        revision: row.revision + 1,
        updatedAt: finalizedAtMs,
      })
      .where(and(
        eq(verificationRequests.id, row.id),
        eq(verificationRequests.ownerUserId, input.session.subject),
        eq(verificationRequests.activationPreparedId, preparedId),
      )),
  ]);
  const journal = await recordGenLayerTransactionStatus({
    preparedId,
    status: "FINALIZED",
    lifecycleStatus: finalized.lifecycleStatus,
    executionResult: finalized.executionResult,
    errorCode: null,
    finalizedAt: finalizedAtMs,
    nowMs,
    fenceToken: input.reconciliationFenceToken,
  });
  if (journal?.status !== "FINALIZED") {
    throw new Error("The finalized identity bundle journal fence was lost.");
  }
  const request = await requireProjection(input.session.subject, row.id, nowMs);
  const retryable =
    bundleResult.outcome === "UNDETERMINED" && row.requestExpiresAt > nowMs;
  return Object.freeze({
    request: {
      ...request,
      genlayerOutcome: bundleResult.outcome,
      genlayerRetryable: retryable,
      genlayerProfileActive: Boolean(
        projectedX?.active && projectedFarcaster?.active,
      ),
    },
    profiles: Object.freeze({
      x: projectedX ? profileDto(projectedX, transactionHash) : null,
      farcaster: projectedFarcaster
        ? profileDto(projectedFarcaster, transactionHash)
        : null,
    }),
    bundle: Object.freeze({
      requestId: bundleResult.requestId,
      outcome: bundleResult.outcome,
      retryable,
      transactionHash,
    }),
  });
}

/** Replays a bound activation journal without accepting browser identity data. */
export async function reconcileGenLayerCreatorActivationJournal(input: {
  preparedId: string;
  transactionHash: string;
  actorWallet: string;
  fenceToken: string;
  nowMs: number;
}) {
  const [row] = await getDb()
    .select({
      ownerUserId: verificationRequests.ownerUserId,
      wallet: verificationRequests.wallet,
    })
    .from(verificationRequests)
    .where(and(
      eq(verificationRequests.activationPreparedId, input.preparedId),
      eq(verificationRequests.wallet, input.actorWallet.toLowerCase()),
    ))
    .limit(1);
  if (!row) preparedMismatch();
  const nowEpoch = Math.floor(input.nowMs / 1_000);
  return confirmGenLayerCreatorActivation({
    session: {
      version: 1,
      subject: row.ownerUserId,
      stage: "authenticated",
      wallet: row.wallet,
      issuedAt: nowEpoch,
      expiresAt: nowEpoch + 15 * 60,
    },
    preparedId: input.preparedId,
    txHash: input.transactionHash,
    nowMs: input.nowMs,
    reconciliationFenceToken: input.fenceToken,
  });
}

export async function getGenLayerVerificationStatus(input: {
  ownerUserId: string;
  requestId?: string;
  nowMs?: number;
}) {
  const nativeRequest = await getNativeVerificationStatus(input);
  const request = nativeRequest
    ? {
        ...nativeRequest,
        activationRecovery: await activationRecoveryForRequest(nativeRequest),
      }
    : null;
  if (
    request?.activationTxHash &&
    request.xOwnershipRequestId &&
    request.farcasterOwnershipRequestId
  ) {
    const retryable =
      request.genlayerOutcome === "UNDETERMINED" &&
      Math.min(
        Date.parse(request.xChallengeExpiresAt ?? ""),
        Date.parse(request.farcasterChallengeExpiresAt ?? ""),
      ) > (input.nowMs ?? Date.now());
    if (request.genlayerOutcome !== "VERIFIED") {
      return {
        ...request,
        genlayerRetryable: retryable,
        genlayerProfileActive: false,
        genlayerProfileIds: { x: null, farcaster: null },
        genlayerProfileExpiresAt: null,
      };
    }
    try {
      const [xRaw, farcasterRaw] = await Promise.all([
        readMarketplaceState("get_identity", [
          marketplaceCalldataAddress(request.wallet),
          "X",
        ]),
        readMarketplaceState("get_identity", [
          marketplaceCalldataAddress(request.wallet),
          "FARCASTER",
        ]),
      ]);
      const x = activeIdentity(
        xRaw,
        request.wallet,
        "X",
        request.xOwnershipRequestId,
      );
      const farcaster = activeIdentity(
        farcasterRaw,
        request.wallet,
        "FARCASTER",
        request.farcasterOwnershipRequestId,
      );
      const nowMs = input.nowMs ?? Date.now();
      const xActive = x
        ? projectIdentityActiveAt({
            contractActive: x.active,
            expiresAtEpoch: x.expiresAtEpoch,
            nowMs,
          })
        : false;
      const farcasterActive = farcaster
        ? projectIdentityActiveAt({
            contractActive: farcaster.active,
            expiresAtEpoch: farcaster.expiresAtEpoch,
            nowMs,
          })
        : false;
      return {
        ...request,
        genlayerProfileIds: {
          x: x?.identityHash ?? null,
          farcaster: farcaster?.identityHash ?? null,
        },
        genlayerProfileActive: xActive && farcasterActive,
        genlayerRetryable: false,
        genlayerProfileExpiresAt:
          x && farcaster
            ? new Date(
                Math.min(x.expiresAtEpoch, farcaster.expiresAtEpoch) * 1_000,
              ).toISOString()
            : null,
      };
    } catch {
      return {
        ...request,
        genlayerProfileActive: false,
        genlayerRetryable: false,
      };
    }
  }
  if (!request?.activationTxHash || !request.source) return request;
  if (request.genlayerOutcome !== "VERIFIED") {
    return {
      ...request,
      genlayerRetryable:
        request.genlayerOutcome === "UNDETERMINED" &&
        Date.parse(request.xChallengeExpiresAt ?? request.farcasterChallengeExpiresAt ?? "") > (input.nowMs ?? Date.now()),
      genlayerProfileActive: false,
      genlayerProfileId: null,
      genlayerProfileExpiresAt: null,
    };
  }
  try {
    const raw = await readMarketplaceState("get_identity", [
      marketplaceCalldataAddress(request.wallet),
      request.source,
    ]);
    const identity = activeIdentity(raw, request.wallet, request.source, request.finalizedRequestId ?? "");
    const active = identity
      ? projectIdentityActiveAt({
          contractActive: identity.active,
          expiresAtEpoch: identity.expiresAtEpoch,
          nowMs: input.nowMs ?? Date.now(),
        })
      : false;
    return {
      ...request,
      genlayerProfileId: identity?.identityHash ?? null,
      genlayerProfileActive: active,
      genlayerRetryable: false,
      genlayerProfileExpiresAt: identity
        ? new Date(identity.expiresAtEpoch * 1_000).toISOString()
        : null,
    };
  } catch {
    return { ...request, genlayerProfileActive: false, genlayerRetryable: false };
  }
}

function prepareActivationEnvelope(
  row: VerificationRow,
  source: GenLayerContentSource,
  input: {
    verificationPostUrl?: unknown;
    castHash?: unknown;
    nowMs: number;
  },
): ActivationEnvelope {
  const issuedAtMs = source === "X" ? row.xChallengeIssuedAt : row.farcasterChallengeIssuedAt;
  const expiresAtMs = source === "X" ? row.xChallengeExpiresAt : row.farcasterChallengeExpiresAt;
  const challenge = source === "X" ? row.xChallenge : row.farcasterChallenge;
  if (
    !issuedAtMs ||
    !expiresAtMs ||
    !row.credentialExpiresAt ||
    !challenge ||
    expiresAtMs <= input.nowMs ||
    row.credentialExpiresAt <= input.nowMs
  ) {
    throw problem(410, "CHALLENGE_EXPIRED", "The identity challenge expired.");
  }
  if (source === "X") {
    if (!row.handle) corrupt();
    let post;
    try {
      post = parseVerificationPostUrl(input.verificationPostUrl);
    } catch {
      throw problem(
        400,
        "INVALID_X_POST_URL",
        "Enter the HTTPS x.com or twitter.com URL for the published challenge post.",
      );
    }
    if (post.handle !== row.handle) {
      throw problem(422, "HANDLE_MISMATCH", "The X post URL does not match the challenged handle.");
    }
    validateStoredActivationTiming({
      issuedAtMs,
      expiresAtMs,
      profileExpiresAtMs: row.credentialExpiresAt,
      preparedAtMs: input.nowMs,
      readyForGenLayerAtMs: input.nowMs,
      contentCreatedAtMs: post.createdAtMs,
    });
    return {
      requestId: deriveOwnershipRequestId({
        wallet: row.wallet,
        handle: row.handle,
        postId: post.postId,
        challenge,
        issuedAtEpoch: Math.floor(issuedAtMs / 1_000),
        expiresAtEpoch: Math.floor(expiresAtMs / 1_000),
        profileExpiresAtEpoch: Math.floor(row.credentialExpiresAt / 1_000),
      }),
      contentId: post.postId,
      normalizedUrl: post.normalizedUrl,
      contentCreatedAtMs: post.createdAtMs,
      challenge,
      issuedAtMs,
      expiresAtMs,
      profileExpiresAtMs: row.credentialExpiresAt,
    };
  }
  const username = normalizeFarcasterUsername(row.farcasterUsername);
  const fid = positiveDecimal(row.farcasterFid, "fid");
  const castHash = input.castHash;
  if (typeof castHash !== "string" || !FARCASTER_HASH.test(castHash.trim().toLowerCase())) {
    throw problem(400, "INVALID_FARCASTER_CAST_HASH", "castHash must be a 0x-prefixed 20-byte Farcaster cast hash.");
  }
  const contentId = castHash.trim().toLowerCase();
  validateStoredActivationTiming({
    issuedAtMs,
    expiresAtMs,
    profileExpiresAtMs: row.credentialExpiresAt,
    preparedAtMs: input.nowMs,
    readyForGenLayerAtMs: input.nowMs,
    contentCreatedAtMs: null,
  });
  return {
    requestId: deriveFarcasterOwnershipRequestId({
      wallet: row.wallet,
      username,
      fid,
      castHash: contentId,
      challenge,
      issuedAtEpoch: Math.floor(issuedAtMs / 1_000),
      expiresAtEpoch: Math.floor(expiresAtMs / 1_000),
      profileExpiresAtEpoch: Math.floor(row.credentialExpiresAt / 1_000),
    }),
    contentId,
    normalizedUrl: null,
    contentCreatedAtMs: null,
    challenge,
    issuedAtMs,
    expiresAtMs,
    profileExpiresAtMs: row.credentialExpiresAt,
  };
}

function prepareIdentityBundleEnvelope(
  row: VerificationRow,
  input: {
    verificationPostUrl: unknown;
    castHash: unknown;
    nowMs: number;
  },
): IdentityBundleEnvelope {
  const x = prepareActivationEnvelope(row, "X", input);
  const farcaster = prepareActivationEnvelope(row, "FARCASTER", input);
  return Object.freeze({
    bundleRequestId: deriveIdentityBundleRequestId({
      wallet: row.wallet,
      xRequestId: x.requestId,
      farcasterRequestId: farcaster.requestId,
    }),
    x,
    farcaster,
  });
}

function storedIdentityBundleEnvelope(
  row: VerificationRow,
  prepared: GenLayerTransactionRow,
): IdentityBundleEnvelope {
  const expectedArgTypes = [
    "string",
    "string",
    "string",
    "string",
    "string",
    "uint256",
    "uint256",
    "uint256",
    "string",
    "string",
    "uint256",
    "string",
    "string",
    "uint256",
    "uint256",
    "uint256",
  ];
  if (
    prepared.network !== MARKETPLACE_GENLAYER_NETWORK ||
    prepared.chainId !== MARKETPLACE_GENLAYER_CHAIN_ID ||
    prepared.contractAddress !== marketplaceContractAddress().toLowerCase() ||
    prepared.operation !== "ACTIVATE_IDENTITY_BUNDLE" ||
    prepared.functionName !== "activate_identity_bundle" ||
    prepared.actorWallet !== row.wallet ||
    prepared.localCampaignId !== null ||
    prepared.localApplicationId !== null ||
    prepared.valueAtto !== "0" ||
    !Array.isArray(prepared.args) ||
    prepared.args.length !== expectedArgTypes.length ||
    prepared.argTypes.length !== expectedArgTypes.length ||
    prepared.argTypes.some((value, index) => value !== expectedArgTypes[index])
  ) {
    preparedMismatch();
  }
  const args = prepared.args;
  const bundleRequestId = storedHashArg(args[0]);
  const xRequestId = storedHashArg(args[1]);
  const xHandle = normalizeXHandle(storedTextArg(args[2]));
  const xPostId = storedTextArg(args[3]);
  const xChallenge = storedTextArg(args[4]);
  const xIssuedAtEpoch = storedUintArg(args[5]);
  const xExpiresAtEpoch = storedUintArg(args[6]);
  const xProfileExpiresAtEpoch = storedUintArg(args[7]);
  const farcasterRequestId = storedHashArg(args[8]);
  const farcasterUsername = normalizeFarcasterUsername(storedTextArg(args[9]));
  const farcasterFid = storedUintArg(args[10]);
  const farcasterCastHash = storedTextArg(args[11]).toLowerCase();
  const farcasterChallenge = storedTextArg(args[12]);
  const farcasterIssuedAtEpoch = storedUintArg(args[13]);
  const farcasterExpiresAtEpoch = storedUintArg(args[14]);
  const farcasterProfileExpiresAtEpoch = storedUintArg(args[15]);
  const xPost = storedXPost(row);
  if (
    !row.xChallengeIssuedAt ||
    !row.xChallengeExpiresAt ||
    !row.farcasterChallengeIssuedAt ||
    !row.farcasterChallengeExpiresAt ||
    !row.credentialExpiresAt ||
    !row.readyForGenLayerAt ||
    !row.xChallenge ||
    !row.farcasterChallenge ||
    bundleRequestId !== row.finalizedRequestId ||
    bundleRequestId !== prepared.onchainEntityId ||
    xRequestId !== row.xOwnershipRequestId ||
    farcasterRequestId !== row.farcasterOwnershipRequestId ||
    xHandle !== normalizeXHandle(row.handle) ||
    xPostId !== xPost.postId ||
    xChallenge !== row.xChallenge ||
    farcasterUsername !== normalizeFarcasterUsername(row.farcasterUsername) ||
    farcasterFid !== positiveDecimal(row.farcasterFid, "fid") ||
    !FARCASTER_HASH.test(farcasterCastHash) ||
    farcasterCastHash !== row.farcasterCastHash ||
    farcasterChallenge !== row.farcasterChallenge ||
    xIssuedAtEpoch !== String(Math.floor(row.xChallengeIssuedAt / 1_000)) ||
    xExpiresAtEpoch !== String(Math.floor(row.xChallengeExpiresAt / 1_000)) ||
    xProfileExpiresAtEpoch !== String(Math.floor(row.credentialExpiresAt / 1_000)) ||
    farcasterIssuedAtEpoch !==
      String(Math.floor(row.farcasterChallengeIssuedAt / 1_000)) ||
    farcasterExpiresAtEpoch !==
      String(Math.floor(row.farcasterChallengeExpiresAt / 1_000)) ||
    farcasterProfileExpiresAtEpoch !==
      String(Math.floor(row.credentialExpiresAt / 1_000))
  ) {
    preparedMismatch();
  }
  const x: ActivationEnvelope = {
    requestId: xRequestId,
    contentId: xPostId,
    normalizedUrl: xPost.normalizedUrl,
    contentCreatedAtMs: xPost.createdAtMs,
    challenge: xChallenge,
    issuedAtMs: row.xChallengeIssuedAt,
    expiresAtMs: row.xChallengeExpiresAt,
    profileExpiresAtMs: row.credentialExpiresAt,
  };
  const farcaster: ActivationEnvelope = {
    requestId: farcasterRequestId,
    contentId: farcasterCastHash,
    normalizedUrl: null,
    contentCreatedAtMs: null,
    challenge: farcasterChallenge,
    issuedAtMs: row.farcasterChallengeIssuedAt,
    expiresAtMs: row.farcasterChallengeExpiresAt,
    profileExpiresAtMs: row.credentialExpiresAt,
  };
  try {
    for (const child of [x, farcaster]) {
      validateStoredActivationTiming({
        issuedAtMs: child.issuedAtMs,
        expiresAtMs: child.expiresAtMs,
        profileExpiresAtMs: child.profileExpiresAtMs,
        preparedAtMs: prepared.createdAt,
        readyForGenLayerAtMs: row.readyForGenLayerAt,
        contentCreatedAtMs: child.contentCreatedAtMs,
      });
    }
    if (
      deriveOwnershipRequestId({
        wallet: row.wallet,
        handle: xHandle,
        postId: x.contentId,
        challenge: x.challenge,
        issuedAtEpoch: Number(xIssuedAtEpoch),
        expiresAtEpoch: Number(xExpiresAtEpoch),
        profileExpiresAtEpoch: Number(xProfileExpiresAtEpoch),
      }) !== xRequestId ||
      deriveFarcasterOwnershipRequestId({
        wallet: row.wallet,
        username: farcasterUsername,
        fid: farcasterFid,
        castHash: farcaster.contentId,
        challenge: farcaster.challenge,
        issuedAtEpoch: Number(farcasterIssuedAtEpoch),
        expiresAtEpoch: Number(farcasterExpiresAtEpoch),
        profileExpiresAtEpoch: Number(farcasterProfileExpiresAtEpoch),
      }) !== farcasterRequestId ||
      deriveIdentityBundleRequestId({
        wallet: row.wallet,
        xRequestId,
        farcasterRequestId,
      }) !== bundleRequestId
    ) {
      preparedMismatch();
    }
  } catch {
    preparedMismatch();
  }
  return Object.freeze({ bundleRequestId, x, farcaster });
}

function storedActivationEnvelope(
  row: VerificationRow,
  source: GenLayerContentSource,
  prepared: GenLayerTransactionRow,
): ActivationEnvelope {
  if (
    prepared.network !== MARKETPLACE_GENLAYER_NETWORK ||
    prepared.chainId !== MARKETPLACE_GENLAYER_CHAIN_ID ||
    prepared.contractAddress !== marketplaceContractAddress().toLowerCase() ||
    prepared.operation !== "ACTIVATE_CREATOR" ||
    prepared.actorWallet !== row.wallet ||
    prepared.localCampaignId !== null ||
    prepared.localApplicationId !== null ||
    prepared.onchainEntityId !== row.finalizedRequestId ||
    prepared.valueAtto !== "0" ||
    !Array.isArray(prepared.args)
  ) {
    preparedMismatch();
  }
  const expectedFunction = source === "X"
    ? "activate_creator"
    : "activate_farcaster_creator";
  const expectedArgTypes = source === "X"
    ? ["string", "string", "string", "string", "uint256", "uint256", "uint256"]
    : ["string", "string", "uint256", "string", "string", "uint256", "uint256", "uint256"];
  if (
    prepared.functionName !== expectedFunction ||
    prepared.argTypes.length !== expectedArgTypes.length ||
    prepared.argTypes.some((value, index) => value !== expectedArgTypes[index]) ||
    prepared.args.length !== expectedArgTypes.length
  ) {
    preparedMismatch();
  }

  const args = prepared.args;
  const requestId = storedHashArg(args[0]);
  const handle = source === "X"
    ? normalizeXHandle(storedTextArg(args[1]))
    : normalizeFarcasterUsername(storedTextArg(args[1]));
  const fid = source === "FARCASTER" ? storedUintArg(args[2]) : null;
  const contentIndex = source === "X" ? 2 : 3;
  const challengeIndex = source === "X" ? 3 : 4;
  const timeIndex = source === "X" ? 4 : 5;
  const contentId = storedTextArg(args[contentIndex]).toLowerCase();
  const challenge = storedTextArg(args[challengeIndex]);
  const issuedAtEpoch = storedUintArg(args[timeIndex]);
  const expiresAtEpoch = storedUintArg(args[timeIndex + 1]);
  const profileExpiresAtEpoch = storedUintArg(args[timeIndex + 2]);
  const issuedAtMs = source === "X" ? row.xChallengeIssuedAt : row.farcasterChallengeIssuedAt;
  const expiresAtMs = source === "X" ? row.xChallengeExpiresAt : row.farcasterChallengeExpiresAt;
  const persistedChallenge = source === "X" ? row.xChallenge : row.farcasterChallenge;
  if (
    !issuedAtMs ||
    !expiresAtMs ||
    !row.credentialExpiresAt ||
    !row.readyForGenLayerAt ||
    !/^APV2-[A-Za-z0-9_-]{24}$/.test(challenge) ||
    (persistedChallenge !== null && persistedChallenge !== challenge) ||
    issuedAtEpoch !== String(Math.floor(issuedAtMs / 1_000)) ||
    expiresAtEpoch !== String(Math.floor(expiresAtMs / 1_000)) ||
    profileExpiresAtEpoch !== String(Math.floor(row.credentialExpiresAt / 1_000))
  ) {
    preparedMismatch();
  }

  let normalizedUrl: string | null = null;
  let contentCreatedAtMs: number | null = null;
  if (source === "X") {
    const post = storedXPost(row);
    if (handle !== post.handle || contentId !== post.postId) preparedMismatch();
    normalizedUrl = post.normalizedUrl;
    contentCreatedAtMs = post.createdAtMs;
  } else {
    if (
      handle !== normalizeFarcasterUsername(row.farcasterUsername) ||
      fid !== positiveDecimal(row.farcasterFid, "fid") ||
      !FARCASTER_HASH.test(contentId) ||
      contentId !== row.farcasterCastHash
    ) {
      preparedMismatch();
    }
  }

  try {
    validateStoredActivationTiming({
      issuedAtMs,
      expiresAtMs,
      profileExpiresAtMs: row.credentialExpiresAt,
      preparedAtMs: prepared.createdAt,
      readyForGenLayerAtMs: row.readyForGenLayerAt,
      contentCreatedAtMs,
    });
  } catch {
    preparedMismatch();
  }
  const derivedRequestId = source === "X"
    ? deriveOwnershipRequestId({
        wallet: row.wallet,
        handle,
        postId: contentId,
        challenge,
        issuedAtEpoch: Number(issuedAtEpoch),
        expiresAtEpoch: Number(expiresAtEpoch),
        profileExpiresAtEpoch: Number(profileExpiresAtEpoch),
      })
    : deriveFarcasterOwnershipRequestId({
        wallet: row.wallet,
        username: handle,
        fid: fid!,
        castHash: contentId,
        challenge,
        issuedAtEpoch: Number(issuedAtEpoch),
        expiresAtEpoch: Number(expiresAtEpoch),
        profileExpiresAtEpoch: Number(profileExpiresAtEpoch),
      });
  if (requestId !== row.finalizedRequestId || derivedRequestId !== requestId) {
    preparedMismatch();
  }
  return {
    requestId,
    contentId,
    normalizedUrl,
    contentCreatedAtMs,
    challenge,
    issuedAtMs,
    expiresAtMs,
    profileExpiresAtMs: row.credentialExpiresAt,
  };
}

export function validateStoredActivationTiming(input: {
  issuedAtMs: number;
  expiresAtMs: number;
  profileExpiresAtMs: number;
  preparedAtMs: number;
  readyForGenLayerAtMs: number;
  contentCreatedAtMs: number | null;
}): void {
  const values = [
    input.issuedAtMs,
    input.expiresAtMs,
    input.profileExpiresAtMs,
    input.preparedAtMs,
    input.readyForGenLayerAtMs,
  ];
  if (
    !values.every((value) => Number.isSafeInteger(value) && value > 0) ||
    input.expiresAtMs - input.issuedAtMs !== X_CHALLENGE_TTL_MS ||
    input.profileExpiresAtMs - input.issuedAtMs !== CREDENTIAL_TTL_MS ||
    input.preparedAtMs < input.issuedAtMs ||
    input.preparedAtMs >= input.expiresAtMs ||
    input.readyForGenLayerAtMs < input.preparedAtMs ||
    input.readyForGenLayerAtMs >= input.expiresAtMs ||
    input.readyForGenLayerAtMs >= input.profileExpiresAtMs
  ) {
    throw new Error("The persisted activation timing is invalid.");
  }
  if (input.contentCreatedAtMs !== null) {
    if (!Number.isSafeInteger(input.contentCreatedAtMs) || input.contentCreatedAtMs <= 0) {
      throw new Error("The persisted activation content timestamp is invalid.");
    }
    validateVerificationPostTiming({
      postCreatedAtMs: input.contentCreatedAtMs,
      challengeIssuedAtMs: input.issuedAtMs,
      challengeExpiresAtMs: input.expiresAtMs,
      credentialExpiresAtMs: input.profileExpiresAtMs,
      nowMs: input.preparedAtMs,
    });
  }
}

export function assertFinalizedOwnershipTiming(input: {
  verifiedAtEpoch: number;
  finalizedAtEpoch: number;
  preparedAtMs: number;
  readyForGenLayerAtMs: number;
  issuedAtMs: number;
  expiresAtMs: number;
  profileExpiresAtMs: number;
}): void {
  const issuedAtEpoch = Math.floor(input.issuedAtMs / 1_000);
  const expiresAtEpoch = Math.floor(input.expiresAtMs / 1_000);
  const profileExpiresAtEpoch = Math.floor(input.profileExpiresAtMs / 1_000);
  const preparedAtEpoch = Math.floor(input.preparedAtMs / 1_000);
  const readyForGenLayerAtEpoch = Math.floor(input.readyForGenLayerAtMs / 1_000);
  if (
    !Number.isSafeInteger(input.verifiedAtEpoch) ||
    !Number.isSafeInteger(input.finalizedAtEpoch) ||
    !Number.isSafeInteger(input.preparedAtMs) ||
    !Number.isSafeInteger(input.readyForGenLayerAtMs) ||
    input.verifiedAtEpoch !== input.finalizedAtEpoch ||
    input.finalizedAtEpoch < preparedAtEpoch ||
    input.finalizedAtEpoch < readyForGenLayerAtEpoch ||
    input.verifiedAtEpoch < issuedAtEpoch ||
    input.verifiedAtEpoch > expiresAtEpoch ||
    input.verifiedAtEpoch >= profileExpiresAtEpoch
  ) {
    throw new Error("The finalized ownership result timing is invalid.");
  }
}

export function projectIdentityActiveAt(input: {
  contractActive: boolean;
  expiresAtEpoch: number;
  nowMs: number;
}): boolean {
  return (
    input.contractActive &&
    Number.isSafeInteger(input.expiresAtEpoch) &&
    input.expiresAtEpoch > 0 &&
    Number.isSafeInteger(input.nowMs) &&
    input.nowMs < input.expiresAtEpoch * 1_000
  );
}

function assertPreparedActivation(
  prepared: GenLayerTransactionRow,
  call: MarketplaceGenLayerCall,
): void {
  if (
    prepared.network !== call.network ||
    prepared.chainId !== call.chainId ||
    prepared.contractAddress !== call.contractAddress.toLowerCase() ||
    prepared.functionName !== call.functionName ||
    prepared.valueAtto !== call.value ||
    prepared.argTypes.length !== call.argTypes.length ||
    prepared.argTypes.some((value, index) => value !== call.argTypes[index]) ||
    prepared.argsHash !== canonicalHash(prepared.args) ||
    prepared.argsHash !== canonicalHash(call.args)
  ) {
    preparedMismatch();
  }
}

function storedTextArg(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    preparedMismatch();
  }
  return value;
}

function storedHashArg(value: unknown): string {
  const normalized = storedTextArg(value).toLowerCase();
  if (!TX_HASH.test(normalized)) preparedMismatch();
  return normalized;
}

function storedUintArg(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,77})$/.test(value) ||
    BigInt(value) >= 1n << 256n
  ) {
    preparedMismatch();
  }
  return value;
}

function activationCall(
  row: VerificationRow,
  source: GenLayerContentSource,
  envelope: ActivationEnvelope,
): MarketplaceGenLayerCall {
  const common = [
    envelope.challenge,
    BigInt(Math.floor(envelope.issuedAtMs / 1_000)),
    BigInt(Math.floor(envelope.expiresAtMs / 1_000)),
    BigInt(Math.floor(envelope.profileExpiresAtMs / 1_000)),
  ] as const;
  return source === "X"
    ? {
        network: MARKETPLACE_GENLAYER_NETWORK,
        chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
        contractAddress: marketplaceContractAddress(),
        functionName: "activate_creator",
        args: [envelope.requestId, row.handle!, envelope.contentId, ...common],
        argTypes: ["string", "string", "string", "string", "uint256", "uint256", "uint256"],
        value: "0",
      }
    : {
        network: MARKETPLACE_GENLAYER_NETWORK,
        chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
        contractAddress: marketplaceContractAddress(),
        functionName: "activate_farcaster_creator",
        args: [
          envelope.requestId,
          row.farcasterUsername!,
          BigInt(row.farcasterFid!),
          envelope.contentId,
          ...common,
        ],
        argTypes: ["string", "string", "uint256", "string", "string", "uint256", "uint256", "uint256"],
        value: "0",
      };
}

function identityBundleActivationCall(
  row: VerificationRow,
  envelope: IdentityBundleEnvelope,
): MarketplaceGenLayerCall {
  return Object.freeze({
    network: MARKETPLACE_GENLAYER_NETWORK,
    chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
    contractAddress: marketplaceContractAddress(),
    functionName: "activate_identity_bundle",
    args: [
      envelope.bundleRequestId,
      envelope.x.requestId,
      normalizeXHandle(row.handle),
      envelope.x.contentId,
      envelope.x.challenge,
      BigInt(Math.floor(envelope.x.issuedAtMs / 1_000)),
      BigInt(Math.floor(envelope.x.expiresAtMs / 1_000)),
      BigInt(Math.floor(envelope.x.profileExpiresAtMs / 1_000)),
      envelope.farcaster.requestId,
      normalizeFarcasterUsername(row.farcasterUsername),
      BigInt(positiveDecimal(row.farcasterFid, "fid")),
      envelope.farcaster.contentId,
      envelope.farcaster.challenge,
      BigInt(Math.floor(envelope.farcaster.issuedAtMs / 1_000)),
      BigInt(Math.floor(envelope.farcaster.expiresAtMs / 1_000)),
      BigInt(Math.floor(envelope.farcaster.profileExpiresAtMs / 1_000)),
    ] as const,
    argTypes: [
      "string",
      "string",
      "string",
      "string",
      "string",
      "uint256",
      "uint256",
      "uint256",
      "string",
      "string",
      "uint256",
      "string",
      "string",
      "uint256",
      "uint256",
      "uint256",
    ] as const,
    value: "0",
  });
}

function activeIdentity(
  value: unknown,
  wallet: string,
  source: GenLayerContentSource,
  requestId: string,
): GenLayerProfileState | null {
  if (!plain(value)) corrupt();
  if (value.exists === false) return null;
  const identity = parseProfileState(value);
  if (
    identity.wallet !== normalizeMarketplaceAddress(wallet, "wallet") ||
    identity.source !== source ||
    identity.ownershipRequestId !== requestId
  ) corrupt();
  return identity;
}

function identityMatchesOwnership(
  identity: GenLayerProfileState,
  ownership: ReturnType<typeof parseOwnershipResult>,
): boolean {
  return (
    identity.wallet === ownership.wallet &&
    identity.source === ownership.source &&
    identity.identityHash === ownership.identityHash &&
    identity.externalUserId === ownership.externalUserId &&
    identity.handle === ownership.handle &&
    identity.verifiedAtEpoch === ownership.verifiedAtEpoch &&
    identity.expiresAtEpoch === ownership.profileExpiresAtEpoch &&
    identity.ownershipRequestId === ownership.requestId
  );
}

function profileDto(identity: GenLayerProfileState, transactionHash: string) {
  return Object.freeze({
    id: identity.identityHash,
    profileId: identity.identityHash,
    source: identity.source,
    handle: identity.handle,
    externalUserId: identity.externalUserId,
    identityHash: identity.identityHash,
    active: identity.active,
    credentialExpiresAt: new Date(identity.expiresAtEpoch * 1_000).toISOString(),
    expiresAt: new Date(identity.expiresAtEpoch * 1_000).toISOString(),
    transactionHash,
  });
}

async function ownedRow(session: AuthenticatedWalletSession, requestId: string) {
  const id = uuid(requestId, "requestId");
  const [row] = await getDb()
    .select()
    .from(verificationRequests)
    .where(and(
      eq(verificationRequests.id, id),
      eq(verificationRequests.ownerUserId, session.subject),
      eq(verificationRequests.wallet, session.wallet.toLowerCase()),
    ))
    .limit(1);
  if (!row) throw problem(404, "VERIFICATION_NOT_FOUND", "Verification request not found.");
  return row;
}

async function requireProjection(ownerUserId: string, requestId: string, nowMs: number): Promise<NativeVerificationProjection> {
  const projection = await getNativeVerificationStatus({ ownerUserId, requestId, nowMs });
  if (!projection) corrupt();
  return projection;
}

async function activationRecoveryForRequest(
  request: NativeVerificationProjection,
): Promise<Readonly<{
  requestId: string;
  preparedId: string;
  txHash: string;
}> | null> {
  if (
    !request.activationPreparedId ||
    !request.finalizedRequestId ||
    request.activationTxHash
  ) {
    return null;
  }
  const prepared = await findGenLayerPreparedTransaction(
    request.activationPreparedId,
  );
  if (
    !prepared ||
    prepared.operation !== "ACTIVATE_IDENTITY_BUNDLE" ||
    prepared.actorWallet !== request.wallet ||
    prepared.onchainEntityId !== request.finalizedRequestId ||
    prepared.contractAddress !== marketplaceContractAddress().toLowerCase() ||
    !prepared.transactionHash ||
    ![
      "SUBMITTED",
      "ACCEPTED",
      "RECONCILIATION_REQUIRED",
      "FINALIZED",
    ].includes(prepared.status)
  ) {
    return null;
  }
  return Object.freeze({
    requestId: request.id,
    preparedId: prepared.preparedId,
    txHash: prepared.transactionHash,
  });
}

function storedXPost(row: VerificationRow) {
  if (!row.normalizedVerificationPostUrl || !row.verificationPostId || !row.verificationPostCreatedAt) corrupt();
  return {
    handle: normalizeXHandle(row.handle),
    postId: row.verificationPostId,
    normalizedUrl: row.normalizedVerificationPostUrl,
    createdAtMs: row.verificationPostCreatedAt,
  };
}

function normalizeFarcasterUsername(value: unknown): string {
  if (typeof value !== "string") throw problem(400, "INVALID_FARCASTER_USERNAME", "username is required.");
  const username = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,15}$/.test(username)) {
    throw problem(400, "INVALID_FARCASTER_USERNAME", "username must be a Farcaster fname.");
  }
  return username;
}

function positiveDecimal(value: unknown, field: string): string {
  const text = typeof value === "bigint" || typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9][0-9]{0,77}$/.test(text) || BigInt(text) >= 1n << 256n) {
    throw problem(400, "INVALID_FARCASTER_FID", `${field} must be a positive integer.`);
  }
  return text;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw problem(400, "INVALID_REQUEST", `${field} is invalid.`);
  return value.toLowerCase();
}

function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !TX_HASH.test(value.toLowerCase())) {
    throw problem(400, "INVALID_REQUEST", `${field} is invalid.`);
  }
  return value.toLowerCase();
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function problem(status: number, code: string, message: string) {
  return new ApiProblem(status, code, message);
}

function preparedMismatch(): never {
  throw problem(409, "PREPARED_TRANSACTION_MISMATCH", "The activation transaction is not bound to this verification request.");
}

function stateChanged(): never {
  throw problem(409, "STATE_CHANGED", "The verification state changed. Refresh before continuing.");
}

function corrupt(): never {
  throw problem(503, "GENLAYER_PROFILE_STATE_INVALID", "The StudioNet identity state could not be verified.");
}
