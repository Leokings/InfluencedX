import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { abi } from "genlayer-js";

import { hydrateArgs } from "../app/marketplace/marketplace-transaction.ts";
import { buildCampaignContractBrief } from "../lib/marketplace-core.ts";
import { nextGenLayerResolutionProgression } from "../lib/marketplace-genlayer-actions.ts";
import {
  assertFinalizedOwnershipTiming,
  projectIdentityActiveAt,
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
  deriveProjectionId,
  deriveResolutionRequestId,
  normalizeContractText,
  parseCampaignState,
  parseOwnershipResult,
  ownershipOutcomeAllowsRetry,
  type GenLayerAssignmentState,
  type GenLayerCampaignState,
} from "../lib/marketplace-genlayer-core.ts";
import {
  MAX_GENLAYER_RECONCILIATION_ATTEMPTS,
  type GenLayerTransactionRow,
  type GenLayerAssignmentProjection,
  type GenLayerCampaignProjection,
} from "../lib/marketplace-genlayer-repository.ts";
import {
  runGenLayerJournalReconciliationBatch,
} from "../lib/marketplace-genlayer-journal.ts";
import {
  MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS,
  MARKETPLACE_MAINTENANCE_QUEUE_TOPIC,
  MARKETPLACE_MAINTENANCE_RETENTION_SECONDS,
  MarketplaceMaintenanceMessageError,
  enqueueMarketplaceMaintenanceHeartbeat,
  validateMarketplaceMaintenanceMessage,
} from "../lib/marketplace-genlayer-maintenance-queue.ts";
import type {
  GenLayerOperatorAction,
  GenLayerOperatorProjection,
  GenLayerOperatorStatus,
} from "../lib/marketplace-genlayer-operator-client.ts";
import {
  assertTransactionMatchesPreparedCall,
  canonicalJson,
  finalizedExecution,
  loadFinalizedMarketplaceTransaction,
  marketplaceRpcContractAddress,
  MarketplaceGenLayerFinalityError,
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
const marketplaceAddress = "0x58d598b8323e9c1d041989dcce80e737109de347";
const creator = "0x5555555555555555555555555555555555555555";

test("StudioNet RPC calls preserve the deployed checksum address", () => {
  assert.equal(
    marketplaceRpcContractAddress(),
    "0x58D598B8323E9C1d041989DccE80E737109DE347",
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
  const [activation, repository] = await Promise.all([
    readFile(new URL("../lib/marketplace-genlayer-activation.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/marketplace-genlayer-repository.ts", import.meta.url), "utf8"),
  ]);
  assert.match(activation, /reuseFinalized: row\.genlayerOutcome !== "UNDETERMINED"/);
  assert.match(repository, /input\.reuseFinalized[\s\S]*"FINALIZED"/);
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

test("maintenance heartbeat carries no operation authority and self-schedules by slot", async () => {
  const calls: unknown[][] = [];
  const result = await enqueueMarketplaceMaintenanceHeartbeat(
    { nowMs: 1_800_000_000_000, delaySeconds: MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS },
    (async (...args: unknown[]) => {
      calls.push(args);
      return { messageId: "msg_maintenance_1" };
    }) as never,
  );
  const expectedSlot = Math.floor(
    (1_800_000_000_000 + MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS * 1_000) /
      (MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS * 1_000),
  );
  assert.deepEqual(result, { messageId: "msg_maintenance_1", slot: expectedSlot });
  assert.deepEqual(calls[0], [
    MARKETPLACE_MAINTENANCE_QUEUE_TOPIC,
    { schemaVersion: 1, slot: expectedSlot },
    {
      idempotencyKey: `influencedx-studionet-maintenance-v1:${expectedSlot}`,
      retentionSeconds: MARKETPLACE_MAINTENANCE_RETENTION_SECONDS,
      delaySeconds: MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(calls[0]?.[1]), /operation|method|args|value|wallet|transaction/i);
  assert.throws(
    () => validateMarketplaceMaintenanceMessage({
      schemaVersion: 1,
      slot: expectedSlot,
      functionName: "cancel_campaign",
    }),
    MarketplaceMaintenanceMessageError,
  );
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

test("live-shaped StudioNet snake tx_data is decoded fail closed", async () => {
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
          current_timestamp: "1800000001",
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
    "activation_prepared_id",
    "activation_tx_hash",
    "activation_confirmed_at",
    "farcaster_cast_hash",
    "marketplace_genlayer_assignments_entity_contract_idx",
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

test("application preparation rejects expired projections and rechecks authoritative source identity", async () => {
  const actions = await readFile(
    new URL("../lib/marketplace-genlayer-actions.ts", import.meta.url),
    "utf8",
  );
  assert.match(actions, /profile\.expiresAt <= Date\.now\(\)/);
  assert.doesNotMatch(actions, /profile\.expiresAt \* 1_000/);
  assert.match(actions, /readMarketplaceState\("get_identity"/);
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
    argsHash: `0x${"64".repeat(32)}`,
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
