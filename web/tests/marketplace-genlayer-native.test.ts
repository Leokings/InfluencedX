import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { abi } from "genlayer-js";

import {
  hydrateArgs,
  isExplicitEip1193UserRejection,
} from "../app/marketplace/marketplace-transaction.ts";
import { buildCampaignContractBrief } from "../lib/marketplace-core.ts";
import {
  buildGenLayerSubmissionCall,
  genLayerCampaignActionPostcondition,
  genLayerUnallocatedRefundAvailability,
  nextGenLayerResolutionProgression,
} from "../lib/marketplace-genlayer-actions.ts";
import {
  assertFinalizedOwnershipTiming,
  projectIdentityActiveAt,
  resolveFarcasterCastHashFromUrl,
  resolveFarcasterFidByUsername,
  validateStoredActivationTiming,
} from "../lib/marketplace-genlayer-activation.ts";
import {
  GenLayerProgressionRetryError,
  assignmentExpiryIsDue,
  campaignFinalizationIsDue,
  reconcileQueuedGenLayerProgression,
  runGenLayerProgressionBatch,
} from "../lib/marketplace-genlayer-progression.ts";
import {
  assertCampaignStateAccounting,
  campaignTermsCanonicalJson,
  deriveCampaignId,
  deriveCampaignTermsHash,
  deriveFarcasterOwnershipRequestId,
  deriveIdentityBundleRequestId,
  deriveProjectionId,
  deriveResolutionRequestId,
  genLayerCampaignCancellationAvailability,
  genLayerResolutionAvailability,
  normalizeContractText,
  parseCampaignState,
  parseOwnershipResult,
  parseIdentityBundleResult,
  parseRejectedBundleOwnershipResult,
  ownershipOutcomeAllowsRetry,
  type GenLayerAssignmentState,
  type GenLayerCampaignState,
} from "../lib/marketplace-genlayer-core.ts";
import {
  existingPreparedMarketplaceTransactionDisposition,
  MAX_GENLAYER_RECONCILIATION_ATTEMPTS,
  type GenLayerTransactionRow,
  type GenLayerAssignmentProjection,
  type GenLayerCampaignProjection,
} from "../lib/marketplace-genlayer-repository.ts";
import {
  runGenLayerJournalReconciliationBatch,
} from "../lib/marketplace-genlayer-journal.ts";
import {
  MarketplaceMaintenanceDeploymentConfigurationError,
  MarketplaceMaintenanceGenerationConflictError,
  marketplaceMaintenanceDeploymentContext,
  promoteMarketplaceMaintenanceGeneration,
  type MarketplaceMaintenanceDeploymentContext,
  type MarketplaceMaintenanceGeneration,
  type MarketplaceMaintenanceGenerationStore,
} from "../lib/marketplace-genlayer-maintenance-generation.ts";
import {
  MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS,
  MARKETPLACE_MAINTENANCE_QUEUE_TOPIC,
  MARKETPLACE_MAINTENANCE_RETENTION_SECONDS,
  MarketplaceMaintenanceMessageError,
  enqueueMarketplaceMaintenanceHeartbeat,
  validateMarketplaceMaintenanceMessage,
} from "../lib/marketplace-genlayer-maintenance-queue.ts";
import {
  processMarketplaceMaintenanceHeartbeat,
} from "../lib/marketplace-genlayer-maintenance-worker.ts";
import type {
  GenLayerOperatorAction,
  GenLayerOperatorProjection,
  GenLayerOperatorStatus,
} from "../lib/marketplace-genlayer-operator-client.ts";
import {
  assertTransactionMatchesPreparedCall,
  canonicalHash,
  canonicalJson,
  finalizedExecution,
  loadFinalizedMarketplaceTransaction,
  marketplaceRpcContractAddress,
  MarketplaceGenLayerFinalityError,
  terminalMarketplaceTransactionStatus,
  type FinalizedMarketplaceTransaction,
  type MarketplaceGenLayerCall,
} from "../lib/marketplace-genlayer-rpc.ts";
import {
  CREDENTIAL_TTL_MS,
  X_CHALLENGE_TTL_MS,
} from "../lib/verification-core.ts";

const brand = "0x1111111111111111111111111111111111111111";
const contract = "0x2222222222222222222222222222222222222222" as const;
const txHash = `0x${"33".repeat(32)}`;
const campaignId = `0x${"44".repeat(32)}`;
const assignmentId = `0x${"45".repeat(32)}`;
const requestId = `0x${"46".repeat(32)}`;
const marketplaceAddress = "0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb";
const creator = "0x5555555555555555555555555555555555555555";
const maintenanceDeploymentId = "dpl_7Gw5ZMBpQA8h9GF832KGp7nwbuh3";
const nextMaintenanceDeploymentId = "dpl_8Hx6ANCqRB9i0HG943LHq8oxcvi4";
const maintenanceProjectId = "prj_Rej9WaMNRbffVm34MfDqa4daCEvZzzE";
const maintenanceContext: MarketplaceMaintenanceDeploymentContext = {
  deploymentId: maintenanceDeploymentId,
  projectId: maintenanceProjectId,
  environment: "preview",
};

test("StudioNet RPC calls preserve the deployed checksum address", () => {
  assert.equal(
    marketplaceRpcContractAddress(),
    "0xb72FE7272A5aEdf3c6Ba893394EbeF818fd86Fbb",
  );
});

test("web configuration and the deployment manifest pin the fresh StudioNet marketplace", async () => {
  const [manifestText, environmentExample] = await Promise.all([
    readFile(
      new URL("../../deployments/genlayer-studionet.json", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as {
    marketplace: {
      address: string;
      deploymentTransaction: string;
      deployedAt: string;
      sourceSha256: string;
      sourceCommit: string;
    };
    historicalMarketplaces: Array<{ address: string }>;
  };
  assert.equal(
    manifest.marketplace.address,
    "0xb72FE7272A5aEdf3c6Ba893394EbeF818fd86Fbb",
  );
  assert.equal(
    manifest.marketplace.deploymentTransaction,
    "0x05ff78998a2b389c7e102f6f09b893dbd16d376f3c18f9748b2b8ef9de5e7998",
  );
  assert.equal(manifest.marketplace.deployedAt, "2026-08-19T21:45:34.887910Z");
  assert.equal(
    manifest.marketplace.sourceSha256,
    "0xcdb7a7126cb59705bddf8862c49d9ce6d49c9c18e792d4851c071ad403d10705",
  );
  assert.equal(
    manifest.marketplace.sourceCommit,
    "8271a92172eb5c014a930ef31611fb956908de16",
  );
  assert.ok(
    manifest.historicalMarketplaces.some(
      (marketplace) =>
        marketplace.address === "0xEaCeBa807a7A4dc370f3B5a8e45539596b8551b4",
    ),
  );
  assert.match(
    environmentExample,
    /^INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS=0xb72FE7272A5aEdf3c6Ba893394EbeF818fd86Fbb$/m,
  );
  assert.match(
    environmentExample,
    /^NEXT_PUBLIC_INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS=0xb72FE7272A5aEdf3c6Ba893394EbeF818fd86Fbb$/m,
  );
});

test("resolves the canonical Farcaster FID from the username proof server-side", async () => {
  const fid = await resolveFarcasterFidByUsername("@DWR", {
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://fnames.farcaster.xyz");
      assert.equal(url.pathname, "/transfers/current");
      assert.equal(url.searchParams.get("name"), "dwr");
      assert.equal(init?.method, "GET");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("accept-encoding"), "identity");
      return new Response(JSON.stringify({
        transfer: {
          to: 3,
          username: "dwr",
          owner: "0x1111111111111111111111111111111111111111",
          server_signature: `0x${"ab".repeat(65)}`,
          timestamp: 1_700_000_000,
        },
      }), { headers: { "Content-Type": "application/json" } });
    },
  });
  assert.equal(fid, "3");
});

test("Farcaster FID lookup rejects missing, malformed, mismatched, or confusable proofs", async () => {
  await assert.rejects(
    () => resolveFarcasterFidByUsername("missing", {
      fetchImpl: async () => new Response("", { status: 404 }),
    }),
    (error: unknown) => (error as { code?: string }).code === "FARCASTER_USERNAME_NOT_FOUND",
  );
  await assert.rejects(
    () => resolveFarcasterFidByUsername("alice", {
      fetchImpl: async () => new Response(JSON.stringify({
        transfer: {
          to: 1,
          username: "mallory",
          owner: "0x1111111111111111111111111111111111111111",
          server_signature: `0x${"ab".repeat(65)}`,
          timestamp: 1_700_000_000,
        },
      }), { headers: { "Content-Type": "application/json" } }),
    }),
    (error: unknown) => (error as { code?: string }).code === "FARCASTER_IDENTITY_LOOKUP_INVALID",
  );
  await assert.rejects(
    () => resolveFarcasterFidByUsername("alice", {
      fetchImpl: async () => new Response(JSON.stringify({
        transfer: {
          to: 1,
          username: "alice",
          owner: "0x1111111111111111111111111111111111111111",
          server_signature: `0x${"ab".repeat(64)}`,
          timestamp: 1_700_000_000,
        },
      }), { headers: { "Content-Type": "application/json" } }),
    }),
    (error: unknown) => (error as { code?: string }).code === "FARCASTER_IDENTITY_LOOKUP_INVALID",
  );
  await assert.rejects(
    () => resolveFarcasterFidByUsername("alice", {
      fetchImpl: async () => new Response("<html>not a proof</html>", {
        headers: { "Content-Type": "text/html" },
      }),
    }),
    (error: unknown) => (error as { code?: string }).code === "FARCASTER_IDENTITY_LOOKUP_INVALID",
  );
  await assert.rejects(
    () => resolveFarcasterFidByUsername("alice", {
      fetchImpl: async () => new Response("x".repeat(8_193), {
        headers: { "Content-Type": "application/json" },
      }),
    }),
    (error: unknown) => (error as { code?: string }).code === "FARCASTER_IDENTITY_LOOKUP_INVALID",
  );
  await assert.rejects(
    () => resolveFarcasterFidByUsername("Kevin", {
      fetchImpl: async () => { throw new Error("fetch must not run"); },
    }),
    (error: unknown) => (error as { code?: string }).code === "INVALID_FARCASTER_USERNAME",
  );
});

test("resolves an ENS-slug Farcaster cast URL to its exact FID-bound protocol hash", async () => {
  const exactHash = `0x029f7cce${"ab".repeat(16)}`;
  const resolved = await resolveFarcasterCastHashFromUrl(
    "https://farcaster.xyz/dwr.eth/0x029F7CCE?ref=share",
    { expectedUsername: "dwr", expectedFid: "3" },
    {
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.origin, "https://client.farcaster.xyz");
        assert.equal(url.pathname, "/v2/user-cast");
        assert.equal(url.searchParams.get("username"), "dwr.eth");
        assert.equal(url.searchParams.get("hashPrefix"), "0x029f7cce");
        assert.equal(init?.method, "GET");
        assert.equal(init?.cache, "no-store");
        assert.equal(init?.redirect, "error");
        assert.equal(new Headers(init?.headers).get("accept-encoding"), "identity");
        return new Response(JSON.stringify({
          result: {
            cast: {
              hash: exactHash.toUpperCase().replace(/^0X/, "0x"),
              author: { fid: 3, username: "dwr.eth" },
              timestamp: 1_701_182_672_000,
            },
          },
        }), { headers: { "Content-Type": "application/json" } });
      },
    },
  );
  assert.equal(resolved, exactHash);
});

test("resolves short and full Farcaster conversation URLs through the pinned fname", async () => {
  const exactHash = `0x029f7cce${"cd".repeat(16)}`;
  const seenPrefixes: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("username"), "dwr");
    const prefix = url.searchParams.get("hashPrefix");
    assert.ok(prefix);
    seenPrefixes.push(prefix);
    return new Response(JSON.stringify({
      result: {
        cast: {
          hash: exactHash,
          author: { fid: "3", username: "DWR" },
        },
      },
    }), { headers: { "Content-Type": "application/json" } });
  };

  assert.equal(
    await resolveFarcasterCastHashFromUrl(
      "https://www.farcaster.xyz/~/conversations/0x029f7cce/",
      { expectedUsername: "dwr", expectedFid: 3 },
      { fetchImpl },
    ),
    exactHash,
  );
  assert.equal(
    await resolveFarcasterCastHashFromUrl(
      `https://farcaster.xyz/~/conversations/${exactHash}`,
      { expectedUsername: "dwr", expectedFid: "3" },
      { fetchImpl },
    ),
    exactHash,
  );
  assert.deepEqual(seenPrefixes, ["0x029f7cce", exactHash]);
});

test("Farcaster cast URL resolution rejects unsafe URLs and unbound lookup results", async () => {
  const binding = { expectedUsername: "dwr", expectedFid: "3" };
  for (const value of [
    "http://farcaster.xyz/dwr/0x029f7cce",
    "https://farcaster.xyz.evil.example/dwr/0x029f7cce",
    "https://user@farcaster.xyz/dwr/0x029f7cce",
    "https://farcaster.xyz:443/dwr/0x029f7cce",
    "https://farcaster.xyz:444/dwr/0x029f7cce",
    "https://farcaster.xyz/dwr/0x029f7cc",
  ]) {
    await assert.rejects(
      () => resolveFarcasterCastHashFromUrl(value, binding, {
        fetchImpl: async () => { throw new Error("fetch must not run"); },
      }),
      (error: unknown) =>
        (error as { code?: string }).code === "INVALID_FARCASTER_CAST_URL",
    );
  }

  await assert.rejects(
    () => resolveFarcasterCastHashFromUrl(
      "https://farcaster.xyz/dwr/0x029f7cce",
      binding,
      { fetchImpl: async () => new Response("", { status: 404 }) },
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "FARCASTER_CAST_NOT_FOUND",
  );
  await assert.rejects(
    () => resolveFarcasterCastHashFromUrl(
      "https://farcaster.xyz/dwr.eth/0x029f7cce",
      binding,
      {
        fetchImpl: async () => new Response(JSON.stringify({
          result: {
            cast: {
              hash: `0x029f7cce${"ef".repeat(16)}`,
              author: { fid: 4, username: "mallory" },
            },
          },
        }), { headers: { "Content-Type": "application/json" } }),
      },
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "FARCASTER_CAST_NOT_FOUND",
  );
  await assert.rejects(
    () => resolveFarcasterCastHashFromUrl(
      "https://farcaster.xyz/dwr/0x029f7cce",
      binding,
      {
        fetchImpl: async () => new Response(JSON.stringify({
          result: {
            cast: {
              hash: `0xdeadbeef${"ef".repeat(16)}`,
              author: { fid: 3, username: "dwr" },
            },
          },
        }), { headers: { "Content-Type": "application/json" } }),
      },
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "FARCASTER_CAST_LOOKUP_UNAVAILABLE",
  );
});

test("Farcaster campaign evidence resolves the public URL and freezes the full FID-bound hash in calldata", async () => {
  const exactHash = "0x9625056e23efed813044dffbaf2df94b30ac961e";
  const agreementHash = `0x${"58".repeat(32)}`;
  const creatorIdentityHash = `0x${"59".repeat(32)}`;
  const result = await buildGenLayerSubmissionCall({
    assignmentId,
    agreementHash,
    creatorIdentityHash,
    contentSource: "FARCASTER",
    submittedContent: "https://farcaster.xyz/milechain/0x9625056e",
    expectedUsername: "milechain",
    expectedExternalUserId: "279320",
  }, {
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://client.farcaster.xyz");
      assert.equal(url.pathname, "/v2/user-cast");
      assert.equal(url.searchParams.get("username"), "milechain");
      assert.equal(url.searchParams.get("hashPrefix"), "0x9625056e");
      return new Response(JSON.stringify({
        result: {
          cast: {
            hash: exactHash,
            author: { fid: 279320, username: "milechain" },
          },
        },
      }), { headers: { "Content-Type": "application/json" } });
    },
  });
  const expectedSubmissionHash = canonicalHash({
    protocol: "influencedx-submission-v2",
    assignment_id: assignmentId,
    content_source: "FARCASTER",
    content_id: exactHash,
    creator_identity_hash: creatorIdentityHash,
  });
  const expectedRequestId = deriveResolutionRequestId({
    assignmentId,
    agreementHash,
    submissionHash: expectedSubmissionHash,
    contentSource: "FARCASTER",
    postId: exactHash,
    roundIndex: 0,
  });
  assert.equal(result.contentId, exactHash);
  assert.equal(result.submissionHash, expectedSubmissionHash);
  assert.equal(result.requestId, expectedRequestId);
  assert.equal(result.call.functionName, "submit_evidence");
  assert.deepEqual(result.call.args, [
    assignmentId,
    expectedRequestId,
    exactHash,
    expectedSubmissionHash,
  ]);
  assert.deepEqual(result.call.argTypes, ["string", "string", "string", "string"]);
  assert.equal(result.call.value, "0");
});

test("Farcaster campaign evidence fails closed when the URL lookup is missing or belongs to another FID", async () => {
  const input = {
    assignmentId,
    agreementHash: `0x${"58".repeat(32)}`,
    creatorIdentityHash: `0x${"59".repeat(32)}`,
    contentSource: "FARCASTER" as const,
    submittedContent: "https://farcaster.xyz/milechain/0x9625056e",
    expectedUsername: "milechain",
    expectedExternalUserId: "279320",
  };
  await assert.rejects(
    () => buildGenLayerSubmissionCall(input, {
      fetchImpl: async () => new Response("", { status: 404 }),
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "FARCASTER_CAST_NOT_FOUND",
  );
  await assert.rejects(
    () => buildGenLayerSubmissionCall(input, {
      fetchImpl: async () => new Response(JSON.stringify({
        result: {
          cast: {
            hash: "0x9625056e23efed813044dffbaf2df94b30ac961e",
            author: { fid: 279321, username: "milechain" },
          },
        },
      }), { headers: { "Content-Type": "application/json" } }),
    }),
    (error: unknown) =>
      (error as { code?: string }).code === "FARCASTER_CAST_NOT_FOUND",
  );
});

test("finalized activation recovery validates persisted relative timing without wall-clock expiry", () => {
  // This challenge expired years before the test runs. Recovery is intentionally
  // based on the immutable preparation window, not Date.now().
  const issuedAtMs = 1_700_000_000_123;
  const expiresAtMs = issuedAtMs + X_CHALLENGE_TTL_MS;
  const profileExpiresAtMs = issuedAtMs + CREDENTIAL_TTL_MS;
  const preparedAtMs = issuedAtMs + 60_000;
  const readyForGenLayerAtMs = preparedAtMs + 2_000;
  assert.doesNotThrow(() => validateStoredActivationTiming({
    issuedAtMs,
    expiresAtMs,
    profileExpiresAtMs,
    preparedAtMs,
    readyForGenLayerAtMs,
    contentCreatedAtMs: issuedAtMs + 30_000,
  }));
  const finalizedAtEpoch = Math.floor((expiresAtMs - 1) / 1_000);
  assert.doesNotThrow(() => assertFinalizedOwnershipTiming({
    verifiedAtEpoch: finalizedAtEpoch,
    finalizedAtEpoch,
    preparedAtMs,
    readyForGenLayerAtMs,
    issuedAtMs,
    expiresAtMs,
    profileExpiresAtMs,
  }));

  for (const override of [
    { expiresAtMs: expiresAtMs + 1 },
    { profileExpiresAtMs: profileExpiresAtMs + 1 },
    { preparedAtMs: expiresAtMs },
    { readyForGenLayerAtMs: expiresAtMs },
    { contentCreatedAtMs: expiresAtMs + 1 },
  ]) {
    assert.throws(
      () => validateStoredActivationTiming({
        issuedAtMs,
        expiresAtMs,
        profileExpiresAtMs,
        preparedAtMs,
        readyForGenLayerAtMs,
        contentCreatedAtMs: issuedAtMs + 30_000,
        ...override,
      }),
      /persisted activation|ownership challenge|post timestamp/,
    );
  }
  assert.throws(
    () => assertFinalizedOwnershipTiming({
      verifiedAtEpoch: Math.floor(expiresAtMs / 1_000) + 1,
      finalizedAtEpoch: Math.floor(expiresAtMs / 1_000) + 1,
      preparedAtMs,
      readyForGenLayerAtMs,
      issuedAtMs,
      expiresAtMs,
      profileExpiresAtMs,
    }),
    /finalized ownership result timing/,
  );
  assert.throws(
    () => assertFinalizedOwnershipTiming({
      verifiedAtEpoch: finalizedAtEpoch,
      finalizedAtEpoch: finalizedAtEpoch + 1,
      preparedAtMs,
      readyForGenLayerAtMs,
      issuedAtMs,
      expiresAtMs,
      profileExpiresAtMs,
    }),
    /finalized ownership result timing/,
  );
  assert.throws(
    () => assertFinalizedOwnershipTiming({
      verifiedAtEpoch: Math.floor(issuedAtMs / 1_000),
      finalizedAtEpoch: Math.floor(issuedAtMs / 1_000),
      preparedAtMs,
      readyForGenLayerAtMs,
      issuedAtMs,
      expiresAtMs,
      profileExpiresAtMs,
    }),
    /finalized ownership result timing/,
  );
});

test("activation confirmation uses the stored envelope while preparation still enforces expiry", async () => {
  const activation = await readFile(
    new URL("../lib/marketplace-genlayer-activation.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    activation,
    /const envelope = storedActivationEnvelope\(row, row\.identitySource, prepared\);/,
  );
  assert.match(
    activation,
    /function prepareActivationEnvelope[\s\S]*expiresAtMs <= input\.nowMs[\s\S]*CHALLENGE_EXPIRED/,
  );
  assert.match(
    activation,
    /function storedActivationEnvelope[\s\S]*preparedAtMs: prepared\.createdAt[\s\S]*readyForGenLayerAtMs: row\.readyForGenLayerAt/,
  );
  assert.doesNotMatch(
    activation,
    /function storedActivationEnvelope[\s\S]*?\n}\n[\s\S]*?Date\.now\(\)/,
  );
});

test("expired credentials project inactive without invalidating earlier finality", () => {
  const expiresAtEpoch = 1_800_000_900;
  assert.equal(projectIdentityActiveAt({
    contractActive: true,
    expiresAtEpoch,
    nowMs: expiresAtEpoch * 1_000 - 1,
  }), true);
  assert.equal(projectIdentityActiveAt({
    contractActive: true,
    expiresAtEpoch,
    nowMs: expiresAtEpoch * 1_000,
  }), false);
  assert.equal(projectIdentityActiveAt({
    contractActive: false,
    expiresAtEpoch,
    nowMs: expiresAtEpoch * 1_000 - 1,
  }), false);
});

const frozenTerms = {
  contentSource: "X" as const,
  title: "Launch Sprint",
  brief: "Publish an honest product walkthrough.",
  requiredPhrases: ["InfluencedX"],
  forbiddenPhrases: ["guaranteed profit"],
  requireAdDisclosure: true,
  applicationDeadlineEpoch: 1_800_000_300,
  selectionDeadlineEpoch: 1_800_000_600,
  submissionDeadlineEpoch: 1_800_000_900,
  retentionSeconds: 3_600,
  maxUndeterminedRetries: 2,
};

test("campaign IDs exactly match the frozen contract domains and canonical JSON", () => {
  assert.equal(
    campaignTermsCanonicalJson(frozenTerms),
    '{"application_deadline_epoch":1800000300,"brief":"Publish an honest product walkthrough.","content_source":"X","forbidden_phrases":["guaranteed profit"],"max_undetermined_retries":2,"require_ad_disclosure":true,"required_phrases":["InfluencedX"],"retention_seconds":3600,"selection_deadline_epoch":1800000600,"submission_deadline_epoch":1800000900,"title":"Launch Sprint"}',
  );
  const termsHash = deriveCampaignTermsHash(frozenTerms);
  assert.equal(termsHash, "0x41b76f0815cdb5c9ebed7d3274744686a3345d3e2d1248d85b7816d234ab29c0");
  assert.equal(
    deriveCampaignId({
      brand,
      clientNonce: "client-0001",
      termsHash,
      budgetAtto: "1000000000000000000",
    }),
    "0x2b9d6f6f108b98d9c66577faf5251ea1524073fd8be7012196ea331a2d294b24",
  );
});

test("campaign canonical JSON matches Python ensure_ascii for Unicode terms", () => {
  const unicodeTerms = {
    ...frozenTerms,
    contentSource: "FARCASTER" as const,
    title: "Café 🚀",
    brief: "Résumé for naïve creators",
    requiredPhrases: ["café", "🚀"],
    forbiddenPhrases: ["déjà vu"],
  };
  assert.equal(
    campaignTermsCanonicalJson(unicodeTerms),
    '{"application_deadline_epoch":1800000300,"brief":"R\\u00e9sum\\u00e9 for na\\u00efve creators","content_source":"FARCASTER","forbidden_phrases":["d\\u00e9j\\u00e0 vu"],"max_undetermined_retries":2,"require_ad_disclosure":true,"required_phrases":["caf\\u00e9","\\ud83d\\ude80"],"retention_seconds":3600,"selection_deadline_epoch":1800000600,"submission_deadline_epoch":1800000900,"title":"Caf\\u00e9 \\ud83d\\ude80"}',
  );
  assert.equal(
    deriveCampaignTermsHash(unicodeTerms),
    "0x5cc59a41f657cc65acf8bdbb15db87b7908e69fe365cf256120b991e9f66ffad",
  );
});

test("contract text and JSON parity cover whitespace, code points, and DEL", () => {
  assert.equal(canonicalJson({ value: "\u007f" }), '{"value":"\\u007f"}');
  assert.equal(normalizeContractText("  alpha\t beta\n gamma  ", "text", 1, 80), "alpha beta gamma");
  assert.equal(normalizeContractText("🚀🚀🚀🚀🚀", "title", 5, 5), "🚀🚀🚀🚀🚀");
  assert.throws(() => normalizeContractText("🚀🚀🚀🚀", "title", 5, 120), /length/);
  assert.equal(
    deriveCampaignTermsHash({
      ...frozenTerms,
      title: " Launch\t Sprint ",
      brief: " Publish  an honest product\nwalkthrough. ",
      requiredPhrases: [" InfluencedX "],
      forbiddenPhrases: ["guaranteed\tprofit"],
    }),
    deriveCampaignTermsHash(frozenTerms),
  );
});

test("campaign deliverables are committed into the exact contract brief and terms hash", async () => {
  const first = buildCampaignContractBrief(
    "Publish an honest product walkthrough.",
    ["Show onboarding", "Disclose sponsorship"],
  );
  const second = buildCampaignContractBrief(
    "Publish an honest product walkthrough.",
    ["Show onboarding", "Include pricing"],
  );
  assert.equal(
    first,
    "Publish an honest product walkthrough. Deliverables: 1. Show onboarding | 2. Disclose sponsorship",
  );
  assert.notEqual(first, second);
  assert.notEqual(
    deriveCampaignTermsHash({ ...frozenTerms, brief: first }),
    deriveCampaignTermsHash({ ...frozenTerms, brief: second }),
  );
  assert.throws(
    () => buildCampaignContractBrief("Valid brief", ["x".repeat(4_000)]),
    /semanticBrief/,
  );
  const service = await readFile(
    new URL("../lib/marketplace-genlayer-service.ts", import.meta.url),
    "utf8",
  );
  assert.match(service, /format !== "Post"/);
  assert.match(service, /buildCampaignContractBrief\(semanticBriefInput, deliverables\)/);
  assert.match(service, /brief: draft\.semanticBrief/);
});

test("Farcaster ownership and source-bound resolution IDs match V2 domains", () => {
  assert.equal(
    deriveFarcasterOwnershipRequestId({
      wallet: brand,
      username: "alice-eth",
      fid: 42,
      castHash: `0x${"ab".repeat(20)}`,
      challenge: "APV2-abcdefghijklmnopqrstuvwx",
      issuedAtEpoch: 1_800_000_000,
      expiresAtEpoch: 1_800_001_800,
      profileExpiresAtEpoch: 1_802_592_000,
    }),
    "0x3eb4e7649ebc98b1faa5a251beda5a0807277f3ee53a3bfb008ccc08d2af4e8d",
  );
  const input = {
    assignmentId: `0x${"a1".repeat(32)}`,
    agreementHash: `0x${"b2".repeat(32)}`,
    submissionHash: `0x${"c3".repeat(32)}`,
    postId: `0x${"d4".repeat(20)}`,
    roundIndex: 0,
  };
  assert.equal(
    deriveResolutionRequestId({ ...input, contentSource: "FARCASTER" }),
    "0xa8a5da4b884fa5a0354a301ab6b4a4675214d7dd8f53dd543772a9a8b1968443",
  );
  assert.notEqual(
    deriveResolutionRequestId({
      ...input,
      contentSource: "X",
      postId: "1800000000000000000",
    }),
    deriveResolutionRequestId({ ...input, contentSource: "FARCASTER" }),
  );
});

test("identity bundle IDs and final result parsing bind both source requests", () => {
  const xRequestId = `0x${"12".repeat(32)}`;
  const farcasterRequestId = `0x${"34".repeat(32)}`;
  const expectedBundleId = `0x${createHash("sha256")
    .update(
      [
        "influencedx-identity-bundle-v1",
        brand,
        xRequestId,
        farcasterRequestId,
      ].join("|"),
    )
    .digest("hex")}`;
  assert.equal(
    deriveIdentityBundleRequestId({ wallet: brand, xRequestId, farcasterRequestId }),
    expectedBundleId,
  );
  const raw = {
    request_id: expectedBundleId,
    wallet: brand,
    kind: "IDENTITY_BUNDLE",
    x_request_id: xRequestId,
    farcaster_request_id: farcasterRequestId,
    x_outcome: "VERIFIED",
    farcaster_outcome: "VERIFIED",
    verified_at_epoch: 1_800_000_030,
    outcome: "VERIFIED",
  };
  assert.equal(
    parseIdentityBundleResult(raw, {
      requestId: expectedBundleId,
      wallet: brand,
      xRequestId,
      farcasterRequestId,
    }).outcome,
    "VERIFIED",
  );
  assert.throws(() =>
    parseIdentityBundleResult(
      { ...raw, farcaster_request_id: `0x${"35".repeat(32)}` },
      {
        requestId: expectedBundleId,
        wallet: brand,
        xRequestId,
        farcasterRequestId,
      },
    ),
  );
});

test("rejected bundle child results preserve evidence outcome without activating a source", () => {
  const bundleRequestId = `0x${"71".repeat(32)}`;
  const childRequestId = `0x${"72".repeat(32)}`;
  const expected = {
    requestId: childRequestId,
    wallet: brand,
    source: "X" as const,
    handle: "creator",
    contentId: "1900000000000000000",
    issuedAtEpoch: 1_800_000_000,
    expiresAtEpoch: 1_800_000_900,
    profileExpiresAtEpoch: 1_802_592_000,
  };
  const parsed = parseRejectedBundleOwnershipResult(
    {
      request_id: childRequestId,
      wallet: brand,
      source: "X",
      handle: "creator",
      x_user_id: "123456",
      external_user_id: "123456",
      identity_hash: `0x${"73".repeat(32)}`,
      post_id: expected.contentId,
      issued_at_epoch: expected.issuedAtEpoch,
      expires_at_epoch: expected.expiresAtEpoch,
      profile_expires_at_epoch: expected.profileExpiresAtEpoch,
      verified_at_epoch: expected.issuedAtEpoch + 30,
      outcome: "REJECTED",
      evidence_outcome: "VERIFIED",
      bundle_request_id: bundleRequestId,
      author_match: true,
      post_id_match: true,
      protocol_match: true,
      challenge_match: true,
      wallet_match: true,
      issued_at_match: true,
      expires_at_match: true,
      profile_expires_at_match: true,
      publication_in_window: true,
    },
    { ...expected, bundleRequestId, evidenceOutcome: "VERIFIED" },
  );
  assert.equal(parsed.outcome, "REJECTED");
  assert.equal(parsed.evidenceOutcome, "VERIFIED");
  assert.equal(parsed.bundleRequestId, bundleRequestId);
});

test("ownership result projection distinguishes VERIFIED, REJECTED, and retryable UNDETERMINED", async () => {
  const expected = {
    requestId: `0x${"81".repeat(32)}`,
    wallet: brand,
    source: "X" as const,
    handle: "creator",
    contentId: "1900000000000000000",
    issuedAtEpoch: 1_800_000_000,
    expiresAtEpoch: 1_800_000_900,
    profileExpiresAtEpoch: 1_802_592_000,
  };
  for (const outcome of ["VERIFIED", "REJECTED", "UNDETERMINED"] as const) {
    const verified = outcome === "VERIFIED";
    const parsed = parseOwnershipResult({
      request_id: expected.requestId,
      wallet: expected.wallet,
      source: "X",
      handle: expected.handle,
      x_user_id: verified ? "123456" : "",
      external_user_id: verified ? "123456" : "",
      identity_hash: verified ? `0x${"82".repeat(32)}` : `0x${"00".repeat(32)}`,
      post_id: expected.contentId,
      issued_at_epoch: expected.issuedAtEpoch,
      expires_at_epoch: expected.expiresAtEpoch,
      profile_expires_at_epoch: expected.profileExpiresAtEpoch,
      verified_at_epoch: expected.issuedAtEpoch + 30,
      outcome,
      author_match: verified,
      post_id_match: verified,
      protocol_match: verified,
      challenge_match: verified,
      wallet_match: verified,
      issued_at_match: verified,
      expires_at_match: verified,
      profile_expires_at_match: verified,
      publication_in_window: verified,
    }, expected);
    assert.equal(parsed.outcome, outcome);
    assert.equal(ownershipOutcomeAllowsRetry(outcome), outcome === "UNDETERMINED");
  }
  const activation = await readFile(
    new URL("../lib/marketplace-genlayer-activation.ts", import.meta.url),
    "utf8",
  );
  assert.match(activation, /readMarketplaceState\("get_ownership_result"/);
  assert.match(activation, /ownershipResult\.outcome === "VERIFIED"/);
  assert.match(activation, /genlayerRetryable: retryable/);
});

test("retryable identity activation forces a fresh finalized transaction and assignment retries advance request IDs", async () => {
  const [activation, repository, journal] = await Promise.all([
    readFile(new URL("../lib/marketplace-genlayer-activation.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/marketplace-genlayer-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/marketplace-genlayer-journal.ts", import.meta.url), "utf8"),
  ]);
  assert.match(activation, /reuseFinalized: row\.genlayerOutcome !== "UNDETERMINED"/);
  assert.match(repository, /input\.reuseFinalized[\s\S]*"FINALIZED"/);
  assert.match(journal, /ACTIVATE_IDENTITY_BUNDLE[\s\S]*reconcileGenLayerCreatorActivationJournal/);
  assert.deepEqual(
    nextGenLayerResolutionProgression({
      assignment: {
        status: "UNDETERMINED",
        assignmentId: `0x${"91".repeat(32)}`,
        resolutionRequestId: `0x${"92".repeat(32)}`,
        resolutionEligibleAtEpoch: 1_800_000_120,
      },
      previousRequestId: `0x${"90".repeat(32)}`,
      finalizedAtEpoch: 1_800_000_000,
    }),
    {
      assignmentId: `0x${"91".repeat(32)}`,
      requestId: `0x${"92".repeat(32)}`,
      delaySeconds: 120,
    },
  );
  assert.equal(
    nextGenLayerResolutionProgression({
      assignment: {
        status: "UNDETERMINED",
        assignmentId: `0x${"91".repeat(32)}`,
        resolutionRequestId: `0x${"90".repeat(32)}`,
        resolutionEligibleAtEpoch: 1_800_000_120,
      },
      previousRequestId: `0x${"90".repeat(32)}`,
      finalizedAtEpoch: 1_800_000_000,
    }),
    null,
  );
});

test("automatic V2 deadline predicates preserve the contract boundary exactly", () => {
  assert.equal(
    assignmentExpiryIsDue(
      { status: "SELECTED", acceptanceDeadlineEpoch: 1_800_000_000 },
      { submissionDeadlineEpoch: 1_800_000_100 },
      1_800_000_000,
    ),
    false,
  );
  assert.equal(
    assignmentExpiryIsDue(
      { status: "SELECTED", acceptanceDeadlineEpoch: 1_800_000_000 },
      { submissionDeadlineEpoch: 1_800_000_100 },
      1_800_000_001,
    ),
    true,
  );
  assert.equal(
    assignmentExpiryIsDue(
      { status: "ACCEPTED", acceptanceDeadlineEpoch: 1_799_999_000 },
      { submissionDeadlineEpoch: 1_800_000_100 },
      1_800_000_100,
    ),
    false,
  );
  assert.equal(
    campaignFinalizationIsDue(
      {
        status: "OPEN",
        reservedAtto: "0",
        submissionDeadlineEpoch: 1_800_000_000,
        retentionSeconds: 3_600,
      },
      1_800_090_000,
    ),
    true,
  );
  assert.equal(
    campaignFinalizationIsDue(
      {
        status: "OPEN",
        reservedAtto: "1",
        submissionDeadlineEpoch: 1_800_000_000,
        retentionSeconds: 3_600,
      },
      1_800_090_000,
    ),
    false,
  );
});

test("scheduled repair republishes resolutions and submits only fixed due lifecycle actions", async () => {
  const nowEpoch = 1_800_100_000;
  const queued: unknown[] = [];
  const submitted: unknown[] = [];
  const reconciled: unknown[] = [];
  const assignment = progressionAssignment({
    status: "SELECTED",
    acceptanceDeadlineEpoch: nowEpoch - 1,
  });
  const campaign = progressionCampaign({
    submissionDeadlineEpoch: nowEpoch - 90_000,
    retentionSeconds: 3_600,
  });
  const assignmentProjection = progressionAssignmentProjection();
  const campaignProjection = progressionCampaignProjection({
    submissionDeadlineEpoch: campaign.submissionDeadlineEpoch,
    retentionSeconds: campaign.retentionSeconds,
  });
  const result = await runGenLayerProgressionBatch({
    nowMs: nowEpoch * 1_000,
    limit: 4,
    dependencies: {
      listResolutions: async () => [{
        assignmentId,
        resolutionRequestId: requestId,
      }] as never,
      listExpiries: async () => [{
        assignment: assignmentProjection,
        campaign: campaignProjection,
      }] as never,
      listFinalizations: async () => [campaignProjection] as never,
      enqueueResolution: async (input) => {
        queued.push(input);
        return { messageId: "repair-message" };
      },
      readAssignment: async () => assignment,
      readCampaign: async () => campaign,
      submit: async (input) => {
        submitted.push(input);
        return {
          replayed: false,
          operation: progressionOperation(input.action, "FINALIZED"),
        };
      },
      reconcileExpiry: async (input) => {
        reconciled.push({ action: "expire_assignment", ...input });
        return {} as never;
      },
      reconcileFinalization: async (input) => {
        reconciled.push({ action: "finalize_campaign", ...input });
        return {} as never;
      },
    },
  });
  assert.deepEqual(queued, [{ assignmentId, requestId, delaySeconds: 0 }]);
  assert.deepEqual(submitted.toSorted((left, right) =>
    String((left as { action: string }).action).localeCompare(
      String((right as { action: string }).action),
    )), [
    { schemaVersion: 1, action: "expire_assignment", assignmentId },
    { schemaVersion: 1, action: "finalize_campaign", campaignId },
  ]);
  assert.ok(submitted.every((value) => !Object.hasOwn(value as object, "value")));
  assert.equal(result.queued, 1);
  assert.equal(result.finalized, 2);
  assert.equal(result.failed, 0);
  assert.equal(reconciled.length, 2);
});

test("operator PRECHECK_FAILED remains retryable with the exact request binding", async () => {
  await assert.rejects(
    reconcileQueuedGenLayerProgression({
      assignmentId,
      requestId,
      dependencies: {
        findAssignment: async () => progressionAssignmentProjection({
          resolutionRequestId: requestId,
        }) as never,
        readAssignment: async () => progressionAssignment({
          status: "SUBMITTED",
          resolutionRequestId: requestId,
        }),
        submit: async () => ({
          replayed: true,
          operation: progressionOperation("resolve_assignment", "PRECHECK_FAILED"),
        }),
        reconcileResolution: async () => {
          assert.fail("PRECHECK_FAILED must not be reconciled or acknowledged.");
        },
      },
    }),
    GenLayerProgressionRetryError,
  );
});

test("direct-write journal repair is fenced, bounded, and finalizes before acknowledgement", async () => {
  const row = journalClaim();
  const claimInputs: unknown[] = [];
  const dispatched: string[] = [];
  let claimed = false;
  const result = await runGenLayerJournalReconciliationBatch({
    nowMs: 1_800_000_000_000,
    limit: 2,
    dependencies: {
      claim: async (input) => {
        claimInputs.push(input);
        if (claimed) return null;
        claimed = true;
        return row;
      },
      dispatch: async (claim) => {
        dispatched.push(claim.preparedId);
      },
      find: async () => ({
        ...row,
        status: "FINALIZED",
        fenceToken: null,
        fenceExpiresAt: null,
        finalizedAt: 1_800_000_000_000,
      }),
    },
  });
  assert.deepEqual(result, {
    claimed: 1,
    finalized: 1,
    retryScheduled: 0,
    terminal: 0,
    manual: 0,
    capped: false,
  });
  assert.deepEqual(dispatched, [row.preparedId]);
  assert.deepEqual(claimInputs[0], {
    nowMs: 1_800_000_000_000,
    leaseMs: 4 * 60_000,
    maxAttempts: MAX_GENLAYER_RECONCILIATION_ATTEMPTS,
  });
});

test("journal retry writes retain the exact claim fence", async () => {
  const row = journalClaim();
  const recorded: unknown[] = [];
  let claimed = false;
  const result = await runGenLayerJournalReconciliationBatch({
    nowMs: 1_800_000_000_000,
    limit: 1,
    dependencies: {
      claim: async () => {
        if (claimed) return null;
        claimed = true;
        return row;
      },
      dispatch: async () => {
        throw new MarketplaceGenLayerFinalityError(
          "GENLAYER_FINALITY_PENDING",
          "pending",
          true,
        );
      },
      find: async () => row,
      record: async (input) => {
        recorded.push(input);
        return {
          ...row,
          status: "ACCEPTED",
          fenceToken: null,
          fenceExpiresAt: null,
        };
      },
    },
  });
  assert.equal(result.retryScheduled, 1);
  assert.equal(result.manual, 0);
  assert.deepEqual(recorded, [{
    preparedId: row.preparedId,
    status: "ACCEPTED",
    lifecycleStatus: null,
    executionResult: null,
    errorCode: "GENLAYER_FINALITY_PENDING",
    retryAtMs: 1_800_000_060_000,
    nowMs: 1_800_000_000_000,
    fenceToken: row.fenceToken,
  }]);
});

test("finalized execution failures leave reconciliation and permit a new intent attempt", async () => {
  const row = journalClaim();
  const terminalTransaction: FinalizedMarketplaceTransaction = {
    hash: txHash,
    sender: row.actorWallet,
    recipient: row.contractAddress,
    functionName: row.functionName,
    args: row.args,
    lifecycleStatus: "FINALIZED",
    executionResult: "ERROR",
    consensusResult: "MAJORITY_AGREE",
    valueAtto: row.valueAtto,
    finalizedAt: 1_800_000_001,
  };
  const recorded: unknown[] = [];
  let claimed = false;
  const result = await runGenLayerJournalReconciliationBatch({
    nowMs: 1_800_000_000_000,
    limit: 1,
    dependencies: {
      claim: async () => {
        if (claimed) return null;
        claimed = true;
        return row;
      },
      dispatch: async () => {
        throw new MarketplaceGenLayerFinalityError(
          "GENLAYER_EXECUTION_FAILED",
          "rolled back",
          false,
          terminalTransaction,
        );
      },
      find: async () => row,
      record: async (input) => {
        recorded.push(input);
        return {
          ...row,
          status: "EXECUTION_FAILED",
          fenceToken: null,
          fenceExpiresAt: null,
        };
      },
    },
  });
  assert.equal(result.terminal, 1);
  assert.equal(result.retryScheduled, 0);
  assert.equal(result.manual, 0);
  assert.deepEqual(recorded, [{
    preparedId: row.preparedId,
    status: "EXECUTION_FAILED",
    lifecycleStatus: "FINALIZED",
    executionResult: "ERROR",
    errorCode: "GENLAYER_EXECUTION_FAILED",
    retryAtMs: 0,
    nowMs: 1_800_000_000_000,
    fenceToken: row.fenceToken,
  }]);
});

test("maintenance heartbeat binds the DB-authorized deployment generation without operation authority", async () => {
  const calls: unknown[][] = [];
  const generation = maintenanceGeneration();
  const result = await enqueueMarketplaceMaintenanceHeartbeat(
    { nowMs: 1_800_000_000_000, delaySeconds: MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS },
    {
      readGeneration: async () => generation,
      send: (async (...args: unknown[]) => {
        calls.push(args);
        return { messageId: "msg_maintenance_1" };
      }) as never,
    },
  );
  const expectedSlot = Math.floor(
    (1_800_000_000_000 + MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS * 1_000) /
      (MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS * 1_000),
  );
  assert.deepEqual(result, {
    messageId: "msg_maintenance_1",
    deploymentId: maintenanceDeploymentId,
    generation: 7,
    slot: expectedSlot,
  });
  assert.deepEqual(calls[0], [
    MARKETPLACE_MAINTENANCE_QUEUE_TOPIC,
    {
      schemaVersion: 2,
      deploymentId: maintenanceDeploymentId,
      generation: 7,
      slot: expectedSlot,
    },
    {
      idempotencyKey: `influencedx-studionet-maintenance-v2:${maintenanceDeploymentId}:7:${expectedSlot}`,
      retentionSeconds: MARKETPLACE_MAINTENANCE_RETENTION_SECONDS,
      delaySeconds: MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(calls[0]?.[1]), /operation|method|args|value|wallet|transaction/i);
  assert.throws(
    () => validateMarketplaceMaintenanceMessage({
      schemaVersion: 2,
      deploymentId: maintenanceDeploymentId,
      generation: 7,
      slot: expectedSlot,
      functionName: "cancel_campaign",
    }),
    MarketplaceMaintenanceMessageError,
  );
});

test("maintenance deployment identity fails closed when Vercel system scope is absent or ambiguous", () => {
  assert.deepEqual(
    marketplaceMaintenanceDeploymentContext({
      VERCEL: "1",
      VERCEL_DEPLOYMENT_ID: maintenanceDeploymentId,
      VERCEL_PROJECT_ID: maintenanceProjectId,
      VERCEL_ENV: "preview",
      VERCEL_TARGET_ENV: "preview",
    }),
    maintenanceContext,
  );
  for (const environment of [
    {},
    {
      VERCEL: "1",
      VERCEL_DEPLOYMENT_ID: "not-a-deployment",
      VERCEL_PROJECT_ID: maintenanceProjectId,
      VERCEL_ENV: "preview",
      VERCEL_TARGET_ENV: "preview",
    },
    {
      VERCEL: "1",
      VERCEL_DEPLOYMENT_ID: maintenanceDeploymentId,
      VERCEL_PROJECT_ID: maintenanceProjectId,
      VERCEL_ENV: "preview",
      VERCEL_TARGET_ENV: "production",
    },
  ]) {
    assert.throws(
      () => marketplaceMaintenanceDeploymentContext(environment),
      MarketplaceMaintenanceDeploymentConfigurationError,
    );
  }
});

test("maintenance generation activation is explicit, monotonic, and compare-and-swap fenced", async () => {
  let state: MarketplaceMaintenanceGeneration | null = null;
  const store = inMemoryMaintenanceGenerationStore(() => state, (next) => {
    state = next;
  });
  const first = await promoteMarketplaceMaintenanceGeneration(
    { expectedGeneration: 0, nowMs: 1_800_000_000_000 },
    { context: maintenanceContext, store },
  );
  assert.equal(first.promoted, true);
  assert.deepEqual(first.generation, maintenanceGeneration({ generation: 1 }));

  const idempotent = await promoteMarketplaceMaintenanceGeneration(
    { expectedGeneration: 1, nowMs: 1_800_000_001_000 },
    { context: maintenanceContext, store },
  );
  assert.equal(idempotent.promoted, false);
  assert.equal(idempotent.generation.generation, 1);

  const nextContext = {
    ...maintenanceContext,
    deploymentId: nextMaintenanceDeploymentId,
  };
  const next = await promoteMarketplaceMaintenanceGeneration(
    { expectedGeneration: 1, nowMs: 1_800_000_002_000 },
    { context: nextContext, store },
  );
  assert.equal(next.promoted, true);
  assert.equal(next.generation.deploymentId, nextMaintenanceDeploymentId);
  assert.equal(next.generation.generation, 2);

  await assert.rejects(
    promoteMarketplaceMaintenanceGeneration(
      { expectedGeneration: 1, nowMs: 1_800_000_003_000 },
      { context: maintenanceContext, store },
    ),
    MarketplaceMaintenanceGenerationConflictError,
  );
});

test("stale maintenance generations acknowledge without work or re-enqueue", async () => {
  let maintenanceCalls = 0;
  let enqueueCalls = 0;
  const result = await processMarketplaceMaintenanceHeartbeat(
    maintenanceMessage(),
    {
      isActive: async () => false,
      runMaintenance: async () => {
        maintenanceCalls += 1;
        return {} as never;
      },
      enqueue: async () => {
        enqueueCalls += 1;
        return {} as never;
      },
    },
  );
  assert.deepEqual(result, { kind: "STALE" });
  assert.equal(maintenanceCalls, 0);
  assert.equal(enqueueCalls, 0);
});

test("active maintenance rechecks its generation before extending the heartbeat", async () => {
  const checks = [true, false];
  let maintenanceCalls = 0;
  let enqueueCalls = 0;
  const superseded = await processMarketplaceMaintenanceHeartbeat(
    maintenanceMessage(),
    {
      isActive: async () => checks.shift() ?? false,
      runMaintenance: async () => {
        maintenanceCalls += 1;
        return {} as never;
      },
      enqueue: async () => {
        enqueueCalls += 1;
        return {} as never;
      },
    },
  );
  assert.deepEqual(superseded, { kind: "SUPERSEDED" });
  assert.equal(maintenanceCalls, 1);
  assert.equal(enqueueCalls, 0);

  const processed = await processMarketplaceMaintenanceHeartbeat(
    maintenanceMessage(),
    {
      isActive: async () => true,
      runMaintenance: async () => ({} as never),
      enqueue: async (input) => {
        assert.deepEqual(input, {
          delaySeconds: MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS,
        });
        enqueueCalls += 1;
        return {} as never;
      },
    },
  );
  assert.deepEqual(processed, { kind: "PROCESSED" });
  assert.equal(enqueueCalls, 1);
});

test("journal terminal and projection ordering guards are enforced in SQL", async () => {
  const repository = await readFile(
    new URL("../lib/marketplace-genlayer-repository.ts", import.meta.url),
    "utf8",
  );
  assert.match(repository, /status\} <> 'FINALIZED'/);
  assert.match(repository, /for update skip locked/);
  assert.match(repository, /reconciliation_attempts < \$\{maxAttempts\}/);
  assert.match(repository, /Campaigns\.finalizedAt\} < \$\{input\.finalizedAt\}/);
  assert.match(repository, /Assignments\.finalizedAt\} < \$\{input\.finalizedAt\}/);
  assert.match(repository, /ProjectionCursors\.lastFinalizedAt\} < \$\{input\.finalizedAt\}/);
});

test("projection identities cannot collide across contract or network cutovers", () => {
  const entityId = deriveCampaignTermsHash(frozenTerms);
  const first = deriveProjectionId({
    network: "studionet",
    chainId: 61_999,
    contractAddress: contract,
    entityId,
  });
  assert.equal(first, "0x0eec5d2d36a31980faebac1ea0ede25b8095871f25efde072b24a7cadba771d5");
  assert.notEqual(
    first,
    deriveProjectionId({
      network: "studionet",
      chainId: 61_999,
      contractAddress: "0x5555555555555555555555555555555555555555",
      entityId,
    }),
  );
  assert.notEqual(
    first,
    deriveProjectionId({
      network: "mainnet",
      chainId: 1,
      contractAddress: contract,
      entityId,
    }),
  );
});

test("campaign projection accepts only exact contract states and conserved native GEN", () => {
  const termsHash = deriveCampaignTermsHash(frozenTerms);
  const state = parseCampaignState({
    campaign_id: campaignId,
    brand,
    client_nonce: "client-0001",
    content_source: frozenTerms.contentSource,
    title: frozenTerms.title,
    brief: frozenTerms.brief,
    required_phrases: frozenTerms.requiredPhrases,
    forbidden_phrases: frozenTerms.forbiddenPhrases,
    require_ad_disclosure: true,
    terms_hash: termsHash,
    status: "OPEN",
    application_deadline_epoch: frozenTerms.applicationDeadlineEpoch,
    selection_deadline_epoch: frozenTerms.selectionDeadlineEpoch,
    submission_deadline_epoch: frozenTerms.submissionDeadlineEpoch,
    retention_seconds: frozenTerms.retentionSeconds,
    max_undetermined_retries: frozenTerms.maxUndeterminedRetries,
    fee_bps: 250,
    treasury: contract,
    budget_atto: "1000",
    available_atto: "500",
    reserved_atto: "200",
    settled_atto: "300",
    creator_paid_atto: "200",
    brand_refunded_atto: "75",
    fee_atto: "25",
    application_count: 3,
    assignment_count: 1,
    created_at_epoch: 1_800_000_000,
    closed_at_epoch: 0,
  });
  assert.equal(state.availableAtto, "500");
  assert.throws(
    () => assertCampaignStateAccounting({ ...state, feeAtto: "24" }),
    /conservation/,
  );
  assert.throws(
    () => parseCampaignState({ ...toContractCampaign(state), status: "ACTIVE" }),
    /status/,
  );
});

test("StudioNet confirmation requires majority agreement and one successful leader return", () => {
  const valid = {
    result_name: "MAJORITY_AGREE",
    consensus_data: {
      leader_receipt: [
        { mode: "leader", execution_result: "SUCCESS", result: { status: "return" } },
        { mode: "validator", execution_result: "SUCCESS", result: { status: "return" } },
      ],
    },
  };
  assert.deepEqual(finalizedExecution(valid), {
    success: true,
    executionResult: "SUCCESS",
    consensusResult: "MAJORITY_AGREE",
  });
  assert.equal(finalizedExecution({ ...valid, result_name: "MAJORITY_DISAGREE" }).success, false);
  assert.equal(finalizedExecution({ result_name: "MAJORITY_AGREE", consensus_data: {} }).success, false);
  assert.equal(
    finalizedExecution({
      ...valid,
      consensus_data: {
        leader_receipt: [
          { mode: "leader", execution_result: "SUCCESS", result: { status: "return" } },
          { mode: "leader", execution_result: "SUCCESS", result: { status: "return" } },
        ],
      },
    }).success,
    false,
  );
  assert.equal(
    finalizedExecution({
      ...valid,
      consensus_data: {
        leader_receipt: [{ mode: "leader", execution_result: "ERROR", result: { status: "return" } }],
      },
    }).success,
    false,
  );
});

test("unused GEN refund eligibility opens exactly at the authoritative selection deadline", () => {
  const campaign = {
    availableAtto: "3000000000000000000",
    selectionDeadlineEpoch: 1_800_000_600,
  };
  assert.deepEqual(
    genLayerUnallocatedRefundAvailability(campaign, 1_800_000_599),
    {
      canRefund: false,
      reason: "EARLY",
      unlocksAt: "2027-01-15T08:10:00.000Z",
    },
  );
  assert.equal(
    genLayerUnallocatedRefundAvailability(campaign, 1_800_000_600).canRefund,
    true,
  );
  assert.deepEqual(
    genLayerUnallocatedRefundAvailability({ ...campaign, availableAtto: "0" }, 1_800_000_600),
    {
      canRefund: false,
      reason: "EMPTY",
      unlocksAt: "2027-01-15T08:10:00.000Z",
    },
  );
});

test("campaign cancellation mirrors the contract guard order and allows a zero available balance", () => {
  const cancellable = {
    status: "OPEN" as const,
    applicationDeadlineEpoch: 1_800_000_600,
    reservedAtto: "0",
    availableAtto: "0",
  };
  assert.deepEqual(
    genLayerCampaignCancellationAvailability(cancellable, 1_800_000_599),
    { canCancel: true, reason: null },
  );
  assert.deepEqual(
    genLayerCampaignCancellationAvailability(
      { ...cancellable, reservedAtto: "1" },
      1_800_000_600,
    ),
    { canCancel: false, reason: "LATE" },
    "deadline equality must win over the reserved-balance guard",
  );
  assert.deepEqual(
    genLayerCampaignCancellationAvailability(
      { ...cancellable, reservedAtto: "1" },
      1_800_000_599,
    ),
    { canCancel: false, reason: "RESERVED" },
  );
  assert.deepEqual(
    genLayerCampaignCancellationAvailability(
      { ...cancellable, status: "CANCELLED" },
      1_800_000_599,
    ),
    { canCancel: false, reason: "STATE" },
  );
});

test("resolution eligibility opens at the authoritative assignment timestamp and stops at the retry ceiling", () => {
  const assignment = {
    status: "SUBMITTED" as const,
    resolutionEligibleAtEpoch: 1_800_000_600,
    resolutionAttempts: 0,
  };
  const campaign = { maxUndeterminedRetries: 2 };
  assert.deepEqual(
    genLayerResolutionAvailability(assignment, campaign, 1_800_000_599),
    {
      canResolve: false,
      reason: "EARLY",
      unlocksAt: "2027-01-15T08:10:00.000Z",
    },
  );
  assert.equal(
    genLayerResolutionAvailability(assignment, campaign, 1_800_000_600).canResolve,
    true,
  );
  assert.equal(
    genLayerResolutionAvailability({
      ...assignment,
      status: "UNDETERMINED",
      resolutionAttempts: 2,
    }, campaign, 1_800_000_600).reason,
    "RETRIES_EXHAUSTED",
  );
});

test("only known finalized terminal outcomes leave the reconciliation fence", () => {
  assert.equal(
    terminalMarketplaceTransactionStatus(new MarketplaceGenLayerFinalityError(
      "GENLAYER_EXECUTION_FAILED",
      "rolled back",
      false,
    )),
    "EXECUTION_FAILED",
  );
  assert.equal(
    terminalMarketplaceTransactionStatus(new MarketplaceGenLayerFinalityError(
      "GENLAYER_TRANSACTION_TERMINATED",
      "terminated",
      false,
    )),
    "NETWORK_TERMINATED",
  );
  assert.equal(
    terminalMarketplaceTransactionStatus(new MarketplaceGenLayerFinalityError(
      "GENLAYER_FINALITY_PENDING",
      "pending",
      true,
    )),
    null,
  );
  assert.equal(terminalMarketplaceTransactionStatus(new Error("mismatch")), null);
});

test("live-shaped StudioNet snake tx_data uses the immutable execution timestamp", async () => {
  const encoded = abi.transactions.serialize([
    abi.calldata.encode(
      abi.calldata.makeCalldataObject(
        "create_campaign",
        [campaignId, 10n],
        undefined,
      ),
    ),
    false,
  ]);
  const transaction = await loadFinalizedMarketplaceTransaction(
    txHash,
    ({
      getTransaction: async () =>
        ({
          status: 7,
          status_name: "FINALIZED",
          result: 6,
          result_name: "MAJORITY_AGREE",
          from_address: brand,
          to_address: contract,
          tx_data: encoded.slice(2),
          created_timestamp: "1800000001",
          last_vote_timestamp: "1800000009",
          current_timestamp: "1800000656",
          data: {
            calldata: {
              // Studio's readable form is diagnostic text, not JSON.
              readable: '{"args":[addr#...,250,]}',
            },
          },
          consensus_data: {
            leader_receipt: [
              {
                mode: "leader",
                execution_result: "SUCCESS",
                result: { status: "return" },
              },
              {
                mode: "validator",
                execution_result: "SUCCESS",
                result: { status: "return" },
              },
            ],
          },
        }) as never,
      readContract: async () => null,
    } as never),
    async () => "10",
  );
  assert.equal(transaction.functionName, "create_campaign");
  assert.deepEqual(transaction.args, [campaignId, 10n]);
  assert.equal(transaction.finalizedAt, 1_800_000_001);
  assert.doesNotThrow(() => assertFinalizedOwnershipTiming({
    verifiedAtEpoch: 1_800_000_001,
    finalizedAtEpoch: transaction.finalizedAt,
    preparedAtMs: 1_799_999_900_000,
    readyForGenLayerAtMs: 1_799_999_950_000,
    issuedAtMs: 1_799_999_800_000,
    expiresAtMs: 1_800_000_100_000,
    profileExpiresAtMs: 1_802_592_000_000,
  }));
});

test("transaction confirmation fails closed on every prepared-call boundary", () => {
  const call: MarketplaceGenLayerCall = {
    network: "studionet",
    chainId: 61_999,
    contractAddress: contract,
    functionName: "create_campaign",
    args: [campaignId, 10n],
    argTypes: ["string", "uint256"],
    value: "10",
  };
  const transaction: FinalizedMarketplaceTransaction = {
    hash: txHash,
    sender: brand,
    recipient: contract,
    functionName: "create_campaign",
    args: [campaignId, 10n],
    lifecycleStatus: "FINALIZED",
    executionResult: "SUCCESS",
    consensusResult: "MAJORITY_AGREE",
    valueAtto: "10",
    finalizedAt: 1_800_000_001,
  };
  assert.doesNotThrow(() => assertTransactionMatchesPreparedCall({ transaction, call, actorWallet: brand }));
  const reject = (change: Partial<FinalizedMarketplaceTransaction>, pattern: RegExp) => {
    assert.throws(
      () => assertTransactionMatchesPreparedCall({ transaction: { ...transaction, ...change }, call, actorWallet: brand }),
      pattern,
    );
  };
  reject({ sender: "0x6666666666666666666666666666666666666666" }, /another wallet/);
  reject({ recipient: "0x6666666666666666666666666666666666666666" }, /another contract/);
  reject({ functionName: "cancel_campaign" }, /another method/);
  reject({ args: [campaignId, 11n] }, /arguments/);
  reject({ valueAtto: "11" }, /value/);
  reject({ functionName: null, args: null }, /could not be decoded/);
});

test("JSON transaction transport restores uint256 and address calldata types", () => {
  class Address {
    readonly value: Uint8Array;
    constructor(value: Uint8Array) {
      this.value = value;
    }
  }
  const hydrated = hydrateArgs(
    ["7", brand, true, "hello"],
    ["uint256", "address", "bool", "string"],
    Address,
  );
  assert.equal(hydrated[0], 7n);
  assert.ok(hydrated[1] instanceof Address);
  assert.equal((hydrated[1] as Address).value.length, 20);
  assert.throws(() => hydrateArgs(["-1"], ["uint256"], Address), /uint256/);
});

test("0009 is additive, Base-independent for creators, and deployment scoped", async () => {
  const migration = await readFile(
    new URL("../drizzle-postgres/0009_genlayer_native_marketplace.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /"projection_id" text PRIMARY KEY/);
  assert.match(migration, /"network", "chain_id", "contract_address", "identity_hash"/);
  assert.match(migration, /"network", "chain_id", "contract_address", "campaign_id"/);
  assert.match(migration, /"content_source" text NOT NULL/);
  assert.match(migration, /"source" text NOT NULL/);
  assert.match(migration, /"external_user_id" text NOT NULL/);
  assert.match(migration, /CHECK \("content_source" IN \('X', 'FARCASTER'\)\)/);
  assert.match(migration, /"campaign_projection_id" text NOT NULL/);
  assert.match(
    migration,
    /marketplace_genlayer_assignments_entity_contract_idx[\s\S]*"network", "chain_id", "contract_address", "assignment_id"/,
  );
  assert.match(
    migration,
    /FOREIGN KEY \("campaign_projection_id"\)[\s\S]*marketplace_genlayer_campaigns[\s\S]*\("projection_id"\)/,
  );
  assert.match(migration, /"creator_profile_projection_id".*REFERENCES "marketplace_genlayer_profiles"\("projection_id"\)/s);
  assert.match(migration, /"arg_types" jsonb NOT NULL/);
  assert.doesNotMatch(migration, /REFERENCES "marketplace_creator_profiles"|base_profile_id/i);
  assert.doesNotMatch(migration, /ALTER TABLE "marketplace_campaigns"|UPDATE "marketplace_campaigns"/i);
});

test("0010 adds an empty, environment-scoped maintenance generation fence", async () => {
  const [migration, seedRoute] = await Promise.all([
    readFile(
      new URL(
        "../drizzle-postgres/0010_maintenance_generation_fence.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/api/internal/campaign-progression/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  assert.match(
    migration,
    /CREATE TABLE "marketplace_genlayer_maintenance_generations"/,
  );
  assert.match(
    migration,
    /PRIMARY KEY \([\s\S]*"network"[\s\S]*"chain_id"[\s\S]*"contract_address"[\s\S]*"vercel_project_id"[\s\S]*"vercel_environment"/,
  );
  assert.match(migration, /"generation" bigint NOT NULL/);
  assert.match(migration, /"active_deployment_id" text NOT NULL/);
  assert.match(migration, /"vercel_environment" IN \('preview', 'production'\)/);
  assert.match(migration, /"generation" > 0/);
  assert.doesNotMatch(migration, /\b(?:INSERT|UPDATE|DELETE)\b/i);
  assert.match(seedRoute, /export async function POST/);
  assert.match(seedRoute, /x-influencedx-maintenance-generation/);
  assert.match(seedRoute, /promoteMarketplaceMaintenanceGeneration/);
  assert.doesNotMatch(seedRoute, /runGenLayerMaintenanceBatch/);
});

test("0011 releases legacy identity locks and journals atomic bundle child IDs", async () => {
  const migration = await readFile(
    new URL(
      "../drizzle-postgres/0011_identity_bundle_activation.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /"x_ownership_request_id" text/);
  assert.match(migration, /"farcaster_ownership_request_id" text/);
  assert.match(migration, /verification_requests_identity_bundle_pair/);
  assert.match(migration, /ACTIVATE_IDENTITY_BUNDLE/);
  assert.match(
    migration,
    /UPDATE "verification_requests"[\s\S]*"status" = 'EXPIRED'[\s\S]*"active_owner_user_id" = NULL[\s\S]*"active_wallet" = NULL/,
  );
  for (const ephemeral of [
    "wallet_nonce",
    "wallet_message",
    "x_challenge",
    "tweet_text",
    "farcaster_challenge",
    "farcaster_cast_text",
  ]) {
    assert.match(migration, new RegExp(`"${ephemeral}" = NULL`));
  }
  assert.match(
    migration,
    /WHERE "x_ownership_request_id" IS NULL[\s\S]*"farcaster_ownership_request_id" IS NULL[\s\S]*"status" <> 'EXPIRED'/,
  );
  assert.match(
    migration,
    /UPDATE "marketplace_genlayer_transactions"[\s\S]*"status" = 'NETWORK_TERMINATED'[\s\S]*'IDENTITY_BUNDLE_CUTOVER'[\s\S]*"operation" = 'ACTIVATE_CREATOR'/,
  );
  assert.match(migration, /marketplace_genlayer_transactions_operation[\s\S]*NOT VALID/);
  assert.match(
    migration,
    /VALIDATE CONSTRAINT "marketplace_genlayer_transactions_operation"/,
  );
  assert.doesNotMatch(
    migration,
    /ADD CONSTRAINT "marketplace_genlayer_transactions_operation"[\s\S]*IN \([\s\S]*'ACTIVATE_CREATOR'/,
  );
  assert.doesNotMatch(migration, /\bDELETE\b/i);
  assert.doesNotMatch(
    migration,
    /"(?:activation_prepared_id|activation_tx_hash|finalized_request_id)" = NULL/,
  );
});

test("0012 expires active old-contract attempts and terminalizes only unfinished journals", async () => {
  const migration = await readFile(
    new URL(
      "../drizzle-postgres/0012_marketplace_contract_cutover.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const retiredAddress = "0xeaceba807a7a4dc370f3b5a8e45539596b8551b4";
  assert.match(
    migration,
    /UPDATE "verification_requests" AS request[\s\S]*"status" = 'EXPIRED'[\s\S]*"active_owner_user_id" = NULL[\s\S]*"active_wallet" = NULL/,
  );
  assert.match(
    migration,
    /request\."active_owner_user_id" IS NOT NULL[\s\S]*journal\."prepared_id" = request\."activation_prepared_id"/,
  );
  assert.match(migration, new RegExp(`journal\\."contract_address" = '${retiredAddress}'`));
  assert.match(
    migration,
    /UPDATE "marketplace_genlayer_transactions" AS journal[\s\S]*"status" = 'NETWORK_TERMINATED'[\s\S]*COALESCE\(journal\."error_code", 'MARKETPLACE_CONTRACT_CUTOVER'\)/,
  );
  assert.match(
    migration,
    /journal\."status" IN \(\s*'PREPARED', 'SUBMITTED', 'ACCEPTED', 'RECONCILIATION_REQUIRED'\s*\)/,
  );
  assert.doesNotMatch(
    migration,
    /"(?:activation_prepared_id|activation_tx_hash|finalized_request_id|transaction_hash|onchain_entity_id|args)" = NULL/,
  );
  assert.match(
    migration,
    /DELETE FROM "marketplace_genlayer_maintenance_generations"[\s\S]*"network" = 'studionet'[\s\S]*"chain_id" = 61999[\s\S]*"contract_address" IN \([\s\S]*'0xeaceba807a7a4dc370f3b5a8e45539596b8551b4'[\s\S]*'0x58d598b8323e9c1d041989dcce80e737109de347'[\s\S]*\)/,
  );
  assert.doesNotMatch(
    migration,
    /(?:INSERT INTO|UPDATE) "marketplace_genlayer_maintenance_generations"/,
  );
  assert.doesNotMatch(migration, /0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb/i);
});

test("identity verification API exposes one bundled challenge and one bundled activation", async () => {
  const [challengeRoute, activationRoute, submittedRoute, xRoute, farcasterRoute] = await Promise.all([
    readFile(
      new URL("../app/api/verification/identity-challenge/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/api/verification/activation/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/api/verification/activation/submitted/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../app/api/verification/x-challenge/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/api/verification/farcaster-challenge/route.ts", import.meta.url),
      "utf8",
    ),
  ]);
  for (const field of ["requestId", "handle", "farcasterUsername"]) {
    assert.match(challengeRoute, new RegExp(`"${field}"`));
  }
  assert.doesNotMatch(challengeRoute, /"farcasterFid"|body\.farcasterFid/);
  assert.match(challengeRoute, /issueIdentityBundleChallenge/);
  assert.match(activationRoute, /prepareGenLayerIdentityBundleActivation/);
  assert.match(
    activationRoute,
    /\[\s*"requestId",\s*"verificationPostUrl",\s*"farcasterCastUrl",?\s*\]/,
  );
  assert.doesNotMatch(activationRoute, /body\.castHash/);
  assert.doesNotMatch(activationRoute, /body\.source/);
  assert.match(submittedRoute, /\["preparedId", "txHash"\]/);
  assert.match(submittedRoute, /bindGenLayerIdentityBundleActivationSubmission/);
  assert.match(xRoute, /IDENTITY_BUNDLE_REQUIRED/);
  assert.match(farcasterRoute, /IDENTITY_BUNDLE_REQUIRED/);
  assert.match(xRoute, /status: 410/);
  assert.match(farcasterRoute, /status: 410/);
});

test("post-submit recovery binds the exact bundle hash before hosted reconciliation", async () => {
  const [activation, repository] = await Promise.all([
    readFile(
      new URL("../lib/marketplace-genlayer-activation.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../lib/marketplace-genlayer-repository.ts", import.meta.url),
      "utf8",
    ),
  ]);
  const start = activation.indexOf(
    "export async function bindGenLayerIdentityBundleActivationSubmission",
  );
  const end = activation.indexOf("async function confirmLegacy", start);
  assert.ok(start >= 0 && end > start);
  const binding = activation.slice(start, end);
  assert.match(binding, /storedIdentityBundleEnvelope\(row, prepared\)/);
  assert.match(binding, /assertPreparedActivation/);
  assert.match(binding, /bindGenLayerTransactionHash\(\{/);
  assert.match(binding, /bound\.transactionHash !== transactionHash/);
  const bindStart = repository.indexOf(
    "export async function bindGenLayerTransactionHash",
  );
  const bindEnd = repository.indexOf(
    "export async function recordGenLayerTransactionStatus",
    bindStart,
  );
  const journalBind = repository.slice(bindStart, bindEnd);
  assert.match(journalBind, /status: "SUBMITTED"/);
  assert.match(journalBind, /nextReconcileAt: nowMs \+ 60_000/);
  assert.match(journalBind, /seedGenLayerJournalMaintenance\(nowMs\)/);
  const recoveryStart = activation.indexOf("async function activationRecoveryForRequest");
  const recoveryEnd = activation.indexOf("function storedXPost", recoveryStart);
  assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
  const recovery = activation.slice(recoveryStart, recoveryEnd);
  assert.match(recovery, /prepared\.operation !== "ACTIVATE_IDENTITY_BUNDLE"/);
  assert.match(recovery, /prepared\.actorWallet !== request\.wallet/);
  assert.match(recovery, /prepared\.onchainEntityId !== request\.finalizedRequestId/);
  assert.match(recovery, /prepared\.contractAddress !== marketplaceContractAddress\(\)\.toLowerCase\(\)/);
  assert.match(recovery, /requestId: request\.id/);
  assert.match(recovery, /preparedId: prepared\.preparedId/);
  assert.match(recovery, /txHash: prepared\.transactionHash/);
  assert.doesNotMatch(recovery, /prepared\.args|Challenge|challenge/);
});

test("user marketplace hashes bind immediately and applicant settlement does not require assignment", async () => {
  const [actions, route, repository, service] = await Promise.all([
    readFile(new URL("../lib/marketplace-genlayer-actions.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/api/marketplace/transactions/[preparedId]/submitted/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../lib/marketplace-genlayer-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/marketplace-genlayer-service.ts", import.meta.url), "utf8"),
  ]);
  const bindStart = actions.indexOf(
    "export async function bindSubmittedGenLayerMarketplaceTransaction",
  );
  const bindEnd = actions.indexOf("export async function prepareGenLayerApplication", bindStart);
  assert.ok(bindStart >= 0 && bindEnd > bindStart);
  const binding = actions.slice(bindStart, bindEnd);
  assert.match(binding, /prepared\.actorWallet !== input\.session\.wallet\.toLowerCase\(\)/);
  assert.match(binding, /USER_SUBMITTED_MARKETPLACE_OPERATIONS\.has\(prepared\.operation\)/);
  assert.match(binding, /bindGenLayerTransactionHash\(\{/);
  assert.match(route, /requireMarketplaceSession\(request\)/);
  assert.match(route, /"marketplace-transaction-submit"/);
  assert.match(route, /bindSubmittedGenLayerMarketplaceTransaction/);

  const settlementStart = actions.indexOf("export async function getGenLayerSettlement");
  const settlementEnd = actions.indexOf("export async function prepareGenLayerWithdrawal", settlementStart);
  const settlement = actions.slice(settlementStart, settlementEnd);
  assert.match(settlement, /findGenLayerPrivateApplicationForCreator/);
  assert.match(settlement, /application\?\.creatorWallet === wallet/);
  assert.doesNotMatch(settlement, /findGenLayerAssignmentProjectionByApplicationId/);

  const recoveryStart = repository.indexOf(
    "export async function findBoundGenLayerApplicationRecovery",
  );
  const recoveryEnd = repository.indexOf("/**", recoveryStart);
  assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
  const recovery = repository.slice(recoveryStart, recoveryEnd);
  assert.match(recovery, /operation, "APPLY"/);
  assert.match(recovery, /functionName, "apply_to_campaign"/);
  assert.match(recovery, /localApplicationId/);
  assert.match(recovery, /normalizeAddress\(input\.actorWallet\)/);
  assert.match(recovery, /isNotNull\(marketplaceGenLayerTransactions\.transactionHash\)/);
  assert.match(recovery, /"SUBMITTED"[\s\S]*"ACCEPTED"[\s\S]*"FINALIZED"[\s\S]*"RECONCILIATION_REQUIRED"/);
  assert.doesNotMatch(recovery, /EXECUTION_FAILED|NETWORK_TERMINATED/);

  const detailStart = service.indexOf(
    "export async function getGenLayerMarketplaceCampaignDetail",
  );
  const detailEnd = service.indexOf("function campaignCreationCall", detailStart);
  assert.ok(detailStart >= 0 && detailEnd > detailStart);
  const detail = service.slice(detailStart, detailEnd);
  assert.match(detail, /viewerPrivateApplication\?\.status === "PENDING_ONCHAIN" && viewer/);
  assert.match(detail, /findBoundGenLayerApplicationRecovery\(\{/);
  assert.match(detail, /localApplicationId: viewerPrivateApplication\.id/);
  assert.match(detail, /actorWallet: viewer/);
  assert.match(detail, /viewerRecovery: boundRecovery/);
});

test("unused GEN refund preparation and settlement use authoritative deadline state", async () => {
  const actions = await readFile(
    new URL("../lib/marketplace-genlayer-actions.ts", import.meta.url),
    "utf8",
  );
  const prepareStart = actions.indexOf("export async function prepareGenLayerRefundUnallocated");
  const prepareEnd = actions.indexOf("export async function confirmGenLayerRefundUnallocated", prepareStart);
  const prepare = actions.slice(prepareStart, prepareEnd);
  assert.match(prepare, /readMarketplaceState\("get_campaign"/);
  assert.match(prepare, /assertOperatorCampaignBinding\(context\.projection, state\)/);
  assert.match(prepare, /genLayerUnallocatedRefundAvailability\(state\)/);
  assert.match(prepare, /"REFUND_EARLY"/);
  assert.match(prepare, /"NO_UNALLOCATED"/);
  assert.ok(
    prepare.indexOf("genLayerUnallocatedRefundAvailability(state)")
      < prepare.indexOf("prepareGenLayerMarketplaceTransaction"),
  );

  const settlementStart = actions.indexOf("export async function getGenLayerSettlement");
  const settlementEnd = actions.indexOf("export async function prepareGenLayerWithdrawal", settlementStart);
  const settlement = actions.slice(settlementStart, settlementEnd);
  assert.match(settlement, /authoritativeCampaign/);
  assert.match(settlement, /unallocatedAtto: role === "brand" \? authoritativeCampaign\.availableAtto/);
  assert.match(settlement, /canRefundUnallocated: role === "brand" && refundAvailability\.canRefund/);
});

test("resolution and cancellation are preflighted from authoritative contract state before journaling", async () => {
  const [actions, service] = await Promise.all([
    readFile(new URL("../lib/marketplace-genlayer-actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/marketplace-genlayer-service.ts", import.meta.url), "utf8"),
  ]);
  const resolutionStart = actions.indexOf("export async function prepareGenLayerResolution");
  const resolutionEnd = actions.indexOf("export async function confirmGenLayerResolution", resolutionStart);
  const resolution = actions.slice(resolutionStart, resolutionEnd);
  assert.match(resolution, /readMarketplaceState\("get_assignment"/);
  assert.match(resolution, /readMarketplaceState\("get_campaign"/);
  assert.match(resolution, /assertOperatorAssignmentBinding\(context\.assignment, assignment, campaign\)/);
  assert.match(resolution, /assertResolutionPreparationBinding\(context\.assignment, assignment\)/);
  assert.match(resolution, /genLayerResolutionAvailability\(assignment, campaign\)/);
  assert.match(resolution, /"RETENTION"/);
  assert.ok(
    resolution.indexOf("genLayerResolutionAvailability(assignment, campaign)")
      < resolution.indexOf('prepareAction("RESOLVE_ASSIGNMENT"'),
  );

  const cancelStart = actions.indexOf("export async function prepareGenLayerCampaignCancel");
  const cancelEnd = actions.indexOf("export async function confirmGenLayerCampaignCancel", cancelStart);
  const cancel = actions.slice(cancelStart, cancelEnd);
  assert.match(cancel, /readMarketplaceState\("get_campaign"/);
  assert.match(cancel, /assertOperatorCampaignBinding\(context\.projection, state\)/);
  assert.match(cancel, /genLayerCampaignCancellationAvailability\(state\)/);
  assert.match(cancel, /"CANCEL_TOO_LATE"/);
  assert.match(cancel, /"CAMPAIGN_RESERVED"/);
  assert.ok(
    cancel.indexOf("genLayerCampaignCancellationAvailability(state)")
      < cancel.indexOf("prepareGenLayerMarketplaceTransaction"),
    "failed cancellation preflights must not create a journal row",
  );

  const detailStart = service.indexOf("export async function getGenLayerMarketplaceCampaignDetail");
  const detailEnd = service.indexOf("function campaignCreationCall", detailStart);
  const detail = service.slice(detailStart, detailEnd);
  assert.match(detail, /authoritativeCampaignCanCancel\(draft, projection\)/);
  assert.match(detail, /readMarketplaceState\("get_campaign"/);
  assert.match(detail, /assertCampaignMatchesDraft\(state, draft, projection\.campaignId\)/);
  assert.match(detail, /catch \{[\s\S]*return false;/);
});

test("campaign refund and cancel confirmation require their exact authoritative postconditions", () => {
  const cleared = { availableAtto: "0", reservedAtto: "0" };
  assert.equal(
    genLayerCampaignActionPostcondition("refund_unallocated", {
      ...cleared,
      status: "OPEN",
      reservedAtto: "5",
    }),
    true,
    "an unused-funds refund may leave active assignments reserved",
  );
  assert.equal(
    genLayerCampaignActionPostcondition("refund_unallocated", {
      ...cleared,
      status: "CLOSED",
    }),
    true,
    "a later finalization may close the campaign before confirmation reads latest state",
  );
  assert.equal(
    genLayerCampaignActionPostcondition("refund_unallocated", {
      ...cleared,
      status: "CANCELLED",
    }),
    false,
  );
  assert.equal(
    genLayerCampaignActionPostcondition("refund_unallocated", {
      ...cleared,
      status: "OPEN",
      availableAtto: "1",
    }),
    false,
  );
  assert.equal(
    genLayerCampaignActionPostcondition("cancel_campaign", {
      ...cleared,
      status: "CANCELLED",
    }),
    true,
  );
  for (const invalid of [
    { ...cleared, status: "OPEN" as const },
    { ...cleared, status: "CLOSED" as const },
    { ...cleared, status: "CANCELLED" as const, availableAtto: "1" },
    { ...cleared, status: "CANCELLED" as const, reservedAtto: "1" },
  ]) {
    assert.equal(genLayerCampaignActionPostcondition("cancel_campaign", invalid), false);
  }
});

test("campaign confirmation projects and syncs only an accepted authoritative terminal state", async () => {
  const actions = await readFile(
    new URL("../lib/marketplace-genlayer-actions.ts", import.meta.url),
    "utf8",
  );
  const start = actions.indexOf("async function confirmCampaignSimple");
  const end = actions.indexOf("async function confirmExact", start);
  const confirm = actions.slice(start, end);
  assert.match(confirm, /readMarketplaceState\("get_campaign"/);
  assert.match(confirm, /genLayerCampaignActionPostcondition\(method, state\)/);
  assert.ok(
    confirm.indexOf("genLayerCampaignActionPostcondition(method, state)")
      < confirm.indexOf("projectCampaign("),
  );
  assert.match(confirm, /state\.status !== "OPEN"[\s\S]*status: state\.status/);
  assert.doesNotMatch(confirm, /status: expectedStatus/);
});

test("apply, select, accept, and submit preflight the exact active X plus Farcaster bundle", async () => {
  const actions = await readFile(
    new URL("../lib/marketplace-genlayer-actions.ts", import.meta.url),
    "utf8",
  );
  assert.match(actions, /IDENTITY_BUNDLE_SOURCES = \["X", "FARCASTER"\]/);
  const helperStart = actions.indexOf("async function requireActiveIdentityBundle");
  const helperEnd = actions.indexOf("function assertAssignmentIdentityBinding", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = actions.slice(helperStart, helperEnd);
  assert.match(helper, /findGenLayerProfileByWallet\(normalizedWallet, source\)/);
  assert.match(helper, /readMarketplaceState\([\s\S]*"get_identity"/);
  assert.match(helper, /authoritativeProfile\.expiresAtEpoch \* 1_000 <= nowMs/);
  assert.match(helper, /authoritativeProfile\.identityHash !== profile\.identityHash/);
  assert.match(helper, /authoritativeProfile\.externalUserId !== profile\.externalUserId/);

  for (const functionName of [
    "prepareGenLayerApplication",
    "prepareGenLayerSelection",
    "prepareGenLayerSubmission",
  ]) {
    const start = actions.indexOf(`export async function ${functionName}`);
    const end = actions.indexOf("export async function", start + 1);
    assert.match(actions.slice(start, end), /requireActiveIdentityBundle\(/, functionName);
  }
  const acceptStart = actions.indexOf("export async function prepareGenLayerAccept");
  const acceptEnd = actions.indexOf("export async function confirmGenLayerAccept", acceptStart);
  assert.match(actions.slice(acceptStart, acceptEnd), /prepareAssignmentSimple\([\s\S]*true/);
});

test("campaign evidence resolution uses the authoritative Farcaster identity only during preparation", async () => {
  const actions = await readFile(
    new URL("../lib/marketplace-genlayer-actions.ts", import.meta.url),
    "utf8",
  );
  const prepareStart = actions.indexOf("export async function prepareGenLayerSubmission");
  const confirmStart = actions.indexOf("export async function confirmGenLayerSubmission", prepareStart);
  const resolutionStart = actions.indexOf("export async function prepareGenLayerResolution", confirmStart);
  const prepare = actions.slice(prepareStart, confirmStart);
  const confirm = actions.slice(confirmStart, resolutionStart);
  assert.match(prepare, /await buildGenLayerSubmissionCall\(\{/);
  assert.match(prepare, /submittedContent: input\.body\.contentId/);
  assert.match(prepare, /expectedUsername: identity\.authoritativeProfile\.handle/);
  assert.match(prepare, /expectedExternalUserId: identity\.authoritativeProfile\.externalUserId/);
  assert.ok(
    prepare.indexOf("await buildGenLayerSubmissionCall")
      < prepare.indexOf('prepareAction("SUBMIT_EVIDENCE"'),
  );
  assert.doesNotMatch(confirm, /resolveFarcasterCastHashFromUrl|buildGenLayerSubmissionCall/);
  assert.match(confirm, /const contentId = contentIdentifier\(source, contentArg\)/);
});

test("every reusable submitted marketplace journal returns confirm-only recovery instead of a transaction", async () => {
  const [repository, actions, service] = await Promise.all([
    readFile(new URL("../lib/marketplace-genlayer-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/marketplace-genlayer-actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/marketplace-genlayer-service.ts", import.meta.url), "utf8"),
  ]);
  const dtoStart = repository.indexOf("function preparedDto(");
  const dtoEnd = repository.indexOf("function validateCall", dtoStart);
  assert.ok(dtoStart >= 0 && dtoEnd > dtoStart);
  const dto = repository.slice(dtoStart, dtoEnd);
  assert.match(dto, /recovery: row\.transactionHash/);
  assert.match(dto, /preparedId: row\.preparedId/);
  assert.match(dto, /transactionHash: row\.transactionHash/);

  const fieldsStart = actions.indexOf("function preparedMutationFields(");
  const fieldsEnd = actions.indexOf("function applicationDto", fieldsStart);
  assert.ok(fieldsStart >= 0 && fieldsEnd > fieldsStart);
  const fields = actions.slice(fieldsStart, fieldsEnd);
  const recoveryBranch = fields.slice(0, fields.indexOf("return {", fields.indexOf("if (prepared.recovery)") + 1));
  assert.doesNotMatch(recoveryBranch, /transaction: prepared\.call/);
  assert.match(fields, /txHash: prepared\.recovery\.transactionHash/);
  assert.match(fields, /transaction: prepared\.call[\s\S]*recovery: null/);
  assert.equal(actions.match(/preparedMutationFields\(prepared\)/g)?.length, 5);

  const fundingStart = service.indexOf("export async function prepareGenLayerCampaignFunding");
  const fundingEnd = service.indexOf("export async function confirmGenLayerCampaignFunding", fundingStart);
  assert.ok(fundingStart >= 0 && fundingEnd > fundingStart);
  const funding = service.slice(fundingStart, fundingEnd);
  const submittedBranch = funding.slice(
    funding.indexOf("return prepared.recovery"),
    funding.indexOf(": {", funding.indexOf("return prepared.recovery")),
  );
  assert.doesNotMatch(submittedBranch, /transaction: prepared\.call/);
  assert.match(funding, /txHash: prepared\.recovery\.transactionHash/);
  assert.match(funding, /transaction: prepared\.call[\s\S]*recovery: null/);
});

test("prepared intent is atomically single-broadcast and null-hash conflicts fail closed", async () => {
  const [repository, schema, migration, actions] = await Promise.all([
    readFile(new URL("../lib/marketplace-genlayer-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/postgres-schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle-postgres/0014_marketplace_transaction_intent_fence.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/marketplace-genlayer-actions.ts", import.meta.url), "utf8"),
  ]);
  const prepareStart = repository.indexOf("export async function prepareGenLayerMarketplaceTransaction");
  const prepareEnd = repository.indexOf("function assertReservedPreparedTransaction", prepareStart);
  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart);
  const prepare = repository.slice(prepareStart, prepareEnd);
  assert.match(prepare, /marketplaceTransactionIntentBaseKey\(/);
  assert.match(prepare, /findGenLayerTransactionRetryPredecessor\(/);
  assert.match(prepare, /marketplaceTransactionAttemptKey\(/);
  assert.match(prepare, /intentKey,/);
  assert.match(prepare, /\.onConflictDoNothing\(\)/);
  const conflict = prepare.indexOf("if (!created)");
  const ready = prepare.lastIndexOf("return preparedDto(created)");
  assert.ok(conflict >= 0 && ready > conflict, "only the successful inserter may receive a broadcastable call");
  assert.match(prepare.slice(conflict, ready), /findGenLayerPreparedTransactionByIntentKey\(intentKey\)/);
  assert.match(prepare.slice(conflict, ready), /recoverOrRejectExistingPreparedTransaction\(conflict\)/);

  const dispositionStart = repository.indexOf("function recoverOrRejectExistingPreparedTransaction");
  const dispositionEnd = repository.indexOf("async function findGenLayerPreparedTransactionByIntentKey", dispositionStart);
  const disposition = repository.slice(dispositionStart, dispositionEnd);
  assert.match(disposition, /existingPreparedMarketplaceTransactionDisposition\(row\)/);
  assert.match(disposition, /MARKETPLACE_TRANSACTION_RETRY_REQUIRED/);
  assert.match(disposition, /MARKETPLACE_TRANSACTION_STATE_UNKNOWN/);
  assert.ok(
    disposition.indexOf('disposition === "RETRY"')
      < disposition.indexOf('disposition === "RECOVERY"'),
  );

  const reusableStart = repository.indexOf("async function findReusablePreparedTransaction");
  const reusableEnd = repository.indexOf("async function findGenLayerTransactionRetryPredecessor", reusableStart);
  const reusable = repository.slice(reusableStart, reusableEnd);
  assert.match(reusable, /marketplaceGenLayerTransactions\.network/);
  assert.match(reusable, /marketplaceGenLayerTransactions\.chainId/);
  assert.match(reusable, /marketplaceGenLayerTransactions\.functionName/);
  assert.match(reusable, /marketplaceGenLayerTransactions\.onchainEntityId/);
  assert.doesNotMatch(reusable, /EXECUTION_FAILED|NETWORK_TERMINATED/);

  const predecessorStart = reusableEnd;
  const predecessorEnd = repository.indexOf("function marketplaceTransactionIntentBaseKey", predecessorStart);
  const predecessor = repository.slice(predecessorStart, predecessorEnd);
  assert.match(predecessor, /includeFinalized/);
  assert.match(predecessor, /\["EXECUTION_FAILED", "NETWORK_TERMINATED", "FINALIZED"\]/);
  assert.match(predecessor, /desc\(marketplaceGenLayerTransactions\.createdAt\)/);
  const attemptStart = repository.indexOf("function marketplaceTransactionAttemptKey", predecessorEnd);
  const attemptEnd = repository.indexOf("function preparedDto", attemptStart);
  const attempt = repository.slice(attemptStart, attemptEnd);
  assert.match(attempt, /predecessor\?\.preparedId/);
  assert.match(attempt, /predecessor\?\.status/);

  assert.match(schema, /intentKey: text\("intent_key"\)/);
  assert.match(schema, /uniqueIndex\("marketplace_genlayer_transactions_intent_idx"\)/);
  const schemaIntentIndex = schema.slice(
    schema.indexOf('uniqueIndex("marketplace_genlayer_transactions_intent_idx")'),
    schema.indexOf('index("marketplace_genlayer_transactions_reconcile_idx")'),
  );
  assert.match(schemaIntentIndex, /PREPARED.*SUBMITTED.*ACCEPTED.*FINALIZED.*RECONCILIATION_REQUIRED/);
  assert.doesNotMatch(schemaIntentIndex, /EXECUTION_FAILED|NETWORK_TERMINATED/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_genlayer_transactions_intent_idx"/);
  assert.match(migration, /"status" IN \([\s\S]*'FINALIZED'[\s\S]*'RECONCILIATION_REQUIRED'/);
  assert.doesNotMatch(migration, /EXECUTION_FAILED|NETWORK_TERMINATED/);
  assert.doesNotMatch(actions, /resumePreparedGenLayerApplication|findPreparedGenLayerApplicationResumeJournal|applicationResumeRecordExists/);
  await assert.rejects(
    readFile(
      new URL("../app/api/marketplace/campaigns/[campaignId]/applications/[applicationId]/apply/resume/route.ts", import.meta.url),
      "utf8",
    ),
    { code: "ENOENT" },
  );
});

test("same-tab prepared-call retry is retained only for exact numeric EIP-1193 rejection", () => {
  assert.equal(isExplicitEip1193UserRejection({ code: 4_001 }), true);
  assert.equal(isExplicitEip1193UserRejection({ code: "4001" }), false);
  assert.equal(isExplicitEip1193UserRejection({ code: 4_101 }), false);
  assert.equal(isExplicitEip1193UserRejection(new Error("User rejected")), false);
  assert.equal(isExplicitEip1193UserRejection(null), false);
  assert.equal(existingPreparedMarketplaceTransactionDisposition({ status: "SUBMITTED", transactionHash: txHash }), "RECOVERY");
  assert.equal(existingPreparedMarketplaceTransactionDisposition({ status: "PREPARED", transactionHash: null }), "UNKNOWN");
  assert.equal(existingPreparedMarketplaceTransactionDisposition({ status: "EXECUTION_FAILED", transactionHash: txHash }), "RETRY");
  assert.equal(existingPreparedMarketplaceTransactionDisposition({ status: "NETWORK_TERMINATED", transactionHash: txHash }), "RETRY");
});

test("database verifier requires the complete native projection and activation schema", async () => {
  const verifier = await readFile(
    new URL("../scripts/verify-database.mjs", import.meta.url),
    "utf8",
  );
  for (const required of [
    "marketplace_genlayer_profiles",
    "marketplace_genlayer_campaigns",
    "marketplace_genlayer_assignments",
    "marketplace_genlayer_transactions",
    "marketplace_genlayer_claimable_balances",
    "marketplace_genlayer_withdrawals",
    "marketplace_genlayer_projection_cursors",
    "marketplace_genlayer_maintenance_generations",
    "activation_prepared_id",
    "activation_tx_hash",
    "activation_confirmed_at",
    "farcaster_cast_hash",
    "marketplace_genlayer_assignments_entity_contract_idx",
    "intent_key",
    "marketplace_genlayer_transactions_intent_idx",
  ]) assert.match(verifier, new RegExp(required));
  assert.match(verifier, /genLayerNativeReady: true/);
  assert.doesNotMatch(verifier, /column_count !== 68|base_relay_column_count|marketplace_relay_column_count/);
});

test("active marketplace and verification APIs cannot import retired Base modules", async () => {
  const roots = [
    new URL("../app/api/marketplace/", import.meta.url),
    new URL("../app/api/verification/", import.meta.url),
    new URL("../app/api/queues/", import.meta.url),
    new URL("../app/api/internal/", import.meta.url),
  ];
  const files = (await Promise.all(roots.map((root) => routeFiles(root)))).flat();
  const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const combined = sources.join("\n");
  assert.doesNotMatch(
    combined,
    /from\s+["'][^"']*(?:marketplace-service|marketplace-settlement|marketplace-genlayer-bridge|marketplace-chain|marketplace-metrics-service|marketplace-metrics-binding|verification-service|campaign-relay-client|marketplace-resolution-binding|ownership-authorization-broker)[^"']*["']/,
  );
  const retiredBaseRelay = await readFile(
    new URL("../app/api/internal/base-relay/ownership-authorization/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(retiredBaseRelay, /HISTORICAL_BASE_RELAY_RETIRED/);
  assert.match(retiredBaseRelay, /status: 410/);
});

test("terminal identity activation releases the request lock while UNDETERMINED remains retryable", async () => {
  const [activation, nativeVerification, migration] = await Promise.all([
    readFile(new URL("../lib/marketplace-genlayer-activation.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/verification-native-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle-postgres/0009_genlayer_native_marketplace.sql", import.meta.url), "utf8"),
  ]);
  assert.match(activation, /activeOwnerUserId: ownershipResult\.outcome === "UNDETERMINED" \? row\.activeOwnerUserId : null/);
  assert.match(activation, /activeWallet: ownershipResult\.outcome === "UNDETERMINED" \? row\.activeWallet : null/);
  assert.match(nativeVerification, /eq\(verificationRequests\.activeOwnerUserId, ownerUserId\)/);
  assert.match(migration, /activation_confirmed_at[\s\S]*genlayer_outcome" IN \('VERIFIED', 'REJECTED'\)/);
});

test("application preparation rejects expired projections and rechecks authoritative identity state", async () => {
  const actions = await readFile(
    new URL("../lib/marketplace-genlayer-actions.ts", import.meta.url),
    "utf8",
  );
  assert.match(actions, /profile\.expiresAt <= nowMs/);
  assert.doesNotMatch(actions, /profile\.expiresAt \* 1_000/);
  assert.match(actions, /readMarketplaceState\([\s\S]*"get_identity"/);
  assert.match(actions, /authoritativeProfile\.identityHash !== profile\.identityHash/);
});

async function routeFiles(root: URL): Promise<URL[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, root);
    if (entry.isDirectory()) return routeFiles(url);
    return entry.name.endsWith(".ts") ? [url] : [];
  }));
  return nested.flat();
}

function journalClaim(): GenLayerTransactionRow & { fenceToken: string } {
  return {
    preparedId: "11111111-1111-4111-8111-111111111111",
    network: "studionet",
    chainId: 61_999,
    contractAddress: marketplaceAddress,
    operation: "APPLY",
    functionName: "apply_to_campaign",
    args: [campaignId, `0x${"62".repeat(32)}`, "1", `0x${"63".repeat(32)}`],
    argTypes: ["string", "string", "uint256", "string"],
    argsHash: canonicalHash([campaignId, `0x${"62".repeat(32)}`, "1", `0x${"63".repeat(32)}`]),
    intentKey: null,
    valueAtto: "0",
    actorWallet: creator,
    localCampaignId: "22222222-2222-4222-8222-222222222222",
    localApplicationId: "33333333-3333-4333-8333-333333333333",
    onchainEntityId: `0x${"62".repeat(32)}`,
    transactionHash: txHash,
    status: "SUBMITTED",
    lifecycleStatus: null,
    executionResult: null,
    errorCode: null,
    submittedAt: 1_800_000_000_000,
    acceptedAt: null,
    finalizedAt: null,
    lastCheckedAt: 1_800_000_000_000,
    reconciliationAttempts: 1,
    nextReconcileAt: 1_800_000_000_000,
    fenceToken: "44444444-4444-4444-8444-444444444444",
    fenceExpiresAt: 1_800_000_240_000,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  };
}

function progressionAssignment(
  overrides: Partial<GenLayerAssignmentState> = {},
): GenLayerAssignmentState {
  return {
    assignmentId,
    campaignId,
    brand,
    creator,
    contentSource: "X",
    creatorIdentityHash: `0x${"47".repeat(32)}`,
    applicationId: `0x${"48".repeat(32)}`,
    agreementHash: `0x${"49".repeat(32)}`,
    resolutionRequestId: requestId,
    status: "SELECTED",
    acceptanceDeadlineEpoch: 1_800_000_000,
    ...overrides,
  } as GenLayerAssignmentState;
}

function maintenanceGeneration(
  overrides: Partial<MarketplaceMaintenanceGeneration> = {},
): MarketplaceMaintenanceGeneration {
  return Object.freeze({
    deploymentId: maintenanceDeploymentId,
    generation: 7,
    activatedAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    ...overrides,
  });
}

function maintenanceMessage() {
  return Object.freeze({
    schemaVersion: 2 as const,
    deploymentId: maintenanceDeploymentId,
    generation: 7,
    slot: 6_000_001,
  });
}

function inMemoryMaintenanceGenerationStore(
  readState: () => MarketplaceMaintenanceGeneration | null,
  writeState: (state: MarketplaceMaintenanceGeneration) => void,
): MarketplaceMaintenanceGenerationStore {
  return Object.freeze({
    async read() {
      return readState();
    },
    async insertFirst(context, nowMs) {
      if (readState()) return null;
      const next = maintenanceGeneration({
        deploymentId: context.deploymentId,
        generation: 1,
        activatedAt: nowMs,
        updatedAt: nowMs,
      });
      writeState(next);
      return next;
    },
    async compareAndSwap(context, current, nowMs) {
      const observed = readState();
      if (
        !observed ||
        observed.deploymentId !== current.deploymentId ||
        observed.generation !== current.generation
      ) {
        return null;
      }
      const next = maintenanceGeneration({
        deploymentId: context.deploymentId,
        generation: current.generation + 1,
        activatedAt: nowMs,
        updatedAt: nowMs,
      });
      writeState(next);
      return next;
    },
  });
}

function progressionCampaign(
  overrides: Partial<GenLayerCampaignState> = {},
): GenLayerCampaignState {
  return {
    campaignId,
    brand,
    clientNonce: "progression-client-0001",
    contentSource: "X",
    termsHash: `0x${"50".repeat(32)}`,
    budgetAtto: "1000",
    status: "OPEN",
    reservedAtto: "0",
    submissionDeadlineEpoch: 1_800_000_000,
    retentionSeconds: 3_600,
    ...overrides,
  } as GenLayerCampaignState;
}

function progressionAssignmentProjection(
  overrides: Partial<GenLayerAssignmentProjection> = {},
): GenLayerAssignmentProjection {
  const state = progressionAssignment();
  return {
    assignmentId,
    campaignId,
    creatorWallet: creator,
    creatorIdentityHash: state.creatorIdentityHash,
    contentSource: "X",
    applicationId: state.applicationId,
    agreementHash: state.agreementHash,
    resolutionRequestId: requestId,
    ...overrides,
  } as GenLayerAssignmentProjection;
}

function progressionCampaignProjection(
  overrides: Partial<GenLayerCampaignProjection> = {},
): GenLayerCampaignProjection {
  const state = progressionCampaign();
  return {
    campaignId,
    brandWallet: brand,
    clientNonce: state.clientNonce,
    contentSource: "X",
    termsHash: state.termsHash,
    budgetAtto: state.budgetAtto,
    status: "OPEN",
    reservedAtto: "0",
    submissionDeadlineEpoch: state.submissionDeadlineEpoch,
    retentionSeconds: state.retentionSeconds,
    ...overrides,
  } as GenLayerCampaignProjection;
}

function progressionOperation(
  action: GenLayerOperatorAction,
  status: GenLayerOperatorStatus,
): GenLayerOperatorProjection {
  const finalized = status === "FINALIZED";
  const now = "2026-08-19T12:00:00.000Z";
  return {
    operationId: `0x${"51".repeat(32)}`,
    network: "studionet",
    chainId: 61_999,
    contractAddress: marketplaceAddress,
    action,
    functionName: action,
    valueAtto: "0",
    preStateFingerprint: `0x${"52".repeat(32)}`,
    postStateFingerprint: finalized ? `0x${"53".repeat(32)}` : null,
    status,
    lifecycleStatus: finalized ? "FINALIZED" : null,
    executionResult: finalized ? "SUCCESS" : null,
    txHash: finalized ? `0x${"54".repeat(32)}` : null,
    queueMessageId: "queue-message",
    enqueueAttempts: 1,
    deliveryCount: 1,
    pollAttempts: 1,
    errorCode: status === "PRECHECK_FAILED" ? "STUDIONET_RPC_UNAVAILABLE" : null,
    broadcastStartedAt: finalized ? now : null,
    submittedAt: finalized ? now : null,
    lastPolledAt: finalized ? now : null,
    finalizedAt: finalized ? now : null,
    createdAt: now,
    updatedAt: now,
  };
}

function toContractCampaign(state: ReturnType<typeof parseCampaignState>) {
  return {
    campaign_id: state.campaignId,
    brand: state.brand,
    client_nonce: state.clientNonce,
    content_source: state.contentSource,
    title: state.title,
    brief: state.brief,
    required_phrases: state.requiredPhrases,
    forbidden_phrases: state.forbiddenPhrases,
    require_ad_disclosure: state.requireAdDisclosure,
    terms_hash: state.termsHash,
    status: state.status,
    application_deadline_epoch: state.applicationDeadlineEpoch,
    selection_deadline_epoch: state.selectionDeadlineEpoch,
    submission_deadline_epoch: state.submissionDeadlineEpoch,
    retention_seconds: state.retentionSeconds,
    max_undetermined_retries: state.maxUndeterminedRetries,
    fee_bps: state.feeBps,
    treasury: state.treasury,
    budget_atto: state.budgetAtto,
    available_atto: state.availableAtto,
    reserved_atto: state.reservedAtto,
    settled_atto: state.settledAtto,
    creator_paid_atto: state.creatorPaidAtto,
    brand_refunded_atto: state.brandRefundedAtto,
    fee_atto: state.feeAtto,
    application_count: state.applicationCount,
    assignment_count: state.assignmentCount,
    created_at_epoch: state.createdAtEpoch,
    closed_at_epoch: state.closedAtEpoch,
  };
}
