import { and, desc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  padHex,
  sha256,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { getDb } from "@/db";
import {
  verificationRequests,
  type BaseRelayStatus,
  type OwnershipSubmissionStatus,
  type VerificationStatus,
} from "@/db/schema";
import { ApiProblem } from "@/lib/verification-api";
import {
  CREDENTIAL_TTL_MS,
  BASE_SEPOLIA_CHAIN_ID,
  OWNERSHIP_INTENT_TYPES,
  WALLET_CHALLENGE_TTL_MS,
  X_CHALLENGE_TTL_MS,
  buildOwnershipTweet,
  buildWalletAuthorizationMessage,
  createOwnershipIntent,
  makeRandomBase64Url,
  makeRandomToken,
  normalizeWallet,
  normalizeXHandle,
  parseVerificationPostUrl,
  shouldExpireVerificationRequest,
  validateVerificationPostTiming,
  type OwnershipIntentTypedData,
} from "@/lib/verification-core";
import { buildOwnershipSubmissionEnvelope } from "@/lib/ownership-submission";
import {
  openSubmissionEvidence,
  sealSubmissionEvidence,
  submissionEvidenceDigest,
  SubmissionEvidenceError,
  type SubmissionEvidence,
  type SubmissionEvidenceBinding,
} from "@/lib/submission-evidence";
import {
  BradburySubmitterProblem,
  createBradburySubmitterClient,
  loadBradburySubmitterConfig,
} from "@/lib/bradbury-submitter-client";
import {
  BRADBURY_METHOD,
  BRADBURY_NETWORK,
  PINNED_BRADBURY_RESOLVER,
  parseSubmitterSubmission,
  type SubmitterSubmission,
} from "@/lib/ownership-submission";

type VerificationRow = typeof verificationRequests.$inferSelect;

export type VerificationProjection = {
  id: string;
  status: VerificationStatus;
  wallet: string;
  walletChallengeExpiresAt: string;
  walletAuthorizedAt: string | null;
  handle: string | null;
  tweetText: string | null;
  xChallengeIssuedAt: string | null;
  xChallengeExpiresAt: string | null;
  credentialExpiresAt: string | null;
  normalizedVerificationPostUrl: string | null;
  verificationPostId: string | null;
  verificationPostCreatedAt: string | null;
  finalizedRequestId: string | null;
  intentSignatureStatus: VerificationRow["intentSignatureStatus"];
  intentPreparedAt: string | null;
  readyForGenLayerAt: string | null;
  submissionStatus: OwnershipSubmissionStatus;
  submissionStatusUpdatedAt: string | null;
  submissionAttempts: number;
  genlayerTxHash: string | null;
  genlayerOutcome: string | null;
  genlayerErrorCode: string | null;
  genlayerSubmittedAt: string | null;
  genlayerLastPolledAt: string | null;
  genlayerFinalizedAt: string | null;
  baseRelayStatus: BaseRelayStatus;
  baseRelayTxHash: string | null;
  baseRelayUpdatedAt: string | null;
  baseConfirmedAt: string | null;
  baseRelayErrorCode: string | null;
  baseRegistryAddress: string | null;
  baseProfileId: string | null;
  baseProfileIdentityHash: string | null;
  baseProfileHandleHash: string | null;
  baseProfileVerificationPostHash: string | null;
  baseProfileExpiresAt: string | null;
  baseProfileActive: boolean | null;
  baseProfileVerified: boolean | null;
  createdAt: string;
  updatedAt: string;
};

export async function createVerificationRequest(input: {
  ownerUserId: string;
  wallet: unknown;
  origin: string;
  nowMs?: number;
}): Promise<{ request: VerificationProjection; message: string | null }> {
  const nowMs = input.nowMs ?? Date.now();
  const wallet = normalizeWallet(input.wallet);
  await expireStaleOwnedRequests(input.ownerUserId, nowMs);
  const existing = await activeOwnedRequest(input.ownerUserId, nowMs);
  if (existing) {
    if (existing.wallet !== wallet) {
      throw new ApiProblem(
        409,
        "ACTIVE_REQUEST_EXISTS",
        "Finish or wait for the current verification request before using another wallet.",
      );
    }
    return {
      request: toProjection(existing),
      message:
        existing.status === "WALLET_CHALLENGE_PENDING"
          ? existing.walletMessage
          : null,
    };
  }

  const id = crypto.randomUUID();
  const walletNonce = makeRandomToken(16);
  const walletChallengeExpiresAt = nowMs + WALLET_CHALLENGE_TTL_MS;
  const walletMessage = buildWalletAuthorizationMessage({
    origin: input.origin,
    requestId: id,
    wallet,
    nonce: walletNonce,
    issuedAtMs: nowMs,
    expiresAtMs: walletChallengeExpiresAt,
  });

  const db = getDb();
  let row: VerificationRow;
  try {
    [row] = await db
      .insert(verificationRequests)
      .values({
      id,
      ownerUserId: input.ownerUserId,
      activeOwnerUserId: input.ownerUserId,
      activeWallet: wallet,
      status: "WALLET_CHALLENGE_PENDING",
      statusUpdatedAt: nowMs,
      requestExpiresAt: walletChallengeExpiresAt,
      wallet,
      walletNonce,
      walletNonceHash: sha256(stringToHex(walletNonce)),
      walletMessage,
      walletMessageHash: sha256(stringToHex(walletMessage)),
      walletChallengeExpiresAt,
      createdAt: nowMs,
      updatedAt: nowMs,
      })
      .returning();
  } catch (error) {
    const raced = await activeOwnedRequest(input.ownerUserId, nowMs);
    if (!raced) throw error;
    if (raced.wallet !== wallet) {
      throw new ApiProblem(
        409,
        "ACTIVE_REQUEST_EXISTS",
        "Another wallet already has an active verification request.",
      );
    }
    return {
      request: toProjection(raced),
      message:
        raced.status === "WALLET_CHALLENGE_PENDING"
          ? raced.walletMessage
          : null,
    };
  }

  return { request: toProjection(row), message: walletMessage };
}

export async function authorizeWallet(input: {
  ownerUserId: string;
  requestId: string;
  signature: string;
  nowMs?: number;
}): Promise<VerificationProjection> {
  const nowMs = input.nowMs ?? Date.now();
  const row = await ownedRequest(input.ownerUserId, input.requestId);
  requireStatus(row, "WALLET_CHALLENGE_PENDING");
  if (row.walletChallengeExpiresAt <= nowMs) {
    await markExpired(row, nowMs);
    throw new ApiProblem(410, "CHALLENGE_EXPIRED", "The wallet challenge expired.");
  }

  const signature = parseSignature(input.signature);
  let valid = false;
  try {
    valid = await signatureVerificationClient().verifyMessage({
      address: row.wallet as Address,
      message: row.walletMessage ?? "",
      signature,
    });
  } catch {
    throw new ApiProblem(
      503,
      "SIGNATURE_VERIFIER_UNAVAILABLE",
      "Base Sepolia signature verification is temporarily unavailable.",
    );
  }
  if (!valid) {
    throw new ApiProblem(
      422,
      "INVALID_WALLET_SIGNATURE",
      "The signature does not match the requested wallet.",
    );
  }

  const [updated] = await getDb()
    .update(verificationRequests)
    .set({
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
    })
    .where(
      and(
        eq(verificationRequests.id, row.id),
        eq(verificationRequests.ownerUserId, input.ownerUserId),
        eq(verificationRequests.status, "WALLET_CHALLENGE_PENDING"),
        eq(verificationRequests.revision, row.revision),
        gt(verificationRequests.requestExpiresAt, nowMs),
      ),
    )
    .returning();
  if (!updated) await transitionConflict(row.id, input.ownerUserId);
  return toProjection(updated);
}

export async function issueXChallenge(input: {
  ownerUserId: string;
  requestId: string;
  handle: unknown;
  nowMs?: number;
}): Promise<VerificationProjection> {
  const nowMs = input.nowMs ?? Date.now();
  const row = await ownedRequest(input.ownerUserId, input.requestId);
  requireStatus(row, "WALLET_AUTHORIZED");
  const handle = normalizeXHandle(input.handle);
  const xChallenge = `APV2-${makeRandomBase64Url(18)}`;
  const xChallengeExpiresAt = nowMs + X_CHALLENGE_TTL_MS;
  const credentialExpiresAt = nowMs + CREDENTIAL_TTL_MS;
  const tweetText = buildOwnershipTweet({
    wallet: row.wallet as Address,
    challenge: xChallenge,
    issuedAtMs: nowMs,
    challengeExpiresAtMs: xChallengeExpiresAt,
    credentialExpiresAtMs: credentialExpiresAt,
  });

  const [updated] = await getDb()
    .update(verificationRequests)
    .set({
      status: "X_CHALLENGE_ISSUED",
      statusUpdatedAt: nowMs,
      handle,
      xChallenge,
      tweetText,
      tweetTextHash: sha256(stringToHex(tweetText)),
      challengeHash: sha256(stringToHex(xChallenge)),
      xChallengeIssuedAt: nowMs,
      xChallengeExpiresAt,
      credentialExpiresAt,
      requestExpiresAt: xChallengeExpiresAt,
      purgedAt: null,
      revision: row.revision + 1,
      updatedAt: nowMs,
    })
    .where(
      and(
        eq(verificationRequests.id, row.id),
        eq(verificationRequests.ownerUserId, input.ownerUserId),
        eq(verificationRequests.status, "WALLET_AUTHORIZED"),
        eq(verificationRequests.revision, row.revision),
        gt(verificationRequests.requestExpiresAt, nowMs),
      ),
    )
    .returning();
  if (!updated) await transitionConflict(row.id, input.ownerUserId);
  return toProjection(updated);
}

export async function prepareOwnershipIntent(input: {
  ownerUserId: string;
  requestId: string;
  verificationPostUrl: unknown;
  nowMs?: number;
}): Promise<{
  request: VerificationProjection;
  typedData: OwnershipIntentTypedData;
  evidenceToken: string;
}> {
  const nowMs = input.nowMs ?? Date.now();
  const row = await ownedRequest(input.ownerUserId, input.requestId);
  requireStatus(row, "X_CHALLENGE_ISSUED");
  const { receiverContract, genlayerContract } = deploymentConfig();
  const post = parseVerificationPostUrl(input.verificationPostUrl);
  if (!row.handle || post.handle !== row.handle) {
    throw new ApiProblem(
      422,
      "HANDLE_MISMATCH",
      "The X post URL must belong to the handle in this challenge.",
    );
  }
  if (
    !row.xChallenge ||
    !row.xChallengeIssuedAt ||
    !row.xChallengeExpiresAt ||
    !row.credentialExpiresAt
  ) {
    throw new ApiProblem(
      500,
      "CORRUPT_REQUEST",
      "The saved X challenge is incomplete.",
    );
  }
  try {
    validateVerificationPostTiming({
      postCreatedAtMs: post.createdAtMs,
      challengeIssuedAtMs: row.xChallengeIssuedAt,
      challengeExpiresAtMs: row.xChallengeExpiresAt,
      credentialExpiresAtMs: row.credentialExpiresAt,
      nowMs,
    });
  } catch (error) {
    if (nowMs > row.xChallengeExpiresAt) await markExpired(row, nowMs);
    throw new ApiProblem(
      422,
      "INVALID_POST_TIME",
      error instanceof Error ? error.message : "The X post timestamp is invalid.",
    );
  }

  const intent = createOwnershipIntent({
    wallet: row.wallet as Address,
    handle: row.handle,
    postId: post.postId,
    challenge: row.xChallenge,
    challengeIssuedAtMs: row.xChallengeIssuedAt,
    challengeExpiresAtMs: row.xChallengeExpiresAt,
    credentialExpiresAtMs: row.credentialExpiresAt,
    receiverContract,
    genlayerContract,
  });
  const serializedTypedData = JSON.stringify(intent.typedData);
  const evidence = createSubmissionEvidence({
    row,
    ownerUserId: input.ownerUserId,
    finalizedRequestId: intent.finalizedRequestId,
    challenge: row.xChallenge,
    postId: post.postId,
    nowMs,
    expiresAtMs: row.xChallengeExpiresAt,
    ownershipIntentSignature: null,
  });
  const evidenceToken = await sealEvidence(evidence);

  const [updated] = await getDb()
    .update(verificationRequests)
    .set({
      status: "INTENT_PREPARED",
      statusUpdatedAt: nowMs,
      normalizedVerificationPostUrl: post.normalizedUrl,
      verificationPostId: post.postId,
      verificationPostCreatedAt: post.createdAtMs,
      finalizedRequestId: intent.finalizedRequestId,
      handleHash: intent.handleHash,
      verificationPostHash: intent.verificationPostHash,
      challengeHash: intent.challengeHash,
      receiverContract,
      genlayerContract,
      intentTypedDataJson: serializedTypedData,
      intentSignatureStatus: "AWAITING_SIGNATURE",
      intentPreparedAt: nowMs,
      sealedEvidenceCiphertext: evidenceToken,
      sealedEvidenceHash: submissionEvidenceDigest(evidenceToken),
      sealedEvidenceExpiresAt: evidence.expiresAtMs,
      sealedEvidencePurgedAt: null,
      xChallenge: null,
      tweetText: null,
      purgedAt: nowMs,
      revision: row.revision + 1,
      updatedAt: nowMs,
    })
    .where(
      and(
        eq(verificationRequests.id, row.id),
        eq(verificationRequests.ownerUserId, input.ownerUserId),
        eq(verificationRequests.status, "X_CHALLENGE_ISSUED"),
        eq(verificationRequests.revision, row.revision),
        gt(verificationRequests.requestExpiresAt, nowMs),
      ),
    )
    .returning();
  if (!updated) await transitionConflict(row.id, input.ownerUserId);
  return {
    request: toProjection(updated),
    typedData: intent.typedData,
    evidenceToken,
  };
}

export async function authorizeOwnershipIntent(input: {
  ownerUserId: string;
  requestId: string;
  signature: string;
  evidenceToken?: unknown;
  nowMs?: number;
}): Promise<{ request: VerificationProjection; evidenceToken: string }> {
  const nowMs = input.nowMs ?? Date.now();
  const row = await ownedRequest(input.ownerUserId, input.requestId);
  requireStatus(row, "INTENT_PREPARED");
  if (!row.xChallengeExpiresAt || !row.credentialExpiresAt) {
    throw new ApiProblem(
      500,
      "CORRUPT_REQUEST",
      "The ownership intent is incomplete.",
    );
  }
  if (
    row.xChallengeExpiresAt <= nowMs ||
    row.credentialExpiresAt <= nowMs
  ) {
    await markExpired(row, nowMs);
    throw new ApiProblem(410, "CHALLENGE_EXPIRED", "The X challenge expired.");
  }

  const signature = parseSignature(input.signature);
  const typedData = storedOwnershipIntent(row);
  const evidence = await openStoredEvidence(row, input.ownerUserId, input.evidenceToken, nowMs);
  if (evidence.ownershipIntentSignature !== null) {
    throw new ApiProblem(
      409,
      "EVIDENCE_ALREADY_AUTHORIZED",
      "The saved ownership evidence already contains an authorization.",
    );
  }
  let valid = false;
  try {
    valid = await signatureVerificationClient().verifyTypedData({
      address: row.wallet as Address,
      ...typedData,
      signature,
    });
  } catch {
    throw new ApiProblem(
      503,
      "SIGNATURE_VERIFIER_UNAVAILABLE",
      "Base Sepolia signature verification is temporarily unavailable.",
    );
  }
  if (!valid) {
    throw new ApiProblem(
      422,
      "INVALID_INTENT_SIGNATURE",
      "The ownership intent signature does not match the authorized wallet.",
    );
  }

  const authorizedEvidence: SubmissionEvidence = Object.freeze({
    ...evidence,
    ownershipIntentSignature: signature,
    sealedAtMs: nowMs,
    expiresAtMs: row.credentialExpiresAt,
  });
  const authorizedEvidenceToken = await sealEvidence(authorizedEvidence);

  const [updated] = await getDb()
    .update(verificationRequests)
    .set({
      status: "READY_FOR_GENLAYER",
      statusUpdatedAt: nowMs,
      intentSignatureHash: keccak256(signature),
      intentSignatureStatus: "VERIFIED",
      readyForGenLayerAt: nowMs,
      sealedEvidenceCiphertext: authorizedEvidenceToken,
      sealedEvidenceHash: submissionEvidenceDigest(authorizedEvidenceToken),
      sealedEvidenceExpiresAt: authorizedEvidence.expiresAtMs,
      requestExpiresAt: row.xChallengeExpiresAt,
      revision: row.revision + 1,
      updatedAt: nowMs,
    })
    .where(
      and(
        eq(verificationRequests.id, row.id),
        eq(verificationRequests.ownerUserId, input.ownerUserId),
        eq(verificationRequests.status, "INTENT_PREPARED"),
        eq(verificationRequests.revision, row.revision),
        gt(verificationRequests.requestExpiresAt, nowMs),
      ),
    )
    .returning();
  if (!updated) await transitionConflict(row.id, input.ownerUserId);
  return {
    request: toProjection(updated),
    evidenceToken: authorizedEvidenceToken,
  };
}

export async function resumeOwnershipIntent(input: {
  ownerUserId: string;
  requestId: string;
  nowMs?: number;
}): Promise<{
  request: VerificationProjection;
  typedData: OwnershipIntentTypedData | null;
  evidenceToken: string;
}> {
  const row = await expireIfNeeded(
    await ownedRequest(input.ownerUserId, input.requestId),
    input.nowMs ?? Date.now(),
  );
  if (row.status !== "INTENT_PREPARED" && row.status !== "READY_FOR_GENLAYER") {
    requireStatus(row, "INTENT_PREPARED");
  }
  await openStoredEvidence(row, input.ownerUserId, undefined, input.nowMs ?? Date.now());
  return {
    request: toProjection(row),
    typedData: row.status === "INTENT_PREPARED" ? storedOwnershipIntent(row) : null,
    evidenceToken: row.sealedEvidenceCiphertext!,
  };
}

export async function getVerificationStatus(input: {
  ownerUserId: string;
  requestId?: string;
  nowMs?: number;
}): Promise<VerificationProjection | null> {
  const db = getDb();
  const [row] = input.requestId
    ? await db
        .select()
        .from(verificationRequests)
        .where(
          and(
            eq(verificationRequests.id, input.requestId),
            eq(verificationRequests.ownerUserId, input.ownerUserId),
          ),
        )
        .limit(1)
    : await db
        .select()
        .from(verificationRequests)
        .where(eq(verificationRequests.ownerUserId, input.ownerUserId))
        .orderBy(desc(verificationRequests.createdAt))
        .limit(1);
  if (!row) return null;
  const current = await expireIfNeeded(row, input.nowMs ?? Date.now());
  return toProjection(current);
}

export async function requireOwnedRequestForSubmission(
  ownerUserId: string,
  requestId: string,
): Promise<VerificationProjection> {
  const row = await expireIfNeeded(
    await ownedRequest(ownerUserId, requestId),
    Date.now(),
  );
  requireStatus(row, "READY_FOR_GENLAYER");
  return toProjection(row);
}

export async function submitOwnershipVerification(input: {
  ownerUserId: string;
  requestId: string;
  authenticatedWallet: string;
  evidenceToken?: unknown;
  nowMs?: number;
}): Promise<VerificationProjection> {
  const nowMs = input.nowMs ?? Date.now();
  const row = await expireIfNeeded(
    await ownedRequest(input.ownerUserId, input.requestId),
    nowMs,
  );
  requireStatus(row, "READY_FOR_GENLAYER");
  const authenticatedWallet = normalizeWallet(input.authenticatedWallet);
  if (authenticatedWallet.toLowerCase() !== row.wallet.toLowerCase()) {
    throw new ApiProblem(
      409,
      "SESSION_WALLET_MISMATCH",
      "The authenticated wallet does not own this verification request.",
    );
  }
  const evidence = await openStoredEvidence(
    row,
    input.ownerUserId,
    input.evidenceToken,
    nowMs,
  );
  if (!evidence.ownershipIntentSignature) {
    throw new ApiProblem(
      409,
      "OWNERSHIP_SIGNATURE_REQUIRED",
      "The sealed evidence does not contain the verified ownership signature.",
    );
  }
  if (Math.floor(nowMs / 1_000) > evidence.envelope.expiresAtEpoch) {
    await markExpired(row, nowMs);
    throw new ApiProblem(
      410,
      "CHALLENGE_EXPIRED",
      "The APV2 challenge expired before the submitter accepted it.",
    );
  }
  if (
    row.submissionStatus !== "NOT_SUBMITTED" &&
    row.submissionStatus !== "DISPATCH_UNKNOWN" &&
    row.submissionStatus !== "PRECHECK_FAILED"
  ) {
    // A repeated browser POST is idempotent. Durable status polling, not a
    // second funded call, advances an already accepted request.
    return toProjection(row);
  }
  const config = await submitterConfig();
  const client = createBradburySubmitterClient(config);

  const [claimed] = await getDb()
    .update(verificationRequests)
    .set({
      submissionStatus: "DISPATCHING",
      submissionStatusUpdatedAt: nowMs,
      submissionAttempts: row.submissionAttempts + 1,
      submissionLastAttemptAt: nowMs,
      requestExpiresAt: row.credentialExpiresAt!,
      revision: row.revision + 1,
      updatedAt: nowMs,
    })
    .where(
      and(
        eq(verificationRequests.id, row.id),
        eq(verificationRequests.ownerUserId, input.ownerUserId),
        eq(verificationRequests.status, "READY_FOR_GENLAYER"),
        eq(verificationRequests.revision, row.revision),
        gt(verificationRequests.requestExpiresAt, nowMs),
      ),
    )
    .returning();
  if (!claimed) await transitionConflict(row.id, input.ownerUserId);

  let remote: SubmitterSubmission;
  try {
    const result = await client.submit(evidence.envelope);
    remote = result.submission;
    if (remote.requestId !== row.finalizedRequestId?.toLowerCase()) {
      throw new BradburySubmitterProblem(
        "SUBMITTER_RESPONSE_INVALID",
        "The submission response does not match the ownership request.",
        { ambiguous: true },
      );
    }
  } catch (error) {
    await markDispatchUnknown(claimed, nowMs, error);
    throw submitterProblem(error);
  }
  const updated = await persistSubmitterSubmission(claimed, remote, nowMs);
  return toProjection(updated);
}

export async function refreshOwnershipSubmissionStatus(input: {
  ownerUserId: string;
  requestId: string;
  authenticatedWallet: string;
  nowMs?: number;
}): Promise<VerificationProjection> {
  const nowMs = input.nowMs ?? Date.now();
  const row = await expireIfNeeded(
    await ownedRequest(input.ownerUserId, input.requestId),
    nowMs,
  );
  const authenticatedWallet = normalizeWallet(input.authenticatedWallet);
  if (authenticatedWallet.toLowerCase() !== row.wallet.toLowerCase()) {
    throw new ApiProblem(409, "SESSION_WALLET_MISMATCH", "This session is bound to another wallet.");
  }
  if (row.submissionStatus === "NOT_SUBMITTED" || !row.finalizedRequestId) {
    return toProjection(row);
  }
  // Browser polling reads only the submitter's safe status projection. The
  // private jobs/envelopes table and StudioNet RPC are never touched here.
  const result = await getDb().execute(sql`
    select
      request_id,
      status,
      network,
      resolver,
      function_name,
      lifecycle_status,
      execution_result,
      result_outcome,
      tx_hash,
      queue_message_id,
      enqueue_attempts,
      delivery_count,
      poll_attempts,
      error_code,
      broadcast_started_at,
      submitted_at,
      last_polled_at,
      finalized_at,
      created_at,
      updated_at
    from xproof_bradbury_submission_status
    where request_id = ${row.finalizedRequestId.toLowerCase()}
    limit 1
  `);
  const statusRow = (result as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0];
  if (!statusRow) {
    if (
      row.submissionStatus === "DISPATCHING" &&
      row.submissionLastAttemptAt !== null &&
      row.submissionLastAttemptAt <= nowMs - 30_000
    ) {
      const [unknown] = await getDb()
        .update(verificationRequests)
        .set({
          submissionStatus: "DISPATCH_UNKNOWN",
          submissionStatusUpdatedAt: nowMs,
          genlayerErrorCode: "DISPATCH_INTERRUPTED",
          revision: row.revision + 1,
          updatedAt: nowMs,
        })
        .where(
          and(
            eq(verificationRequests.id, row.id),
            eq(verificationRequests.ownerUserId, row.ownerUserId),
            eq(verificationRequests.revision, row.revision),
            eq(verificationRequests.submissionStatus, "DISPATCHING"),
          ),
        )
        .returning();
      return toProjection(unknown ?? (await ownedRequest(row.ownerUserId, row.id)));
    }
    return toProjection(row);
  }
  const remote = submitterSubmissionFromDatabase(statusRow);
  if (remote.requestId !== row.finalizedRequestId.toLowerCase()) {
    throw new ApiProblem(500, "CORRUPT_SUBMISSION_STATUS", "The durable submitter status is bound to another request.");
  }
  if (
    row.submissionStatusUpdatedAt !== null &&
    Date.parse(remote.updatedAt) <= row.submissionStatusUpdatedAt
  ) {
    return toProjection(row);
  }
  return toProjection(await persistSubmitterSubmission(row, remote, nowMs));
}

let cachedSignatureClient:
  | ReturnType<typeof createBaseSepoliaSignatureClient>
  | undefined;
let cachedSignatureRpcUrl: string | undefined;

function signatureVerificationClient() {
  const configured = process.env.XPROOF_BASE_SEPOLIA_RPC_URL;
  const rpcUrl =
    typeof configured === "string" && configured.trim()
      ? configured.trim()
      : "https://sepolia.base.org";
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new ApiProblem(
      503,
      "SIGNATURE_VERIFIER_UNAVAILABLE",
      "The Base Sepolia RPC URL is invalid.",
    );
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    parsed.hostname,
  );
  if (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) {
    throw new ApiProblem(
      503,
      "SIGNATURE_VERIFIER_UNAVAILABLE",
      "The Base Sepolia RPC URL must use HTTPS.",
    );
  }
  if (!cachedSignatureClient || cachedSignatureRpcUrl !== rpcUrl) {
    cachedSignatureClient = createBaseSepoliaSignatureClient(rpcUrl);
    cachedSignatureRpcUrl = rpcUrl;
  }
  return cachedSignatureClient;
}

function createBaseSepoliaSignatureClient(rpcUrl: string) {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl, { retryCount: 1, timeout: 10_000 }),
  });
}

function deploymentConfig(): {
  receiverContract: Address;
  genlayerContract: Address;
} {
  const receiver = process.env.XPROOF_ATTESTATION_RECEIVER?.trim();
  const resolver = process.env.XPROOF_GENLAYER_CONTRACT?.trim();
  if (
    typeof receiver !== "string" ||
    typeof resolver !== "string" ||
    !isAddress(receiver, { strict: false }) ||
    !isAddress(resolver, { strict: false }) ||
    receiver.toLowerCase() === zeroAddress ||
    resolver.toLowerCase() === zeroAddress
  ) {
    throw new ApiProblem(
      503,
      "CONFIGURATION_REQUIRED",
      "The Base Sepolia V2 receiver and GenLayer V2 resolver must be deployed before an ownership intent can be prepared.",
    );
  }
  return {
    receiverContract: getAddress(receiver),
    genlayerContract: getAddress(resolver),
  };
}

async function ownedRequest(
  ownerUserId: string,
  requestId: string,
): Promise<VerificationRow> {
  if (!requestId || requestId.length > 128) {
    throw new ApiProblem(400, "INVALID_REQUEST", "requestId is required.");
  }
  const [row] = await getDb()
    .select()
    .from(verificationRequests)
    .where(
      and(
        eq(verificationRequests.id, requestId),
        eq(verificationRequests.ownerUserId, ownerUserId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new ApiProblem(404, "REQUEST_NOT_FOUND", "Verification request not found.");
  }
  return row;
}

async function activeOwnedRequest(
  ownerUserId: string,
  nowMs: number,
): Promise<VerificationRow | null> {
  const [row] = await getDb()
    .select()
    .from(verificationRequests)
    .where(
      and(
        eq(verificationRequests.activeOwnerUserId, ownerUserId),
        gt(verificationRequests.requestExpiresAt, nowMs),
      ),
    )
    .limit(1);
  return row ?? null;
}

function requireStatus(row: VerificationRow, expected: VerificationStatus): void {
  if (row.status === "EXPIRED") {
    throw new ApiProblem(410, "CHALLENGE_EXPIRED", "This request has expired.");
  }
  if (row.status !== expected) {
    throw new ApiProblem(
      409,
      "INVALID_STATE",
      `This action requires ${expected}, but the request is ${row.status}.`,
    );
  }
}

async function transitionConflict(
  requestId: string,
  ownerUserId: string,
): Promise<never> {
  const current = await ownedRequest(ownerUserId, requestId);
  throw new ApiProblem(
    409,
    "STATE_CHANGED",
    `The verification request changed to ${current.status}. Refresh its status before continuing.`,
  );
}

async function expireIfNeeded(
  row: VerificationRow,
  nowMs: number,
): Promise<VerificationRow> {
  return shouldExpireVerificationRequest(
    row.status,
    row.requestExpiresAt,
    nowMs,
  )
    ? markExpired(row, nowMs)
    : row;
}

async function expireStaleOwnedRequests(
  ownerUserId: string,
  nowMs: number,
): Promise<void> {
  const stale = await getDb()
    .select()
    .from(verificationRequests)
    .where(
      and(
        eq(verificationRequests.ownerUserId, ownerUserId),
        ne(verificationRequests.status, "EXPIRED"),
        lte(verificationRequests.requestExpiresAt, nowMs),
      ),
    )
    .limit(50);
  for (const row of stale) await markExpired(row, nowMs);
}

async function markExpired(
  row: VerificationRow,
  nowMs: number,
): Promise<VerificationRow> {
  if (row.status === "EXPIRED") return row;
  const [updated] = await getDb()
    .update(verificationRequests)
    .set({
      status: "EXPIRED",
      statusUpdatedAt: nowMs,
      activeOwnerUserId: null,
      activeWallet: null,
      walletNonce: null,
      walletMessage: null,
      handle: null,
      xChallenge: null,
      tweetText: null,
      normalizedVerificationPostUrl: null,
      sealedEvidenceCiphertext: null,
      sealedEvidenceHash: null,
      sealedEvidenceExpiresAt: null,
      sealedEvidencePurgedAt: nowMs,
      purgedAt: nowMs,
      revision: row.revision + 1,
      updatedAt: nowMs,
    })
    .where(
      and(
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
      ),
    )
    .returning();
  if (updated) return updated;
  return ownedRequest(row.ownerUserId, row.id);
}

function parseSignature(value: string): Hex {
  if (
    value.length > 1_000 ||
    !isHex(value) ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    throw new ApiProblem(400, "INVALID_SIGNATURE", "Enter a valid hex signature.");
  }
  return value as Hex;
}

function storedOwnershipIntent(row: VerificationRow): OwnershipIntentTypedData {
  if (
    !row.intentTypedDataJson ||
    !row.finalizedRequestId ||
    !row.handleHash ||
    !row.verificationPostHash ||
    !row.challengeHash ||
    !row.credentialExpiresAt ||
    !row.receiverContract ||
    !row.genlayerContract
  ) {
    throw new ApiProblem(
      500,
      "CORRUPT_REQUEST",
      "The ownership intent is incomplete.",
    );
  }

  let typedData: OwnershipIntentTypedData;
  try {
    typedData = JSON.parse(row.intentTypedDataJson) as OwnershipIntentTypedData;
  } catch {
    throw new ApiProblem(
      500,
      "CORRUPT_REQUEST",
      "The ownership intent is invalid.",
    );
  }

  const expectedGenlayerContract = padHex(
    getAddress(row.genlayerContract),
    { size: 32 },
  );
  const valid =
    typedData?.domain?.name === "XProofAttestationReceiver" &&
    typedData.domain.version === "2" &&
    typedData.domain.chainId === BASE_SEPOLIA_CHAIN_ID &&
    typedData.domain.verifyingContract.toLowerCase() ===
      row.receiverContract.toLowerCase() &&
    typedData.primaryType === "OwnershipIntent" &&
    JSON.stringify(typedData.types) ===
      JSON.stringify(OWNERSHIP_INTENT_TYPES) &&
    typedData.message.attestationId === row.finalizedRequestId &&
    typedData.message.wallet.toLowerCase() === row.wallet.toLowerCase() &&
    typedData.message.handleHash === row.handleHash &&
    typedData.message.verificationPostHash === row.verificationPostHash &&
    typedData.message.challengeHash === row.challengeHash &&
    typedData.message.credentialExpiresAt ===
      Math.floor(row.credentialExpiresAt / 1_000) &&
    typedData.message.genlayerContract === expectedGenlayerContract;
  if (!valid) {
    throw new ApiProblem(
      500,
      "CORRUPT_REQUEST",
      "The ownership intent does not match the saved verification request.",
    );
  }
  return typedData;
}

function toProjection(row: VerificationRow): VerificationProjection {
  return {
    id: row.id,
    status: row.status,
    wallet: row.wallet,
    walletChallengeExpiresAt: toIso(row.walletChallengeExpiresAt)!,
    walletAuthorizedAt: toIso(row.walletAuthorizedAt),
    handle: row.handle,
    tweetText: row.tweetText,
    xChallengeIssuedAt: toIso(row.xChallengeIssuedAt),
    xChallengeExpiresAt: toIso(row.xChallengeExpiresAt),
    credentialExpiresAt: toIso(row.credentialExpiresAt),
    normalizedVerificationPostUrl: row.normalizedVerificationPostUrl,
    verificationPostId: row.verificationPostId,
    verificationPostCreatedAt: toIso(row.verificationPostCreatedAt),
    finalizedRequestId: row.finalizedRequestId,
    intentSignatureStatus: row.intentSignatureStatus,
    intentPreparedAt: toIso(row.intentPreparedAt),
    readyForGenLayerAt: toIso(row.readyForGenLayerAt),
    submissionStatus: row.submissionStatus,
    submissionStatusUpdatedAt: toIso(row.submissionStatusUpdatedAt),
    submissionAttempts: row.submissionAttempts,
    genlayerTxHash: row.genlayerTxHash,
    genlayerOutcome: row.genlayerOutcome,
    genlayerErrorCode: row.genlayerErrorCode,
    genlayerSubmittedAt: toIso(row.genlayerSubmittedAt),
    genlayerLastPolledAt: toIso(row.genlayerLastPolledAt),
    genlayerFinalizedAt: toIso(row.genlayerFinalizedAt),
    baseRelayStatus: row.baseRelayStatus,
    baseRelayTxHash: row.baseRelayTxHash,
    baseRelayUpdatedAt: toIso(row.baseRelayUpdatedAt),
    baseConfirmedAt: toIso(row.baseConfirmedAt),
    baseRelayErrorCode: row.baseRelayErrorCode,
    baseRegistryAddress: row.baseRegistryAddress,
    baseProfileId: row.baseProfileId,
    baseProfileIdentityHash: row.baseProfileIdentityHash,
    baseProfileHandleHash: row.baseProfileHandleHash,
    baseProfileVerificationPostHash: row.baseProfileVerificationPostHash,
    baseProfileExpiresAt: toIso(row.baseProfileExpiresAt),
    baseProfileActive: row.baseProfileActive,
    baseProfileVerified: row.baseProfileVerified,
    createdAt: toIso(row.createdAt)!,
    updatedAt: toIso(row.updatedAt)!,
  };
}

function createSubmissionEvidence(input: {
  row: VerificationRow;
  ownerUserId: string;
  finalizedRequestId: Hex;
  challenge: string;
  postId: string;
  nowMs: number;
  expiresAtMs: number;
  ownershipIntentSignature: Hex | null;
}): SubmissionEvidence {
  if (!input.row.handle || !input.row.xChallengeIssuedAt || !input.row.xChallengeExpiresAt || !input.row.credentialExpiresAt) {
    throw new ApiProblem(500, "CORRUPT_REQUEST", "The ownership evidence is incomplete.");
  }
  return Object.freeze({
    version: 1,
    verificationRequestId: input.row.id,
    ownerUserId: input.ownerUserId,
    envelope: buildOwnershipSubmissionEnvelope({
      requestId: input.finalizedRequestId,
      baseWallet: input.row.wallet,
      expectedHandle: input.row.handle,
      postId: input.postId,
      challenge: input.challenge,
      issuedAtEpoch: Math.floor(input.row.xChallengeIssuedAt / 1_000),
      expiresAtEpoch: Math.floor(input.row.xChallengeExpiresAt / 1_000),
      credentialExpiresAtEpoch: Math.floor(input.row.credentialExpiresAt / 1_000),
    }),
    ownershipIntentSignature: input.ownershipIntentSignature,
    sealedAtMs: input.nowMs,
    expiresAtMs: input.expiresAtMs,
  });
}

async function persistSubmitterSubmission(
  row: VerificationRow,
  remote: SubmitterSubmission,
  nowMs: number,
): Promise<VerificationRow> {
  const [updated] = await getDb()
    .update(verificationRequests)
    .set({
      submissionStatus: remote.status,
      submissionStatusUpdatedAt: Date.parse(remote.updatedAt),
      submissionResponseUpdatedAt: nowMs,
      genlayerTxHash: remote.txHash,
      genlayerOutcome: remote.resultOutcome,
      genlayerErrorCode: remote.errorCode,
      genlayerSubmittedAt: isoToMs(remote.submittedAt),
      genlayerLastPolledAt: isoToMs(remote.lastPolledAt),
      genlayerFinalizedAt: isoToMs(remote.finalizedAt),
      revision: row.revision + 1,
      updatedAt: nowMs,
    })
    .where(
      and(
        eq(verificationRequests.id, row.id),
        eq(verificationRequests.ownerUserId, row.ownerUserId),
        eq(verificationRequests.revision, row.revision),
      ),
    )
    .returning();
  if (updated) return updated;
  return ownedRequest(row.ownerUserId, row.id);
}

async function markDispatchUnknown(
  row: VerificationRow,
  nowMs: number,
  error: unknown,
): Promise<void> {
  const errorCode =
    error instanceof BradburySubmitterProblem ? error.code : "SUBMITTER_UNAVAILABLE";
  await getDb()
    .update(verificationRequests)
    .set({
      submissionStatus: "DISPATCH_UNKNOWN",
      submissionStatusUpdatedAt: nowMs,
      submissionResponseUpdatedAt: nowMs,
      genlayerErrorCode: errorCode,
      revision: row.revision + 1,
      updatedAt: nowMs,
    })
    .where(
      and(
        eq(verificationRequests.id, row.id),
        eq(verificationRequests.ownerUserId, row.ownerUserId),
        eq(verificationRequests.revision, row.revision),
      ),
    );
}

async function submitterConfig() {
  try {
    return await loadBradburySubmitterConfig();
  } catch (error) {
    throw submitterProblem(error);
  }
}

function submitterProblem(error: unknown): ApiProblem {
  if (error instanceof ApiProblem) return error;
  if (error instanceof BradburySubmitterProblem) {
    if (error.code === "CONFIGURATION_REQUIRED") {
      return new ApiProblem(503, "SUBMITTER_CONFIGURATION_REQUIRED", "The authenticated GenLayer submitter is not configured.");
    }
    return new ApiProblem(
      503,
      error.ambiguous ? "SUBMISSION_OUTCOME_UNKNOWN" : "SUBMITTER_UNAVAILABLE",
      error.ambiguous
        ? "The submitter may have accepted this request. InfluencedX will reconcile its status without broadcasting another arbitrary call."
        : "The GenLayer submitter is temporarily unavailable.",
    );
  }
  return new ApiProblem(503, "SUBMITTER_UNAVAILABLE", "The GenLayer submitter is temporarily unavailable.");
}

function isoToMs(value: string | null): number | null {
  return value === null ? null : Date.parse(value);
}

function submitterSubmissionFromDatabase(
  row: Record<string, unknown>,
): SubmitterSubmission {
  if (
    row.network !== BRADBURY_NETWORK ||
    typeof row.resolver !== "string" ||
    row.resolver.toLowerCase() !== PINNED_BRADBURY_RESOLVER.toLowerCase() ||
    row.function_name !== BRADBURY_METHOD
  ) {
    throw new ApiProblem(
      500,
      "CORRUPT_SUBMISSION_STATUS",
      "The durable submitter status is not pinned to the APV2 resolver.",
    );
  }
  try {
    return parseSubmitterSubmission({
      requestId: row.request_id,
      status: row.status,
      lifecycleStatus: row.lifecycle_status ?? null,
      executionResult: row.execution_result ?? null,
      resultOutcome: row.result_outcome ?? null,
      txHash: row.tx_hash ?? null,
      queueMessageId: row.queue_message_id ?? null,
      enqueueAttempts: row.enqueue_attempts,
      deliveryCount: row.delivery_count,
      pollAttempts: row.poll_attempts,
      errorCode: row.error_code ?? null,
      broadcastStartedAt: databaseIso(row.broadcast_started_at),
      submittedAt: databaseIso(row.submitted_at),
      lastPolledAt: databaseIso(row.last_polled_at),
      finalizedAt: databaseIso(row.finalized_at),
      createdAt: databaseIso(row.created_at),
      updatedAt: databaseIso(row.updated_at),
    });
  } catch (error) {
    if (error instanceof ApiProblem) throw error;
    throw new ApiProblem(
      500,
      "CORRUPT_SUBMISSION_STATUS",
      "The durable submitter status is invalid.",
    );
  }
}

function databaseIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new Error("Invalid database timestamp.");
}

async function sealEvidence(evidence: SubmissionEvidence): Promise<string> {
  try {
    return await sealSubmissionEvidence(evidence, {
      binding: evidenceBindingFromEvidence(evidence),
    });
  } catch (error) {
    throw evidenceProblem(error);
  }
}

async function openStoredEvidence(
  row: VerificationRow,
  ownerUserId: string,
  suppliedToken: unknown,
  nowMs: number,
): Promise<SubmissionEvidence> {
  if (!row.sealedEvidenceCiphertext || !row.sealedEvidenceHash || !row.finalizedRequestId) {
    throw new ApiProblem(500, "CORRUPT_REQUEST", "The sealed ownership evidence is missing.");
  }
  if (suppliedToken !== undefined) {
    if (
      typeof suppliedToken !== "string" ||
      suppliedToken.length > 4_096 ||
      submissionEvidenceDigest(suppliedToken) !== row.sealedEvidenceHash
    ) {
      throw new ApiProblem(422, "EVIDENCE_MISMATCH", "The ownership evidence does not match this request.");
    }
  }
  try {
    const evidence = await openSubmissionEvidence(row.sealedEvidenceCiphertext, {
      binding: evidenceBindingForRow(row, ownerUserId),
      nowMs,
    });
    assertEvidenceMatchesRow(evidence, row, ownerUserId);
    return evidence;
  } catch (error) {
    throw evidenceProblem(error);
  }
}

function evidenceBindingFromEvidence(evidence: SubmissionEvidence): SubmissionEvidenceBinding {
  return {
    verificationRequestId: evidence.verificationRequestId,
    ownerUserId: evidence.ownerUserId,
    wallet: evidence.envelope.baseWallet,
    finalizedRequestId: evidence.envelope.requestId,
  };
}

function evidenceBindingForRow(
  row: VerificationRow,
  ownerUserId: string,
): SubmissionEvidenceBinding {
  if (!row.finalizedRequestId || !isHex(row.finalizedRequestId)) {
    throw new ApiProblem(500, "CORRUPT_REQUEST", "The finalized request ID is invalid.");
  }
  return {
    verificationRequestId: row.id,
    ownerUserId,
    wallet: row.wallet as Address,
    finalizedRequestId: row.finalizedRequestId as Hex,
  };
}

function assertEvidenceMatchesRow(
  evidence: SubmissionEvidence,
  row: VerificationRow,
  ownerUserId: string,
): void {
  const envelope = evidence.envelope;
  const matches =
    evidence.verificationRequestId === row.id &&
    evidence.ownerUserId === ownerUserId &&
    envelope.requestId === row.finalizedRequestId?.toLowerCase() &&
    envelope.baseWallet.toLowerCase() === row.wallet.toLowerCase() &&
    envelope.expectedHandle === row.handle &&
    envelope.postId === row.verificationPostId &&
    sha256(stringToHex(envelope.challenge)) === row.challengeHash &&
    envelope.issuedAtEpoch === Math.floor((row.xChallengeIssuedAt ?? 0) / 1_000) &&
    envelope.expiresAtEpoch === Math.floor((row.xChallengeExpiresAt ?? 0) / 1_000) &&
    envelope.credentialExpiresAtEpoch === Math.floor((row.credentialExpiresAt ?? 0) / 1_000);
  if (!matches) {
    throw new ApiProblem(500, "CORRUPT_REQUEST", "The sealed ownership evidence does not match its request.");
  }
}

function evidenceProblem(error: unknown): ApiProblem {
  if (error instanceof ApiProblem) return error;
  if (error instanceof SubmissionEvidenceError) {
    if (error.code === "CONFIGURATION_REQUIRED") {
      return new ApiProblem(503, "SUBMISSION_EVIDENCE_CONFIGURATION_REQUIRED", "The sealed evidence service is not configured.");
    }
    if (error.code === "EVIDENCE_EXPIRED") {
      return new ApiProblem(410, "SUBMISSION_EVIDENCE_EXPIRED", "The sealed ownership evidence expired.");
    }
  }
  return new ApiProblem(422, "INVALID_SUBMISSION_EVIDENCE", "The sealed ownership evidence is invalid.");
}

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
