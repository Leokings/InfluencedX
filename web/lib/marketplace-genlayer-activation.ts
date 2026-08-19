import { and, eq, gt } from "drizzle-orm";

import { getDb } from "../db/index.ts";
import { verificationRequests } from "../db/schema.ts";
import {
  CREDENTIAL_TTL_MS,
  X_CHALLENGE_TTL_MS,
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
  deriveOwnershipRequestId,
  normalizeContentSource,
  normalizeMarketplaceAddress,
  ownershipOutcomeAllowsRetry,
  parseOwnershipResult,
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

export async function prepareGenLayerCreatorActivation(input: {
  session: AuthenticatedWalletSession;
  requestId: string;
  source: unknown;
  verificationPostUrl?: unknown;
  castHash?: unknown;
  nowMs?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  const row = await ownedRow(input.session, input.requestId);
  const source = normalizeContentSource(input.source);
  if (row.status !== "X_CHALLENGE_ISSUED" || row.requestExpiresAt <= nowMs) stateChanged();
  if (!ownershipOutcomeAllowsRetry(row.genlayerOutcome)) {
    throw problem(409, "ACTIVATION_OUTCOME_TERMINAL", "This ownership request already has a terminal GenLayer outcome.");
  }
  if ((row.identitySource ?? "X") !== source) {
    throw problem(409, "IDENTITY_SOURCE_MISMATCH", "The activation source does not match the saved challenge.");
  }
  const envelope = prepareActivationEnvelope(row, source, {
    verificationPostUrl: input.verificationPostUrl,
    castHash: input.castHash,
    nowMs,
  });
  const call = activationCall(row, source, envelope);
  const prepared = await prepareGenLayerMarketplaceTransaction({
    operation: "ACTIVATE_CREATOR",
    call,
    actorWallet: row.wallet,
    onchainEntityId: envelope.requestId,
    reuseFinalized: row.genlayerOutcome !== "UNDETERMINED",
    nowMs,
  });
  const [updated] = await getDb()
    .update(verificationRequests)
    .set({
      identitySource: source,
      normalizedVerificationPostUrl: envelope.normalizedUrl,
      verificationPostId: source === "X" ? envelope.contentId : null,
      verificationPostCreatedAt: envelope.contentCreatedAtMs,
      farcasterCastHash: source === "FARCASTER" ? envelope.contentId : null,
      finalizedRequestId: envelope.requestId,
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
  const request = await getNativeVerificationStatus(input);
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
    const post = parseVerificationPostUrl(input.verificationPostUrl);
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
