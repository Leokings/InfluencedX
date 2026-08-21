import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ApiProblem,
  assertSameOriginRequest,
  readSameOriginDeleteJson,
} from "../lib/verification-api.ts";
import {
  hasNativeVerificationActivationState,
} from "../lib/verification-native-service.ts";
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
    "export async function authorizeNativeWalletSessionClear",
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

test("generic wallet logout cannot bypass an unsafe active verification", async () => {
  const [route, service] = await Promise.all([
    source("../app/api/auth/wallet/session/route.ts"),
    source("../lib/verification-native-service.ts"),
  ]);
  const sameOrigin = route.indexOf('assertSameOriginRequest(request, "DELETE")');
  const readSession = route.indexOf("readWalletSession(request)", sameOrigin);
  const guard = route.indexOf("await authorizeNativeWalletSessionClear", readSession);
  const clearCookie = route.indexOf("return clearWalletSessionCookies", guard);
  assert.ok(sameOrigin >= 0 && readSession > sameOrigin && guard > readSession && clearCookie > guard);
  assert.match(route, /catch \(error\) \{\s*return apiError\(error\);\s*\}/);

  const guardService = between(
    service,
    "export async function authorizeNativeWalletSessionClear",
    "async function owned",
  );
  assert.match(guardService, /await activeOwned\(input\.ownerUserId\)/);
  assert.match(guardService, /if \(!active\) return Object\.freeze\(\{ processing: false \}\)/);
  assert.match(guardService, /ACTIVE_VERIFICATION_EXISTS[\s\S]*\/verify/);
});

test("a server-bound hash detaches the wallet without mutating verification evidence", async () => {
  const service = await source("../lib/verification-native-service.ts");
  const endMutation = between(
    service,
    "export async function endNativeVerificationRun",
    "export async function authorizeNativeWalletSessionClear",
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
  const [service, flow] = await Promise.all([
    source("../lib/verification-native-service.ts"),
    source("../app/verify/VerifyFlow.tsx"),
  ]);
  const endMutation = between(
    service,
    "export async function endNativeVerificationRun",
    "export async function authorizeNativeWalletSessionClear",
  );
  assert.match(endMutation, /hasNativeVerificationActivationState\(active\)[\s\S]*VERIFICATION_TRANSACTION_PENDING/);
  assert.match(flow, /Transaction cancelled\. Retry verification\./);
  assert.doesNotMatch(flow, /walletSwitchBlocked/);
  assert.match(flow, /"\/api\/verification\/session"/);
  assert.doesNotMatch(service, /USER_CANCELLED|cancel.*prepared/i);
  assert.doesNotMatch(endMutation, /update\(marketplaceGenLayerTransactions\)/);
});

test("expired finalized UNDETERMINED release has exact immutable finality proof", async () => {
  const service = await source("../lib/verification-native-service.ts");
  const endMutation = between(
    service,
    "export async function endNativeVerificationRun",
    "export async function authorizeNativeWalletSessionClear",
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

test("detached finalized runs cannot retain verification locks forever", async () => {
  const [service, maintenance, activation] = await Promise.all([
    source("../lib/verification-native-service.ts"),
    source("../lib/marketplace-genlayer-maintenance.ts"),
    source("../lib/marketplace-genlayer-activation.ts"),
  ]);
  const cleanup = between(
    service,
    "export async function releaseExpiredDetachedNativeVerificationRuns",
    "function projection",
  );
  assert.match(cleanup, /isNotNull\(verificationRequests\.sessionDetachedAt\)/);
  assert.match(cleanup, /isNotNull\(verificationRequests\.activeOwnerUserId\)/);
  assert.match(cleanup, /releaseExpiredFinalizedUndetermined\(row, nowMs\)/);
  assert.match(maintenance, /runGenLayerJournalReconciliationBatch[\s\S]*releaseExpiredDetachedNativeVerificationRuns[\s\S]*runGenLayerProgressionBatch/);

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
    "export async function authorizeNativeWalletSessionClear",
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

test("verification UI exposes exact, mobile-safe wallet switching", async () => {
  const [flow, styles, walletSelection] = await Promise.all([
    source("../app/verify/VerifyFlow.tsx"),
    source("../app/globals.css"),
    source("../lib/verification-wallet.ts"),
  ]);
  assert.match(flow, /activeRunRequest[\s\S]*window\.confirm\([\s\S]*Sign out\? Transaction will continue\.[\s\S]*Switch wallet\? This run will end\./);
  assert.match(flow, /if \(activeRunRequest\) \{[\s\S]*"\/api\/verification\/session"[\s\S]*requestId: activeRunRequest\.id,[\s\S]*revision: activeRunRequest\.revision/);
  assert.match(flow, /else \{[\s\S]*"\/api\/auth\/wallet\/session"/);
  assert.match(flow, /VERIFICATION_TRANSACTION_PENDING: "Finish the transaction first\."/);
  assert.match(flow, /clearRecovery\(\);[\s\S]*setRequest\(null\);[\s\S]*setWallet\(null\);/);
  for (const reset of [
    "setWalletChallenge(null)",
    'setHandle("")',
    'setPostUrl("")',
    'setFarcasterUsername("")',
    'setFarcasterCastUrl("")',
    "setConsent(false)",
    "setProfiles(null)",
    "setBundle(null)",
  ]) assert.match(flow, new RegExp(escapeRegExp(reset)));
  assert.match(flow, /method: "wallet_revokePermissions"[\s\S]*catch \{/);
  assert.match(flow, /switchingWalletRef\.current = true/);
  assert.match(flow, /generation !== flowGenerationRef\.current/);
  assert.match(flow, /if \(recovery\) \{[\s\S]*confirmActivation\(recovery, generation\);[\s\S]*return;[\s\S]*setActivationDetachReady\(false\);/);
  assert.match(flow, /busy === "activation" && activationDetachReady/);
  assert.match(flow, /setActivationDetachReady\(true\)/);
  assert.match(flow, /if \(switchingWalletRef\.current\) \{[\s\S]*setError\(null\);[\s\S]*return;/);
  assert.match(flow, /const revoked = await revokeWalletPermissions\(\)/);
  assert.match(flow, /App signed out\. Choose another account in your wallet\./);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
