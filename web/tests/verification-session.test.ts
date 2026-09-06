import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ApiProblem,
  assertSameOriginRequest,
  readSameOriginDeleteJson,
} from "../lib/verification-api.ts";
import {
  createNativeVerificationRequest,
  hasNativeVerificationActivationState,
  restoreNativeVerificationWalletSession,
} from "../lib/verification-native-service.ts";
import { authenticateWalletSession, createPendingWalletSession } from "../lib/wallet-session.ts";
import { getTableColumns } from "drizzle-orm";
import { verificationRequests } from "../db/postgres-schema.ts";
import {
  coordinateIdentityBundlePreparation,
} from "../lib/marketplace-genlayer-activation.ts";

type ActivationGuard = Parameters<typeof hasNativeVerificationActivationState>[0];

const idleActivation: ActivationGuard = {
  activationConfirmedAt: null,
  activationPreparedId: null,
  activationTxHash: null,
  farcasterOwnershipRequestId: null,
  finalizedRequestId: null,
  genlayerErrorCode: null,
  genlayerFinalizedAt: null,
  genlayerLastPolledAt: null,
  genlayerOutcome: null,
  genlayerSubmittedAt: null,
  genlayerTxHash: null,
  intentPreparedAt: null,
  intentSignatureStatus: "NOT_PREPARED",
  readyForGenLayerAt: null,
  submissionAttempts: 0,
  submissionLastAttemptAt: null,
  submissionResponseUpdatedAt: null,
  submissionStatus: "NOT_SUBMITTED",
  submissionStatusUpdatedAt: null,
  xOwnershipRequestId: null,
};

test("only a verification run without activation or reconciliation state can end as idle", () => {
  assert.equal(hasNativeVerificationActivationState(idleActivation), false);

  const protectedStates = [
    { activationPreparedId: "prepared" },
    { activationTxHash: `0x${"11".repeat(32)}` },
    { activationConfirmedAt: 1 },
    { finalizedRequestId: "bundle" },
    { xOwnershipRequestId: "x-request" },
    { farcasterOwnershipRequestId: "farcaster-request" },
    { intentSignatureStatus: "AWAITING_SIGNATURE" },
    { intentPreparedAt: 1 },
    { readyForGenLayerAt: 1 },
    { submissionStatus: "SUBMITTED" },
    { submissionStatusUpdatedAt: 1 },
    { submissionAttempts: 1 },
    { submissionLastAttemptAt: 1 },
    { submissionResponseUpdatedAt: 1 },
    { genlayerTxHash: `0x${"22".repeat(32)}` },
    { genlayerOutcome: "UNDETERMINED" },
    { genlayerErrorCode: "FINALITY_PENDING" },
    { genlayerSubmittedAt: 1 },
    { genlayerLastPolledAt: 1 },
    { genlayerFinalizedAt: 1 },
  ] satisfies readonly Partial<ActivationGuard>[];

  for (const protectedState of protectedStates) {
    assert.equal(
      hasNativeVerificationActivationState({
        ...idleActivation,
        ...protectedState,
      }),
      true,
      `expected ${Object.keys(protectedState)[0]} to protect the run`,
    );
  }
});

test("verification session deletion requires same-origin DELETE JSON", async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    VERCEL: process.env.VERCEL,
  };
  try {
    Object.assign(process.env, { NODE_ENV: "test" });
    delete process.env.VERCEL;
    const headers = {
      origin: "http://localhost:3000",
      "sec-fetch-site": "same-origin",
    };
    assert.doesNotThrow(() => assertSameOriginRequest(
      new Request("http://localhost:3000/api/verification/session", {
        method: "DELETE",
        headers,
      }),
      "DELETE",
    ));
    await assert.doesNotReject(() => readSameOriginDeleteJson(
      new Request("http://localhost:3000/api/verification/session", {
        method: "DELETE",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ requestId: "request", revision: 2 }),
      }),
    ));
    assertProblem(
      () => assertSameOriginRequest(
        new Request("http://localhost:3000/api/verification/session", {
          method: "DELETE",
          headers: { ...headers, origin: "https://attacker.example" },
        }),
        "DELETE",
      ),
      403,
      "SAME_ORIGIN_REQUIRED",
    );
    assertProblem(
      () => assertSameOriginRequest(
        new Request("http://localhost:3000/api/verification/session", {
          method: "DELETE",
          headers: { ...headers, "sec-fetch-site": "cross-site" },
        }),
        "DELETE",
      ),
      403,
      "SAME_ORIGIN_REQUIRED",
    );
    assertProblem(
      () => assertSameOriginRequest(
        new Request("http://localhost:3000/api/verification/session", {
          method: "POST",
          headers,
        }),
        "DELETE",
      ),
      405,
      "METHOD_NOT_ALLOWED",
    );
    await assert.rejects(
      () => readSameOriginDeleteJson(
        new Request("http://localhost:3000/api/verification/session", {
          method: "DELETE",
          headers,
          body: "{}",
        }),
      ),
      (error: unknown) => error instanceof ApiProblem
        && error.status === 415
        && error.code === "JSON_REQUIRED",
    );
  } finally {
    restoreEnvironment("NODE_ENV", previous.NODE_ENV);
    restoreEnvironment("VERCEL", previous.VERCEL);
  }
});

test("exact request and revision bind cancellation before cookies can clear", async () => {
  const [route, service] = await Promise.all([
    source("../app/api/verification/session/route.ts"),
    source("../lib/verification-native-service.ts"),
  ]);
  const parseBody = route.indexOf("await readSameOriginDeleteJson(request)");
  const exactKeys = route.indexOf('assertExactJsonKeys(body, ["requestId", "revision"])');
  const readSession = route.indexOf("readWalletSession(request)", exactKeys);
  const endRun = route.indexOf("await endNativeVerificationRun", readSession);
  const clearCookie = route.indexOf("return clearWalletSessionCookies", endRun);
  assert.ok(
    parseBody >= 0
      && exactKeys > parseBody
      && readSession > exactKeys
      && endRun > readSession
      && clearCookie > endRun,
  );
  assert.match(route, /requestId,[\s\S]*revision: Number\(revision\)/);
  assert.match(route, /AUTHENTICATION_REQUIRED/);
  assert.match(route, /catch \(error\) \{\s*return apiError\(error\);\s*\}/);
  assert.doesNotMatch(route, /\? await endNativeVerificationRun|ended: false };/);

  const endMutation = between(
    service,
    "export async function endNativeVerificationRun",
    "type WalletRunOwner",
  );
  for (const exactBinding of [
    "eq(verificationRequests.id, input.requestId)",
    "eq(verificationRequests.ownerUserId, input.ownerUserId)",
    "eq(verificationRequests.activeOwnerUserId, input.ownerUserId)",
    "eq(verificationRequests.revision, input.revision)",
  ]) assert.ok(endMutation.includes(exactBinding), exactBinding);
  assert.match(endMutation, /if \(!active\) \{\s*throw problem\(409, "STATE_CHANGED"/);
  assert.doesNotMatch(endMutation, /if \(!active\) return/);
});

test("wallet logout always clears cookies without reading or mutating verification", async () => {
  const route = await source("../app/api/auth/wallet/session/route.ts");
  const sameOrigin = route.indexOf('assertSameOriginRequest(request, "DELETE")');
  const clearCookie = route.indexOf("return clearWalletSessionCookies", sameOrigin);
  assert.ok(sameOrigin >= 0 && clearCookie > sameOrigin);
  assert.doesNotMatch(route.slice(sameOrigin), /await |readWalletSession|endNativeVerificationRun|activeOwned/);
  assert.doesNotMatch(route, /verification-native-service|ACTIVE_VERIFICATION_EXISTS|VERIFICATION_TRANSACTION_PENDING/);
  assert.match(route, /catch \(error\) \{\s*return apiError\(error\);\s*\}/);
});

test("a server-bound hash detaches the wallet without mutating verification evidence", async () => {
  const service = await source("../lib/verification-native-service.ts");
  const endMutation = between(
    service,
    "export async function endNativeVerificationRun",
    "type WalletRunOwner",
  );
  assert.match(
    endMutation,
    /await detachHashBoundNativeVerificationSession\(\{[\s\S]*ended: false, processing: true/,
  );

  const detach = between(
    service,
    "async function detachHashBoundNativeVerificationSession",
    "function requireStatus",
  );
  const journalBinding = between(
    service,
    "function exactActivationJournalExists",
    "async function detachHashBoundNativeVerificationSession",
  );
  for (const binding of [
    "verificationRequests.activationPreparedId",
    "verificationRequests.wallet",
    "verificationRequests.finalizedRequestId",
    '"ACTIVATE_IDENTITY_BUNDLE"',
    '"activate_identity_bundle"',
  ]) assert.ok(journalBinding.includes(binding), binding);
  assert.match(detach, /sessionDetachedAt: input\.nowMs/);
  assert.match(detach, /isNull\(verificationRequests\.sessionDetachedAt\)/);
  assert.match(detach, /revision: sql`\$\{verificationRequests\.revision\} \+ 1`/);
  assert.match(detach, /exactActivationJournalExists\(/);
  assert.match(detach, /isNotNull\(verificationRequests\.sessionDetachedAt\)/);
  assert.match(detach, /a newer run necessarily has a different request ID/);
  assert.doesNotMatch(detach, /alreadyDetached[\s\S]*input\.revision \+ 1/);
  assert.match(detach, /return Boolean\(alreadyDetached\)/);
  for (const safeStatus of [
    "SUBMITTED",
    "ACCEPTED",
    "FINALIZED",
    "EXECUTION_FAILED",
    "NETWORK_TERMINATED",
    "RECONCILIATION_REQUIRED",
  ]) assert.match(detach, new RegExp(`"${safeStatus}"`));
  assert.doesNotMatch(detach, /"PREPARED"/);
  assert.doesNotMatch(detach, /update\(marketplaceGenLayerTransactions\)/);
});

test("unbound PREPARED state remains fail-closed and can be retried", async () => {
  const [service, flow, walletProvider] = await Promise.all([
    source("../lib/verification-native-service.ts"),
    source("../app/verify/VerifyFlow.tsx"),
    source("../app/marketplace/use-marketplace-wallet.ts"),
  ]);
  const endMutation = between(
    service,
    "export async function endNativeVerificationRun",
    "type WalletRunOwner",
  );
  assert.match(endMutation, /hasNativeVerificationActivationState\(active\)[\s\S]*VERIFICATION_TRANSACTION_PENDING/);
  assert.match(flow, /Transaction cancelled\. Retry verification\./);
  assert.doesNotMatch(flow, /walletSwitchBlocked/);
  assert.doesNotMatch(walletProvider, /"\/api\/verification\/session"/);
  assert.doesNotMatch(service, /USER_CANCELLED|cancel.*prepared/i);
  assert.doesNotMatch(endMutation, /update\(marketplaceGenLayerTransactions\)/);
});

test("expired finalized UNDETERMINED release has exact immutable finality proof", async () => {
  const service = await source("../lib/verification-native-service.ts");
  const endMutation = between(
    service,
    "export async function endNativeVerificationRun",
    "type WalletRunOwner",
  );
  assert.match(endMutation, /releaseExpiredFinalizedUndetermined\(/);
  const release = between(
    service,
    "async function releaseExpiredFinalizedUndetermined",
    "async function expireStale",
  );
  assert.match(release, /lte\(verificationRequests\.requestExpiresAt, nowMs\)/);
  assert.match(release, /isNotNull\(verificationRequests\.xChallengeExpiresAt\)[\s\S]*lte\(verificationRequests\.xChallengeExpiresAt, nowMs\)/);
  assert.match(release, /isNotNull\(verificationRequests\.farcasterChallengeExpiresAt\)[\s\S]*lte\(verificationRequests\.farcasterChallengeExpiresAt, nowMs\)/);
  assert.match(release, /eq\(verificationRequests\.genlayerOutcome, "UNDETERMINED"\)/);
  assert.match(release, /eq\(verificationRequests\.activationTxHash, verificationRequests\.genlayerTxHash\)/);
  assert.match(release, /eq\(verificationRequests\.activationConfirmedAt, verificationRequests\.genlayerFinalizedAt\)/);
  assert.match(release, /exactActivationJournalExists\(\["FINALIZED"\]/);
  assert.match(release, /expiredNativeVerificationValues\(nowMs, \{ preserveActivationAudit: true \}\)/);

  const journalProof = between(
    service,
    "function exactActivationJournalExists",
    "async function detachHashBoundNativeVerificationSession",
  );
  for (const binding of [
    "verificationRequests.activationPreparedId",
    "verificationRequests.wallet",
    "verificationRequests.finalizedRequestId",
    "verificationRequests.activationTxHash",
    "verificationRequests.activationConfirmedAt",
    "MARKETPLACE_GENLAYER_NETWORK",
    "MARKETPLACE_GENLAYER_CHAIN_ID",
    "marketplaceContractAddress()",
  ]) assert.ok(journalProof.includes(binding), binding);
  assert.match(release, /await assertAuthoritativeUndeterminedBundleResult\(row\)/);
  assert.match(service, /readMarketplaceState\("get_ownership_result"[\s\S]*parseIdentityBundleResult/);
  assert.doesNotMatch(endMutation, /update\(marketplaceGenLayerTransactions\)/);
});

test("identity preparation reserves before insert and safely retries the reserved ID", async () => {
  let persisted: string | null = null;
  const events: string[] = [];
  await assert.rejects(
    () => coordinateIdentityBundlePreparation({
      currentPreparedId: null,
      currentOutcome: null,
      createPreparedId: () => "first",
      reservePreparedId: async (preparedId) => {
        events.push(`reserve:${preparedId}`);
        persisted = preparedId;
      },
      prepareReservedId: async (preparedId) => {
        events.push(`prepare:${preparedId}`);
        throw new Error("insert failed");
      },
    }),
    /insert failed/,
  );
  assert.deepEqual(events, ["reserve:first", "prepare:first"]);
  assert.equal(persisted, "first");

  const retried = await coordinateIdentityBundlePreparation({
    currentPreparedId: persisted,
    currentOutcome: null,
    createPreparedId: () => {
      throw new Error("must reuse the reservation");
    },
    reservePreparedId: async () => {
      throw new Error("must not reserve twice");
    },
    prepareReservedId: async (preparedId) => `journal:${preparedId}`,
  });
  assert.deepEqual(retried, {
    preparedId: "first",
    prepared: "journal:first",
    reserved: false,
  });

  const rotated = await coordinateIdentityBundlePreparation({
    currentPreparedId: "first",
    currentOutcome: "UNDETERMINED",
    createPreparedId: () => "second",
    reservePreparedId: async (preparedId) => {
      events.push(`reserve:${preparedId}`);
    },
    prepareReservedId: async (preparedId) => `journal:${preparedId}`,
  });
  assert.deepEqual(rotated, {
    preparedId: "second",
    prepared: "journal:second",
    reserved: true,
  });
});

test("identity journal reservation closes the idle-end race without changing generic reuse", async () => {
  const [activation, repository, schema, migration, journal] = await Promise.all([
    source("../lib/marketplace-genlayer-activation.ts"),
    source("../lib/marketplace-genlayer-repository.ts"),
    source("../db/postgres-schema.ts"),
    source("../drizzle-postgres/0013_verification_session_detach_fence.sql"),
    source("../drizzle-postgres/meta/_journal.json"),
  ]);
  const identityPrepare = between(
    activation,
    "export async function prepareGenLayerIdentityBundleActivation",
    "export async function coordinateIdentityBundlePreparation",
  );
  assert.ok(
    identityPrepare.indexOf("reservePreparedId:")
      < identityPrepare.indexOf("prepareReservedId:"),
  );
  assert.match(identityPrepare, /eq\(verificationRequests\.revision, row\.revision\)/);
  assert.match(identityPrepare, /isNull\(verificationRequests\.sessionDetachedAt\)/);
  assert.match(identityPrepare, /activationPreparedId: preparedId/);
  const recoveryGuard = identityPrepare.indexOf("if (prepared.recovery)");
  const exposedCall = identityPrepare.indexOf("transaction: prepared.call");
  assert.ok(recoveryGuard >= 0 && exposedCall > recoveryGuard);
  assert.match(identityPrepare, /ACTIVATION_TRANSACTION_RECOVERY_REQUIRED/);

  const genericPrepare = between(
    repository,
    "export async function prepareGenLayerMarketplaceTransaction",
    "function assertReservedPreparedTransaction",
  );
  assert.match(genericPrepare, /if \(input\.preparedId\)[\s\S]*assertReservedPreparedTransaction/);
  assert.match(genericPrepare, /else \{[\s\S]*findReusablePreparedTransaction/);
  assert.match(schema, /sessionDetachedAt: epochMs\("session_detached_at"\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "session_detached_at" bigint/);
  assert.match(journal, /"idx": 13,[\s\S]*"tag": "0013_verification_session_detach_fence"/);
});

test("resuming a known ready identity call preserves its original owner, journal and immutable envelope", async () => {
  const activation = await source("../lib/marketplace-genlayer-activation.ts");
  const resume = between(activation, "export async function resumeGenLayerIdentityBundlePreparation", "export async function coordinateIdentityBundlePreparation");
  assert.match(resume, /ownedRow\(input\.session, input\.requestId\)/);
  assert.match(resume, /row\.activationPreparedId !== uuid\(input\.preparedId, "preparedId"\)/);
  assert.match(resume, /prepared\.operation !== "ACTIVATE_IDENTITY_BUNDLE" \|\| prepared\.actorWallet !== row\.wallet/);
  assert.match(resume, /storedIdentityBundleEnvelope\(row, prepared\)/);
  assert.match(resume, /assertPreparedActivation\(prepared, call\)/);
  assert.match(resume, /prepared\.status !== "PREPARED" \|\| row\.requestExpiresAt <= nowMs \|\| row\.genlayerOutcome !== null/);
  assert.ok(resume.indexOf("if (prepared.transactionHash)") < resume.indexOf("transaction: call"));
  assert.doesNotMatch(resume, /coordinateIdentityBundlePreparation|prepareGenLayerMarketplaceTransaction|\.update\(|\.insert\(/);
  const bind = between(activation, "export async function bindGenLayerIdentityBundleActivationSubmission", "async function confirmLegacyGenLayerCreatorActivation");
  assert.match(bind, /receiptRequestId !== undefined && row\.id !== input\.receiptRequestId/);
  assert.ok(bind.indexOf("assertTransactionMatchesPreparedCall") < bind.indexOf("await bindGenLayerTransactionHash"));
});

test("expired finalized runs release locks whether or not the session was detached", async () => {
  const [service, maintenance, activation] = await Promise.all([
    source("../lib/verification-native-service.ts"),
    source("../lib/marketplace-genlayer-maintenance.ts"),
    source("../lib/marketplace-genlayer-activation.ts"),
  ]);
  const cleanup = between(
    service,
    "export async function releaseExpiredFinalizedNativeVerificationRuns",
    "function projection",
  );
  assert.doesNotMatch(cleanup, /isNotNull\(verificationRequests\.sessionDetachedAt\)/);
  assert.match(cleanup, /isNotNull\(verificationRequests\.activeOwnerUserId\)/);
  assert.match(cleanup, /releaseExpiredFinalizedUndetermined\(row, nowMs\)/);
  assert.match(maintenance, /runGenLayerJournalReconciliationBatch[\s\S]*releaseExpiredFinalizedNativeVerificationRuns[\s\S]*runGenLayerProgressionBatch/);

  const confirmBundle = between(
    activation,
    "async function confirmGenLayerIdentityBundleActivation",
    "/** Replays a bound activation journal",
  );
  assert.match(confirmBundle, /activeOwnerUserId:[\s\S]*outcome === "UNDETERMINED"[\s\S]*: null/);
  assert.match(confirmBundle, /activeWallet:[\s\S]*outcome === "UNDETERMINED"[\s\S]*: null/);
  assert.doesNotMatch(confirmBundle, /isNull\(verificationRequests\.sessionDetachedAt\)/);
});

test("idle expiry scrubs direct social PII while terminal finality audit stays bound", async () => {
  const service = await source("../lib/verification-native-service.ts");
  const endMutation = between(
    service,
    "export async function endNativeVerificationRun",
    "type WalletRunOwner",
  );
  assert.match(endMutation, /\.set\(\s*expiredNativeVerificationValues\(nowMs\),\s*\)\.where/);

  const purge = between(
    service,
    "function expiredNativeVerificationValues",
    "function exactActivationJournalExists",
  );
  for (const piiField of [
    "identitySource",
    "handle",
    "xChallenge",
    "tweetText",
    "tweetTextHash",
    "xChallengeIssuedAt",
    "xChallengeExpiresAt",
    "credentialExpiresAt",
    "farcasterUsername",
    "farcasterFid",
    "farcasterChallenge",
    "farcasterCastText",
    "farcasterChallengeIssuedAt",
    "farcasterChallengeExpiresAt",
    "farcasterCastHash",
    "normalizedVerificationPostUrl",
    "verificationPostId",
    "verificationPostCreatedAt",
    "handleHash",
    "verificationPostHash",
    "challengeHash",
    "intentTypedDataJson",
    "sealedEvidenceCiphertext",
    "sealedEvidenceHash",
    "sealedEvidenceExpiresAt",
    "baseProfileIdentityHash",
    "baseProfileHandleHash",
    "baseProfileVerificationPostHash",
  ]) assert.match(purge, new RegExp(`${piiField}: null`), piiField);
  assert.match(purge, /sealedEvidencePurgedAt: nowMs/);
  assert.match(purge, /purgedAt: nowMs/);
  for (const auditId of [
    "finalizedRequestId",
    "xOwnershipRequestId",
    "farcasterOwnershipRequestId",
  ]) assert.match(purge, new RegExp(`${auditId}: null`));
  assert.match(purge, /options\.preserveActivationAudit[\s\S]*\? \{\}/);
});

test("automatic expiry preserves every activation or reconciliation row", async () => {
  const service = await source("../lib/verification-native-service.ts");
  const expiry = between(service, "async function markExpired", "function projection");
  assert.ok(
    expiry.indexOf("hasNativeVerificationActivationState(row)")
      < expiry.indexOf("expiredNativeVerificationValues(nowMs)"),
  );

  const activeLookup = between(service, "async function activeOwned", "async function exactActiveOwned");
  assert.match(activeLookup, /eq\(verificationRequests\.activeOwnerUserId, ownerUserId\)/);
  assert.doesNotMatch(activeLookup, /requestExpiresAt|\bgt\(/);
});

test("verification UI can disconnect at every step without ending or erasing the run", async () => {
  const [flow, styles, walletSelection, walletProvider] = await Promise.all([
    source("../app/verify/VerifyFlow.tsx"),
    source("../app/globals.css"),
    source("../lib/verification-wallet.ts"),
    source("../app/marketplace/use-marketplace-wallet.ts"),
  ]);
  const disconnect = between(flow, "async function disconnectWallet", "async function copyChallengeText");
  assert.match(disconnect, /await persistentWallet\.signOut\(\)/);
  assert.doesNotMatch(disconnect, /clearRecovery|window\.confirm|activeRunRequest|switchBusyBlocked|request\.revision/);
  assert.match(walletProvider, /"\/api\/auth\/wallet\/session",\s*\{ method: "DELETE" \}/);
  assert.doesNotMatch(walletProvider, /verificationRequest|\/api\/verification\/session/);
  assert.match(flow, /disabled=\{persistentWallet\.disconnecting\}\s*onClick=\{\(\) => void disconnectWallet\(\)\}/);
  assert.match(flow, /key=\{persistentWallet\.disconnectVersion\}/);
  assert.match(flow, /if \(!persistentWallet\.authenticated \|\| !wallet\) return/);
  assert.match(flow, /influencedx:studionet-activation:\$\{wallet\.toLowerCase\(\)\}/);
  assert.match(walletProvider, /method: "wallet_revokePermissions"[\s\S]*catch \{/);
  assert.match(flow, /switchingWalletRef\.current = true/);
  assert.match(flow, /generation !== flowGenerationRef\.current/);
  assert.match(flow, /if \(recovery\) \{[\s\S]*confirmActivation\(recovery, generation\);[\s\S]*return;/);
  assert.match(flow, /record: submitActivationReceipt/);
  assert.match(flow, /onSubmitted: \(value\) => \{ if \(isCurrent\(\)\) setRecovery\(value\); \}/);
  assert.match(walletProvider, /flushActivationReceipts\(\)\.catch\(\(\) => undefined\);\s*if \(disconnectPending\.current \|\| disconnected\.current\) return;/);
  assert.match(walletProvider, /Signed out\. Choose another account in your wallet to switch\./);
  assert.match(flow, /className="verify-secondary verify-switch-wallet"/);
  assert.ok(
    flow.indexOf('className="verify-secondary verify-switch-wallet"')
      < flow.indexOf("{activeStep === 1 ?"),
    "wallet switch must stay above every step card",
  );
  assert.match(styles, /\.verify-switch-wallet\s*\{[^}]*min-height:\s*44px;/s);
  assert.match(styles, /@media \(max-width: 980px\)[\s\S]*\.verify-overview \{ display: none; \}/);
  assert.match(styles, /@media \(max-width: 680px\)[\s\S]*\.verify-layout \{ width: auto; padding: 18px 18px 70px; \}/);
  assert.match(walletSelection, /return requestWallet \?\? connectedWallet \?\? null;/);
});

type RequestStore = NonNullable<Parameters<typeof createNativeVerificationRequest>[1]>;
type StoredRequest = NonNullable<Awaited<ReturnType<RequestStore["findActive"]>>>;
const sessionTestNow = Date.parse("2026-09-06T12:00:00Z");
const sessionTestWallet = `0x${"12".repeat(20)}`;
const sessionTestOptions = { nowMs: sessionTestNow, secret: "verification-session-unit-test-secret-only" };

function requestStoreFixture() {
  const pending = createPendingWalletSession(sessionTestOptions);
  const session = authenticateWalletSession(pending, sessionTestWallet, sessionTestOptions);
  let row: StoredRequest | null = null;
  let authorizationWrites = 0;
  let expiryChecks = 0;
  const store: RequestStore = {
    async expireStale() { expiryChecks += 1; },
    async findActive() { return row; },
    async insert(values) {
      // Match database defaults, including null timestamps used by the projection.
      const defaults = Object.fromEntries(Object.entries(getTableColumns(verificationRequests))
        .map(([name, column]) => [name, column.default ?? null]));
      row = { ...defaults, ...values } as StoredRequest;
      return row;
    },
    async authorizePending(current, nowMs) {
      assert.equal(current, row);
      authorizationWrites += 1;
      row = {
        ...current,
        status: "WALLET_AUTHORIZED",
        walletAuthorizedAt: nowMs,
        walletNonce: null,
        walletMessage: null,
        requestExpiresAt: nowMs + 86_400_000,
        revision: current.revision + 1,
        updatedAt: nowMs,
      };
      return row;
    },
  };
  const input = { session, wallet: sessionTestWallet, nowMs: sessionTestNow, origin: "https://app.example" };
  return {
    input, pending, store,
    row: () => row!,
    authorizationWrites: () => authorizationWrites,
    expiryChecks: () => expiryChecks,
  };
}

test("Verify reuses a valid wallet session without another signature or challenge", async () => {
  const fixture = requestStoreFixture();
  const created = await createNativeVerificationRequest(fixture.input, fixture.store);
  assert.equal(created.request.status, "WALLET_AUTHORIZED");
  assert.equal(created.request.walletAuthorizedAt, new Date(sessionTestNow).toISOString());
  assert.equal(created.message, null);
  assert.equal(fixture.row().walletMessage, null);
  assert.equal(fixture.row().walletNonce, null);
  assert.equal(fixture.row().walletSignatureHash, null, "must not invent a per-request signature");
  assert.equal(fixture.row().requestExpiresAt, sessionTestNow + 86_400_000);
  assert.equal(fixture.row().ownerUserId, fixture.input.session.subject);
  const restored = await createNativeVerificationRequest(fixture.input, fixture.store);
  assert.deepEqual(restored, created, "navigation/reload must reuse the same request");
  assert.equal(fixture.authorizationWrites(), 0);
});

test("an unsigned pending session still requires a wallet signature", async () => {
  const fixture = requestStoreFixture();
  const result = await createNativeVerificationRequest({ ...fixture.input, session: fixture.pending }, fixture.store);
  assert.equal(result.request.status, "WALLET_CHALLENGE_PENDING");
  assert.equal(result.request.walletAuthorizedAt, null);
  assert.ok(result.message?.includes(sessionTestWallet));
  assert.ok(fixture.row().walletNonce);
  assert.equal(fixture.authorizationWrites(), 0);
});

test("an existing unsigned Verify request advances once after shared sign-in", async () => {
  const fixture = requestStoreFixture();
  const pending = await createNativeVerificationRequest({ ...fixture.input, session: fixture.pending }, fixture.store);
  const authorized = await createNativeVerificationRequest(fixture.input, fixture.store);
  assert.equal(authorized.request.id, pending.request.id);
  assert.equal(authorized.request.revision, pending.request.revision + 1);
  assert.equal(authorized.request.status, "WALLET_AUTHORIZED");
  assert.equal(authorized.message, null);
  assert.equal(fixture.row().walletNonce, null);
  assert.equal(fixture.row().walletSignatureHash, null);
  await createNativeVerificationRequest(fixture.input, fixture.store);
  assert.equal(fixture.authorizationWrites(), 1);
});

test("Verify refuses expired or wrong-wallet sessions before any storage mutation", async () => {
  const fixture = requestStoreFixture();
  for (const [input, expectedCode] of [
    [{ ...fixture.input, wallet: `0x${"34".repeat(20)}` }, "SESSION_WALLET_MISMATCH"],
    [{ ...fixture.input, nowMs: fixture.input.session.expiresAt * 1_000 }, "WALLET_AUTHENTICATION_REQUIRED"],
  ] as const) {
    await assert.rejects(() => createNativeVerificationRequest(input, fixture.store),
      (error: unknown) => error instanceof ApiProblem && error.code === expectedCode);
  }
  assert.equal(fixture.expiryChecks(), 0);
  assert.equal(fixture.row(), null);
});

test("session reuse cannot revive detached, expired, prepared, or stale pending runs", async () => {
  for (const change of [
    { sessionDetachedAt: sessionTestNow },
    { walletChallengeExpiresAt: sessionTestNow },
    { requestExpiresAt: sessionTestNow },
    { activationPreparedId: "already-prepared" },
    { genlayerTxHash: `0x${"56".repeat(32)}` },
  ] satisfies Partial<StoredRequest>[]) {
    const fixture = requestStoreFixture();
    await createNativeVerificationRequest({ ...fixture.input, session: fixture.pending }, fixture.store);
    Object.assign(fixture.row(), change);
    await assert.rejects(() => createNativeVerificationRequest(fixture.input, fixture.store),
      (error: unknown) => error instanceof ApiProblem && error.code === "STATE_CHANGED");
    assert.equal(fixture.authorizationWrites(), 0);
  }
  const fixture = requestStoreFixture();
  await createNativeVerificationRequest({ ...fixture.input, session: fixture.pending }, fixture.store);
  fixture.store.authorizePending = async () => null;
  await assert.rejects(() => createNativeVerificationRequest(fixture.input, fixture.store),
    (error: unknown) => error instanceof ApiProblem && error.code === "STATE_CHANGED");
  assert.equal(fixture.row().status, "WALLET_CHALLENGE_PENDING");
});

test("session reuse does not restart a transaction already in progress", async () => {
  const fixture = requestStoreFixture();
  await createNativeVerificationRequest(fixture.input, fixture.store);
  Object.assign(fixture.row(), {
    status: "READY_FOR_GENLAYER",
    activationPreparedId: "prepared-request",
    activationTxHash: `0x${"78".repeat(32)}`,
  });
  const before = { ...fixture.row() };
  const result = await createNativeVerificationRequest(fixture.input, fixture.store);
  assert.equal(result.request.status, "READY_FOR_GENLAYER");
  assert.equal(result.request.activationTxHash, before.activationTxHash);
  assert.deepEqual(fixture.row(), before);
  assert.equal(fixture.authorizationWrites(), 0);
});

test("a freshly authenticated wallet resumes its saved run without changing the journal", async () => {
  const fixture = requestStoreFixture();
  const previousOwner = "S".repeat(43);
  await createNativeVerificationRequest(fixture.input, fixture.store);
  const active = { ...fixture.row(), ownerUserId: previousOwner, activeOwnerUserId: previousOwner };
  const snapshot = { ...active };
  const restored = await restoreNativeVerificationWalletSession(fixture.input.session, async (wallet) => {
    assert.equal(wallet, sessionTestWallet);
    return active;
  }, sessionTestNow);
  assert.equal(restored.subject, previousOwner);
  assert.equal(restored.wallet, fixture.input.session.wallet);
  assert.equal(restored.stage, "authenticated");
  assert.equal(restored.expiresAt, fixture.input.session.expiresAt);
  assert.deepEqual(active, snapshot, "recovery must not alter ownership, revisions, or activation evidence");
  assert.deepEqual(await restoreNativeVerificationWalletSession(fixture.input.session, async () => null, sessionTestNow), fixture.input.session);
});

test("wallet recovery refuses unsigned, expired, mismatched, and invalid owner bindings", async () => {
  const fixture = requestStoreFixture();
  let lookups = 0;
  await createNativeVerificationRequest(fixture.input, fixture.store);
  const unusedLookup = async () => { lookups += 1; return null; };
  for (const session of [fixture.pending, { ...fixture.input.session, expiresAt: sessionTestNow / 1_000 }]) {
    await assert.rejects(() => restoreNativeVerificationWalletSession(
      session as typeof fixture.input.session, unusedLookup, sessionTestNow,
    ), (error: unknown) => error instanceof ApiProblem && error.code === "WALLET_AUTHENTICATION_REQUIRED");
  }
  assert.equal(lookups, 0);
  for (const active of [
    { ownerUserId: "S".repeat(43), activeOwnerUserId: "S".repeat(43), wallet: `0x${"34".repeat(20)}` },
    { ownerUserId: "S".repeat(43), activeOwnerUserId: "T".repeat(43), wallet: sessionTestWallet },
    { ownerUserId: "invalid", activeOwnerUserId: "invalid", wallet: sessionTestWallet },
  ]) {
    await assert.rejects(() => restoreNativeVerificationWalletSession(fixture.input.session, async () => ({ ...fixture.row(), ...active }), sessionTestNow),
      (error: unknown) => error instanceof ApiProblem && error.code === "STATE_CHANGED");
  }
});

test("a fresh signature never adopts an unsigned reservation from another browser", async () => {
  const fixture = requestStoreFixture();
  await createNativeVerificationRequest({ ...fixture.input, session: fixture.pending }, fixture.store);
  const unsigned = { ...fixture.row(), ownerUserId: "U".repeat(43), activeOwnerUserId: "U".repeat(43) };
  const released: string[] = [];
  const resumed = await restoreNativeVerificationWalletSession(fixture.input.session, async () => unsigned, sessionTestNow, async (row) => {
    released.push(row.id);
    return true;
  });
  assert.equal(resumed.subject, fixture.input.session.subject);
  assert.deepEqual(released, [unsigned.id]);
  await assert.rejects(() => restoreNativeVerificationWalletSession(fixture.input.session, async () => unsigned, sessionTestNow, async () => false),
    (error: unknown) => error instanceof ApiProblem && error.code === "STATE_CHANGED");
});

test("an old unsigned cookie cannot read an authorized run through the challenge endpoint", async () => {
  const fixture = requestStoreFixture();
  await createNativeVerificationRequest(fixture.input, fixture.store);
  await assert.rejects(() => createNativeVerificationRequest({ ...fixture.input, session: fixture.pending }, fixture.store),
    (error: unknown) => error instanceof ApiProblem && error.code === "WALLET_AUTHENTICATION_REQUIRED");
  assert.equal(fixture.authorizationWrites(), 0);
});

test("recovering the saved owner happens only after signature proof and requires authenticated run access", async () => {
  const [authorize, status, cancel] = await Promise.all([
    source("../app/api/auth/wallet/authorize/route.ts"),
    source("../app/api/verification/status/route.ts"),
    source("../app/api/verification/session/route.ts"),
  ]);
  const proof = authorize.indexOf("await verifyMarketplaceWalletSignIn");
  const restore = authorize.indexOf("await restoreNativeVerificationWalletSession");
  assert.ok(proof >= 0 && restore > proof);
  assert.match(authorize, /authenticateWalletSession\(session, verifiedWallet\)/);
  assert.match(status, /if \(!session \|\| !isAuthenticatedWalletSession\(session\)\)/);
  assert.match(cancel, /if \(!session \|\| !isAuthenticatedWalletSession\(session\)\)/);
  assert.match(cancel, /walletSessionMatches\(session, current\.wallet\)/);
});

test("verification UI keeps concise safety and recovery copy", async () => {
  const flow = await source("../app/verify/VerifyFlow.tsx");
  assert.match(flow, /Post both before \$\{epochLabel\(challengeExpiry\)\}/);
  assert.match(flow, /Verify these public accounts\./);
  assert.match(flow, /Still finalizing\./);
  assert.match(flow, /Saved transaction cleared\. Retry\./);
  assert.match(flow, /Transaction cancelled\. Retry verification\./);
  assert.doesNotMatch(flow, /Retry with the same two posts|Wallet verified\.|Post both messages\.|Checking both posts/);
  assert.doesNotMatch(flow, /\["TRANSACTION"|\["IDENTITIES"/);
});

async function source(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

function between(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker: ${end}`);
  return value.slice(startIndex, endIndex);
}

function assertProblem(
  action: () => void,
  status: number,
  code: string,
): void {
  assert.throws(action, (error: unknown) => (
    error instanceof ApiProblem
    && error.status === status
    && error.code === code
  ));
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
