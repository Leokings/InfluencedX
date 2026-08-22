import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DuplicateMessageError } from "@vercel/queue";
import {
  CampaignProgressionPoisonError,
  CampaignProgressionRetryError,
  assertCampaignProgressionConfigured,
  campaignProgressionQueueRetryDelaySeconds,
  campaignProgressionRequestIsAuthorized,
  processQueuedCampaignProgression,
  runCampaignProgressionBatch,
} from "../lib/campaign-progression.ts";
import {
  CAMPAIGN_PROGRESSION_QUEUE_RETENTION_SECONDS,
  CAMPAIGN_PROGRESSION_QUEUE_TOPIC,
  CampaignProgressionQueueMessageError,
  enqueueCampaignProgression,
  validateCampaignProgressionQueueMessage,
} from "../lib/campaign-progression-queue.ts";
import { ApiProblem } from "../lib/verification-api.ts";
import { MARKETPLACE_MAINTENANCE_QUEUE_TOPIC } from "../lib/marketplace-genlayer-maintenance-queue.ts";
import type { MarketplaceProgressionClaim } from "../lib/marketplace-repository.ts";

const NOW = 1_786_536_000_000;
const SECRET = "campaign-progression-secret-with-at-least-32-bytes";
const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const APPLICATION_ID = "22222222-2222-4222-8222-222222222222";
const FENCE_TOKEN = "33333333-3333-4333-8333-333333333333";
const REQUEST_ID = `0x${"a".repeat(64)}`;

test("campaign progression cron authentication fails closed", () => {
  const authorized = new Request("https://influencedx.example/api/internal/campaign-progression", {
    headers: { authorization: `Bearer ${SECRET}` },
  });
  assert.equal(campaignProgressionRequestIsAuthorized(authorized, SECRET), true);
  assert.equal(
    campaignProgressionRequestIsAuthorized(
      new Request(authorized.url, { headers: { authorization: "Bearer wrong" } }),
      SECRET,
    ),
    false,
  );
  assert.equal(campaignProgressionRequestIsAuthorized(authorized, "short"), false);
});

test("hosted progression requires every server boundary before claiming", () => {
  const complete = {
    NODE_ENV: "test",
    VERCEL: "1",
    XPROOF_MARKETPLACE_MUTATIONS_ENABLED: "true",
    XPROOF_SUBMITTER_BRIDGE_ENABLED: "true",
    XPROOF_SUBMITTER_URL: "https://submitter.example.test",
    XPROOF_CAMPAIGN_RELAY_BRIDGE_ENABLED: "true",
    XPROOF_CAMPAIGN_RELAY_URL: "https://relay.example.test",
    XPROOF_CAMPAIGN_RELAY_SERVICE_TOKEN: "r".repeat(32),
    DATABASE_URL: "postgresql://user:password@db.example.test/influencedx",
  } satisfies NodeJS.ProcessEnv;
  assert.doesNotThrow(() => assertCampaignProgressionConfigured(complete));
  for (const key of [
    "XPROOF_MARKETPLACE_MUTATIONS_ENABLED",
    "XPROOF_SUBMITTER_BRIDGE_ENABLED",
    "XPROOF_CAMPAIGN_RELAY_BRIDGE_ENABLED",
    "XPROOF_CAMPAIGN_RELAY_SERVICE_TOKEN",
    "DATABASE_URL",
  ] as const) {
    assert.throws(
      () => assertCampaignProgressionConfigured({ ...complete, [key]: undefined }),
      (error: unknown) => {
        assert.ok(error instanceof ApiProblem);
        assert.equal(error.code, "CAMPAIGN_PROGRESSION_CONFIGURATION_REQUIRED");
        return true;
      },
    );
  }
});

test("worker claims a bounded batch and advances only immutable persisted bindings", async () => {
  const claims = [claim(1), claim(2)];
  const advanced: Array<Record<string, unknown>> = [];
  const finished: Array<Record<string, unknown>> = [];
  let claimCalls = 0;
  const result = await runCampaignProgressionBatch({
    batchSize: 3,
    dependencies: {
      assertConfigured: () => undefined,
      nowMs: () => NOW,
      randomFenceToken: () => `00000000-0000-4000-8000-00000000000${claimCalls + 1}`,
      claim: async () => {
        claimCalls += 1;
        return claims.shift() ?? null;
      },
      advance: async (input) => {
        advanced.push(input);
        return {
          submission: { status: "POLLING" } as never,
          settlement: null,
        };
      },
      finish: async (input) => {
        finished.push(input);
        return true;
      },
    },
  });
  assert.equal(claimCalls, 3);
  assert.equal(result.claimed, 2);
  assert.equal(result.advanced, 2);
  assert.equal(result.capped, false);
  assert.deepEqual(
    advanced.map(({ requestId, expectedApplicationId, expectedCampaignId }) => ({
      requestId,
      expectedApplicationId,
      expectedCampaignId,
    })),
    [
      { requestId: hash(1), expectedApplicationId: "application-1", expectedCampaignId: "campaign-1" },
      { requestId: hash(2), expectedApplicationId: "application-2", expectedCampaignId: "campaign-2" },
    ],
  );
  assert.ok(finished.every((entry) => entry.errorCode === null));
  assert.ok(finished.every((entry) => entry.nextAttemptAt === NOW + 45_000));
});

test("worker releases retryable failures with bounded exponential backoff", async () => {
  const completions: Array<Record<string, unknown>> = [];
  const result = await runCampaignProgressionBatch({
    batchSize: 1,
    dependencies: {
      assertConfigured: () => undefined,
      nowMs: () => NOW,
      randomFenceToken: () => "00000000-0000-4000-8000-000000000001",
      claim: async () => claim(1, 3),
      advance: async () => {
        throw new ApiProblem(503, "BASE_RELAY_UNAVAILABLE", "retry");
      },
      finish: async (input) => {
        completions.push(input);
        return true;
      },
    },
  });
  assert.equal(result.retryScheduled, 1);
  assert.equal(completions[0]?.errorCode, "BASE_RELAY_UNAVAILABLE");
  assert.equal(completions[0]?.nextAttemptAt, NOW + 4 * 60_000);
});

test("a simulated relay cannot be projected as a completed Base settlement", async () => {
  let errorCode: unknown;
  const result = await runCampaignProgressionBatch({
    batchSize: 1,
    dependencies: {
      assertConfigured: () => undefined,
      nowMs: () => NOW,
      randomFenceToken: () => "00000000-0000-4000-8000-000000000001",
      claim: async () => claim(1),
      advance: async () => ({
        submission: { status: "FINALIZED" } as never,
        settlement: {
          requestId: hash(1) as `0x${string}`,
          status: "SIMULATED",
          broadcast: false,
          txHash: null,
          outcome: "PASS",
        },
      }),
      finish: async (input) => {
        errorCode = input.errorCode;
        return true;
      },
    },
  });
  assert.equal(result.retryScheduled, 1);
  assert.equal(errorCode, "BASE_RELAY_BROADCAST_DISABLED");
});

test("queue publisher emits only immutable identifiers with bounded retention", async () => {
  const calls: unknown[][] = [];
  const result = await enqueueCampaignProgression(
    {
      requestId: REQUEST_ID,
      assignmentId: `0x${"ab".repeat(32)}`,
    },
    (async (...args: unknown[]) => {
      calls.push(args);
      return { messageId: "msg_campaign_1" };
    }) as never,
  );
  assert.equal(result.messageId, "msg_campaign_1");
  assert.equal(calls.length, 1);
  const [topic, payload, options] = calls[0] ?? [];
  assert.equal(topic, CAMPAIGN_PROGRESSION_QUEUE_TOPIC);
  assert.deepEqual(payload, {
    schemaVersion: 2,
    assignmentId: `0x${"ab".repeat(32)}`,
    requestId: REQUEST_ID,
  });
  assert.deepEqual(options, {
    idempotencyKey: `influencedx-campaign-progression-v4:0x${"ab".repeat(32)}:${REQUEST_ID}`,
    retentionSeconds: CAMPAIGN_PROGRESSION_QUEUE_RETENTION_SECONDS,
    delaySeconds: 0,
  });
  assert.doesNotMatch(JSON.stringify(payload), /private|secret|watcher|evidence|signature/i);
});

test("queue message validation rejects extra fields and malformed bindings", () => {
  assert.throws(
    () => validateCampaignProgressionQueueMessage({
      schemaVersion: 2,
      assignmentId: `0x${"ab".repeat(32)}`,
      requestId: REQUEST_ID,
      rawEvidence: "must-not-cross-the-queue",
    }),
    CampaignProgressionQueueMessageError,
  );
  assert.throws(
    () => validateCampaignProgressionQueueMessage({
      schemaVersion: 2,
      assignmentId: `0x${"ab".repeat(32)}`,
      requestId: "0x1234",
    }),
    CampaignProgressionQueueMessageError,
  );
});

test("an idempotency duplicate confirms the existing queue delivery", async () => {
  const result = await enqueueCampaignProgression(
    {
      requestId: REQUEST_ID,
      assignmentId: `0x${"ab".repeat(32)}`,
    },
    (async () => {
      throw new DuplicateMessageError(
        "already queued",
        `influencedx-campaign-progression:${REQUEST_ID}`,
      );
    }) as never,
  );
  assert.deepEqual(result, { messageId: null });
});

test("queue consumer claims and finalizes one exact persisted request binding", async () => {
  const claimInputs: Array<Record<string, unknown>> = [];
  const finishInputs: Array<Record<string, unknown>> = [];
  const result = await processQueuedCampaignProgression({
    requestId: REQUEST_ID,
    campaignId: CAMPAIGN_ID,
    applicationId: APPLICATION_ID,
    dependencies: {
      assertConfigured: () => undefined,
      nowMs: () => NOW,
      randomFenceToken: () => FENCE_TOKEN,
      claimByRequestId: async (input) => {
        claimInputs.push(input);
        return queueClaim();
      },
      advance: async () => ({
        submission: { status: "FINALIZED" } as never,
        settlement: {
          requestId: REQUEST_ID as `0x${string}`,
          status: "CONFIRMED",
          broadcast: true,
          txHash: `0x${"b".repeat(64)}` as `0x${string}`,
          outcome: "PASS",
        },
      }),
      finish: async (input) => {
        finishInputs.push(input);
        return true;
      },
    },
  });
  assert.deepEqual(result, { kind: "FINALIZED" });
  assert.deepEqual(claimInputs[0], {
    requestId: REQUEST_ID,
    expectedApplicationId: APPLICATION_ID,
    expectedCampaignId: CAMPAIGN_ID,
    fenceToken: FENCE_TOKEN,
    nowMs: NOW,
    leaseDurationMs: 4 * 60_000,
  });
  assert.equal(finishInputs[0]?.applicationId, APPLICATION_ID);
  assert.equal(finishInputs[0]?.fenceToken, FENCE_TOKEN);
});

test("queue consumer retries a nonterminal projection after releasing its lease", async () => {
  let nextAttemptAt: unknown;
  await assert.rejects(
    processQueuedCampaignProgression({
      requestId: REQUEST_ID,
      campaignId: CAMPAIGN_ID,
      applicationId: APPLICATION_ID,
      dependencies: {
        assertConfigured: () => undefined,
        nowMs: () => NOW,
        randomFenceToken: () => FENCE_TOKEN,
        claimByRequestId: async () => queueClaim(),
        advance: async () => ({
          submission: { status: "POLLING" } as never,
          settlement: null,
        }),
        finish: async (input) => {
          nextAttemptAt = input.nextAttemptAt;
          return true;
        },
      },
    }),
    CampaignProgressionRetryError,
  );
  assert.equal(nextAttemptAt, NOW + 45_000);
});

test("queue consumer acknowledges completed work and poisons changed bindings", async () => {
  const terminal = await processQueuedCampaignProgression({
    requestId: REQUEST_ID,
    campaignId: CAMPAIGN_ID,
    applicationId: APPLICATION_ID,
    dependencies: {
      assertConfigured: () => undefined,
      nowMs: () => NOW,
      randomFenceToken: () => FENCE_TOKEN,
      claimByRequestId: async () => null,
      findContext: async () => ({
        campaign: { id: CAMPAIGN_ID, status: "PAID" },
        application: {
          id: APPLICATION_ID,
          resolutionTxHash: `0x${"c".repeat(64)}`,
        },
      }) as never,
    },
  });
  assert.deepEqual(terminal, { kind: "TERMINAL" });

  await assert.rejects(
    processQueuedCampaignProgression({
      requestId: REQUEST_ID,
      campaignId: CAMPAIGN_ID,
      applicationId: APPLICATION_ID,
      dependencies: {
        assertConfigured: () => undefined,
        nowMs: () => NOW,
        randomFenceToken: () => FENCE_TOKEN,
        claimByRequestId: async () => null,
        findContext: async () => ({
          campaign: { id: CAMPAIGN_ID },
          application: { id: "44444444-4444-4444-8444-444444444444" },
        }) as never,
      },
    }),
    CampaignProgressionPoisonError,
  );
});

test("queue retries are bounded and Hobby uses a queue heartbeat with a daily bootstrap", async () => {
  assert.equal(campaignProgressionQueueRetryDelaySeconds(1), 60);
  assert.equal(campaignProgressionQueueRetryDelaySeconds(2), 120);
  assert.equal(campaignProgressionQueueRetryDelaySeconds(99), 900);
  const config = JSON.parse(
    await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  ) as {
    functions?: Record<string, { experimentalTriggers?: unknown[] }>;
    crons?: Array<{ path?: string; schedule?: string }>;
  };
  assert.deepEqual(
    config.functions?.["app/api/queues/campaign-progression/route.ts"]
      ?.experimentalTriggers,
    [{
      type: "queue/v2beta",
      topic: CAMPAIGN_PROGRESSION_QUEUE_TOPIC,
      retryAfterSeconds: 60,
      initialDelaySeconds: 0,
    }],
  );
  assert.deepEqual(
    config.functions?.["app/api/queues/marketplace-maintenance/route.ts"]
      ?.experimentalTriggers,
    [{
      type: "queue/v2beta",
      topic: MARKETPLACE_MAINTENANCE_QUEUE_TOPIC,
      retryAfterSeconds: 60,
      initialDelaySeconds: 0,
    }],
  );
  assert.deepEqual(
    config.crons?.filter((cron) => cron.path?.includes("campaign-progression")),
    [{ path: "/api/internal/campaign-progression", schedule: "0 4 * * *" }],
  );
  assert.ok(config.crons?.every((cron) => !cron.schedule?.includes("*/5")));
});

function claim(index: number, attemptCount = 1): MarketplaceProgressionClaim {
  return Object.freeze({
    applicationId: `application-${index}`,
    campaignId: `campaign-${index}`,
    requestId: hash(index),
    fenceToken: `00000000-0000-4000-8000-00000000000${index}`,
    attemptCount,
  });
}

function queueClaim(): MarketplaceProgressionClaim {
  return Object.freeze({
    applicationId: APPLICATION_ID,
    campaignId: CAMPAIGN_ID,
    requestId: REQUEST_ID,
    fenceToken: FENCE_TOKEN,
    attemptCount: 1,
  });
}

function hash(index: number): string {
  return `0x${index.toString(16).padStart(64, "0")}`;
}
