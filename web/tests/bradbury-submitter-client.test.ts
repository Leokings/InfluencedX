import assert from "node:assert/strict";
import test from "node:test";
import type { Address } from "viem";
import {
  createBradburySubmitterClient,
  type BradburySubmitterConfig,
} from "../lib/bradbury-submitter-client.ts";
import {
  buildOwnershipSubmissionEnvelope,
  ownershipSubmissionRequestId,
} from "../lib/ownership-submission.ts";
import {
  buildCampaignSubmissionEnvelope,
  parseCampaignSubmitterSubmission,
} from "../lib/campaign-submission.ts";
import {
  BASE_SEPOLIA_CHAIN_ID,
  deriveCampaignResolutionRequestId,
  INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT,
} from "../lib/marketplace-chain.ts";
import {
  readVerifiedMarketplaceCampaignBinding,
  type MarketplaceCampaignBindingClient,
} from "../lib/marketplace-resolution-binding.ts";
import {
  buildMetricsSubmissionEnvelope,
  parseMetricsSubmitterSubmission,
} from "../lib/metrics-submission.ts";
import {
  readVerifiedMetricsProfileBinding,
  type MarketplaceMetricsBindingClient,
} from "../lib/marketplace-metrics-binding.ts";
import {
  assertVerifiedMetricsFinality,
  metricsEnvelopeCandidates,
  metricsEvidenceHash,
} from "../lib/marketplace-metrics-service.ts";
import { estimateMarketplaceCreatorPay } from "../lib/marketplace-pay-estimate.ts";
import type {
  CreatorProfileRow,
  MarketplaceResolutionContext,
} from "../lib/marketplace-repository.ts";

function envelopeFixture() {
  const unsigned = {
    baseWallet: "0x1212121212121212121212121212121212121212" as Address,
    expectedHandle: "creator_name",
    postId: "2109876543210987654",
    challenge: `APV2-${"d".repeat(24)}`,
    issuedAtEpoch: 1_786_233_540,
    expiresAtEpoch: 1_786_234_440,
    credentialExpiresAtEpoch: 1_788_825_540,
  };
  return buildOwnershipSubmissionEnvelope({
    ...unsigned,
    requestId: ownershipSubmissionRequestId(unsigned),
  });
}

function projection(requestId: string) {
  return {
    requestId,
    status: "QUEUED",
    lifecycleStatus: null,
    executionResult: null,
    resultOutcome: null,
    txHash: null,
    queueMessageId: "queue-1",
    enqueueAttempts: 1,
    deliveryCount: 0,
    pollAttempts: 0,
    errorCode: null,
    broadcastStartedAt: null,
    submittedAt: null,
    lastPolledAt: null,
    finalizedAt: null,
    createdAt: new Date(1_786_233_600_000).toISOString(),
    updatedAt: new Date(1_786_233_600_000).toISOString(),
  };
}

function campaignEnvelopeFixture() {
  return buildCampaignSubmissionEnvelope({
    requestId: `0x${"31".repeat(32)}`,
    expectedHandle: "influencedx",
    postId: "2109876543210987654",
    requiredPhrases: ["InfluencedX"],
    forbiddenPhrases: ["competitor"],
    requireAdDisclosure: true,
    semanticBrief: "Show one concrete product benefit.",
    resolveNotBeforeEpoch: 1_786_233_500,
    assignmentId: "7",
    agreementHash: `0x${"44".repeat(32)}`,
    submissionHash: `0x${"55".repeat(32)}`,
    nowEpoch: 1_786_233_600,
  });
}

function campaignProjection(requestId: string) {
  return {
    ...projection(requestId),
    functionName: "resolve_submission",
  };
}

const METRICS_NOW = 1_786_233_600;

function metricsEnvelopeFixture() {
  return buildMetricsSubmissionEnvelope({
    baseWallet: "0x1212121212121212121212121212121212121212",
    identityHash: `0x${"63".repeat(32)}`,
    expectedHandle: "influencedx",
    metricsExpiresAtEpoch: METRICS_NOW + 5 * 24 * 60 * 60,
    nowEpoch: METRICS_NOW,
  });
}

function metricsResultFixture(envelope = metricsEnvelopeFixture()) {
  return {
    kind: "METRICS" as const,
    request_id: envelope.requestId,
    base_wallet: envelope.baseWallet,
    identity_hash: envelope.identityHash,
    handle: envelope.expectedHandle,
    x_user_id: "123456789",
    outcome: "VERIFIED" as const,
    identity_match: true as const,
    protected: false as const,
    http_status: 200,
    measured_at_epoch: METRICS_NOW - 60,
    metrics_expires_at_epoch: envelope.metricsExpiresAtEpoch,
    account_created_at_ms: 1_650_000_000_000,
    followers: 25_000,
    following: 300,
    total_posts: 1_250,
    posts_analyzed: 12,
    median_likes: 400,
    median_replies: 20,
    median_reposts: 30,
    median_views: 9_000,
    engagement_rate_bps: 180,
    engagement_consistency: "LOW_RISK" as const,
  };
}

function metricsProjection(
  envelope = metricsEnvelopeFixture(),
  finalized = false,
) {
  return {
    ...projection(envelope.requestId),
    functionName: "snapshot_metrics" as const,
    status: finalized ? ("FINALIZED" as const) : ("QUEUED" as const),
    resultOutcome: finalized ? ("VERIFIED" as const) : null,
    resultData: finalized ? metricsResultFixture(envelope) : null,
    txHash: finalized ? `0x${"92".repeat(32)}` : null,
    finalizedAt: finalized
      ? new Date(METRICS_NOW * 1_000).toISOString()
      : null,
  };
}

test("submit uses only Vercel OIDC and the exact APV2 endpoint/body", async () => {
  const envelope = envelopeFixture();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(
      { replayed: false, submission: projection(envelope.requestId) },
      { status: 202 },
    );
  };
  const config: BradburySubmitterConfig = {
    origin: "https://xproof-submitter.example",
    vercelOidcToken: "header.payload.signature",
  };
  const result = await createBradburySubmitterClient(config, fakeFetch).submit(envelope);
  assert.equal(result.submission.status, "QUEUED");
  assert.equal(calls[0].url, "https://xproof-submitter.example/api/v1/ownership-submissions");
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(headers.get("authorization"), "Bearer header.payload.signature");
  assert.equal(
    headers.get("x-vercel-trusted-oidc-idp-token"),
    "header.payload.signature",
  );
  assert.equal(headers.get("x-xproof-service-token"), null);
  assert.deepEqual(Object.keys(JSON.parse(String(calls[0].init?.body))).sort(), [
    "baseWallet",
    "challenge",
    "credentialExpiresAtEpoch",
    "expectedHandle",
    "expiresAtEpoch",
    "issuedAtEpoch",
    "postId",
    "requestId",
    "schemaVersion",
  ]);
});

test("status uses the idempotent request-ID endpoint", async () => {
  const envelope = envelopeFixture();
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    calls.push(String(input));
    return Response.json({ submission: projection(envelope.requestId) });
  };
  const client = createBradburySubmitterClient(
    {
      origin: "https://xproof-submitter.example",
      vercelOidcToken: "header.payload.signature",
    },
    fakeFetch,
  );
  assert.equal((await client.status(envelope.requestId))?.requestId, envelope.requestId);
  assert.equal(
    calls[0],
    `https://xproof-submitter.example/api/v1/ownership-submissions/${envelope.requestId}`,
  );
});

test("campaign submission uses the dedicated method-free endpoint and exact envelope", async () => {
  const envelope = campaignEnvelopeFixture();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(
      { replayed: false, submission: campaignProjection(envelope.requestId) },
      { status: 202 },
    );
  };
  const client = createBradburySubmitterClient(
    {
      origin: "https://xproof-submitter.example",
      vercelOidcToken: "header.payload.signature",
    },
    fakeFetch,
  );
  const accepted = await client.submitCampaign(envelope);
  assert.equal(accepted.submission.functionName, "resolve_submission");
  assert.equal(
    calls[0].url,
    "https://xproof-submitter.example/api/v1/campaign-submissions",
  );
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.method, undefined);
  assert.deepEqual(Object.keys(body).sort(), [
    "agreementHash",
    "assignmentId",
    "expectedHandle",
    "forbiddenPhrasesJson",
    "kind",
    "postId",
    "requestId",
    "requireAdDisclosure",
    "requiredPhrasesJson",
    "resolveNotBeforeEpoch",
    "schemaVersion",
    "semanticBrief",
    "submissionHash",
  ]);
});

test("campaign status is isolated from ownership responses and invalid outcomes", async () => {
  const envelope = campaignEnvelopeFixture();
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    calls.push(String(input));
    return Response.json({ submission: campaignProjection(envelope.requestId) });
  };
  const client = createBradburySubmitterClient(
    {
      origin: "https://xproof-submitter.example",
      vercelOidcToken: "header.payload.signature",
    },
    fakeFetch,
  );
  assert.equal(
    (await client.campaignStatus(envelope.requestId))?.requestId,
    envelope.requestId,
  );
  assert.equal(
    calls[0],
    `https://xproof-submitter.example/api/v1/campaign-submissions/${envelope.requestId}`,
  );
  assert.throws(() => parseCampaignSubmitterSubmission({
    ...campaignProjection(envelope.requestId),
    functionName: "verify_ownership",
  }));
  assert.throws(() => parseCampaignSubmitterSubmission({
    ...campaignProjection(envelope.requestId),
    resultOutcome: "VERIFIED",
  }));
});

test("metrics submission uses a dedicated endpoint and cannot carry caller counts", async () => {
  const envelope = metricsEnvelopeFixture();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(
      { replayed: false, submission: metricsProjection(envelope) },
      { status: 202 },
    );
  };
  const client = createBradburySubmitterClient(
    {
      origin: "https://xproof-submitter.example",
      vercelOidcToken: "header.payload.signature",
    },
    fakeFetch,
  );
  const accepted = await client.submitMetrics(envelope);
  assert.equal(accepted.submission.functionName, "snapshot_metrics");
  assert.equal(
    calls[0].url,
    "https://xproof-submitter.example/api/v1/metrics-submissions",
  );
  const body = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(Object.keys(body).sort(), [
    "baseWallet",
    "expectedHandle",
    "identityHash",
    "kind",
    "metricsExpiresAtEpoch",
    "requestId",
    "schemaVersion",
  ]);
  assert.equal(body.followers, undefined);
  assert.equal(body.engagementRateBps, undefined);
  assert.equal(body.estimatedPay, undefined);
});

test("metrics projection and finality reject tampered profile/result bindings", () => {
  const envelope = metricsEnvelopeFixture();
  const parsed = parseMetricsSubmitterSubmission(metricsProjection(envelope, true));
  const binding = {
    wallet: envelope.baseWallet as `0x${string}`,
    identityHash: envelope.identityHash,
    expectedHandle: envelope.expectedHandle,
    credentialExpiresAtEpoch: envelope.metricsExpiresAtEpoch + 60,
  } as const;
  assert.deepEqual(
    assertVerifiedMetricsFinality({
      envelope,
      binding,
      submission: parsed,
      nowEpoch: METRICS_NOW,
    }),
    metricsResultFixture(envelope),
  );
  for (const mutation of [
    { request_id: `0x${"44".repeat(32)}` },
    { base_wallet: "0x3434343434343434343434343434343434343434" },
    { identity_hash: `0x${"45".repeat(32)}` },
    { handle: "another" },
    { measured_at_epoch: METRICS_NOW + 301 },
    { measured_at_epoch: METRICS_NOW - 86_401 },
    { metrics_expires_at_epoch: METRICS_NOW },
    {
      median_likes: Number.MAX_SAFE_INTEGER,
      median_replies: 1,
      median_reposts: 0,
    },
  ]) {
    assert.throws(() => {
      const tampered = parseMetricsSubmitterSubmission({
        ...metricsProjection(envelope, true),
        resultData: { ...metricsResultFixture(envelope), ...mutation },
      });
      assertVerifiedMetricsFinality({
        envelope,
        binding,
        submission: tampered,
        nowEpoch: METRICS_NOW,
      });
    });
  }
});

test("metrics jobs are deterministic within a slot and bounded by credential expiry", () => {
  const envelope = metricsEnvelopeFixture();
  const binding = {
    wallet: envelope.baseWallet as `0x${string}`,
    identityHash: envelope.identityHash,
    expectedHandle: envelope.expectedHandle,
    credentialExpiresAtEpoch: METRICS_NOW + 30 * 24 * 60 * 60,
  } as const;
  const first = metricsEnvelopeCandidates(binding, METRICS_NOW + 30);
  const retry = metricsEnvelopeCandidates(binding, METRICS_NOW + 300);
  assert.equal(first.length, 2);
  assert.equal(first[0].requestId, retry[0].requestId);
  assert.ok(first[0].metricsExpiresAtEpoch <= METRICS_NOW + 6 * 24 * 60 * 60);

  const expiring = metricsEnvelopeCandidates(
    {
      ...binding,
      credentialExpiresAtEpoch:
        METRICS_NOW + 20 * 60,
    },
    METRICS_NOW,
  );
  assert.equal(expiring.length, 0);
});

test("metrics evidence and pay estimates are deterministic and result-derived", () => {
  const result = metricsResultFixture();
  const hash = metricsEvidenceHash(result);
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.equal(metricsEvidenceHash({ ...result }), hash);
  assert.notEqual(metricsEvidenceHash({ ...result, followers: result.followers + 1 }), hash);
  const estimate = estimateMarketplaceCreatorPay({
    metrics: result,
    contentType: "text",
    nowEpoch: result.measured_at_epoch,
  });
  assert.ok(estimate.minimumUsdc < estimate.targetUsdc);
  assert.ok(estimate.targetUsdc < estimate.maximumUsdc);
  assert.equal(estimate.confidence, "HIGH");
});

test("metrics Base binding rejects stale DB or deactivated registry profiles", async () => {
  const wallet = "0x1212121212121212121212121212121212121212";
  const identityHash = `0x${"63".repeat(32)}`;
  const handleHash = `0x${"64".repeat(32)}`;
  const postHash = `0x${"65".repeat(32)}`;
  const expiresAt = METRICS_NOW + 7 * 24 * 60 * 60;
  const profile = {
    id: "11111111-1111-4111-8111-111111111111",
    ownerWallet: wallet,
    baseProfileId: "7",
    identityHash,
    handleHash,
    verificationPostHash: postHash,
    publicHandle: "influencedx",
    active: true,
    credentialExpiresAt: expiresAt * 1_000,
  } as unknown as CreatorProfileRow;
  const tuple = [
    7n,
    wallet,
    identityHash,
    handleHash,
    postHash,
    `0x${"00".repeat(32)}`,
    BigInt(METRICS_NOW - 10_000),
    BigInt(expiresAt),
    0n,
    0n,
    true,
  ] as const;
  const client = metricsBindingClient(tuple);
  const binding = await readVerifiedMetricsProfileBinding({
    profile,
    nowEpoch: METRICS_NOW,
    client,
  });
  assert.equal(binding.wallet, wallet);
  assert.equal(binding.expectedHandle, "influencedx");
  for (const badTuple of [
    [...tuple.slice(0, 2), `0x${"99".repeat(32)}`, ...tuple.slice(3)],
    [...tuple.slice(0, 10), false],
    [...tuple.slice(0, 7), BigInt(expiresAt + 1), ...tuple.slice(8)],
  ]) {
    await assert.rejects(readVerifiedMetricsProfileBinding({
      profile,
      nowEpoch: METRICS_NOW,
      client: metricsBindingClient(badTuple),
    }));
  }
});

test("campaign envelope fails closed on uncommitted or noncanonical criteria", () => {
  const envelope = campaignEnvelopeFixture();
  const base = {
    ...envelope,
    requiredPhrases: JSON.parse(envelope.requiredPhrasesJson),
    forbiddenPhrases: JSON.parse(envelope.forbiddenPhrasesJson),
    nowEpoch: 1_786_233_600,
  };
  for (const mutation of [
    { expectedHandle: "@InfluencedX" },
    { requiredPhrases: [" InfluencedX"] },
    { forbiddenPhrases: new Array(21).fill("phrase") },
    { requireAdDisclosure: "true" },
    { semanticBrief: " trailing " },
    { resolveNotBeforeEpoch: 1_786_233_601 },
    { assignmentId: "9007199254740992" },
  ]) {
    assert.throws(() => buildCampaignSubmissionEnvelope({ ...base, ...mutation }));
  }
});

test("campaign bridge binding re-reads every Base commitment and derives retention onchain", async () => {
  const assignmentId = 7n;
  const campaignId = 3n;
  const round = 1n;
  const agreementHash = `0x${"44".repeat(32)}`;
  const submissionHash = `0x${"55".repeat(32)}`;
  const identityHash = `0x${"66".repeat(32)}`;
  const postIdHash = `0x${"77".repeat(32)}`;
  const termsHash = `0x${"88".repeat(32)}`;
  const requestId = deriveCampaignResolutionRequestId({
    chainId: BASE_SEPOLIA_CHAIN_ID,
    assignmentId,
    resolutionRound: round,
    agreementHash,
    submissionHash,
  });
  const brand = "0x1212121212121212121212121212121212121212";
  const creator = "0x3434343434343434343434343434343434343434";
  const submittedAt = 1_786_229_000n;
  const retentionSeconds = 3_600n;
  const assignment = [
    campaignId,
    creator,
    identityHash,
    agreementHash,
    1_000_000n,
    submittedAt - 60n,
    submittedAt,
    postIdHash,
    submissionHash,
    requestId,
    round,
    250,
    4,
  ] as const;
  const campaign = [
    brand,
    termsHash,
    2_000_000n,
    1_000_000n,
    0n,
    0n,
    1_786_220_000n,
    1_786_221_000n,
    1_786_222_000n,
    retentionSeconds,
  ] as const;
  const context = {
    campaign: {
      id: "11111111-1111-4111-8111-111111111111",
      chainId: BASE_SEPOLIA_CHAIN_ID,
      escrowContract: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow.toLowerCase(),
      escrowCampaignId: campaignId.toString(),
      brandWallet: brand,
      termsHash,
      retentionSeconds: Number(retentionSeconds),
      requiredPhrases: ["InfluencedX"],
      forbiddenPhrases: ["competitor"],
      requireAdDisclosure: true,
      semanticBrief: "Show one concrete product benefit.",
      status: "RESOLVING",
    },
    application: {
      id: "22222222-2222-4222-8222-222222222222",
      campaignId: "11111111-1111-4111-8111-111111111111",
      status: "ACCEPTED",
      escrowAssignmentId: assignmentId.toString(),
      creatorWallet: creator,
      creatorHandle: "influencedx",
      xPostId: "2109876543210987654",
      identityHash,
      agreementHash,
      postIdHash,
      submissionHash,
      requestId,
      resolutionRound: Number(round),
      resolutionRequestTxHash: `0x${"99".repeat(32)}`,
      submissionTxHash: `0x${"aa".repeat(32)}`,
    },
  } as unknown as MarketplaceResolutionContext;
  const client = bindingClient({ assignment, campaign });
  const verified = await readVerifiedMarketplaceCampaignBinding({
    context,
    nowEpoch: 1_786_233_600,
    client,
  });
  assert.equal(
    verified.resolveNotBeforeEpoch,
    Number(submittedAt + retentionSeconds),
  );
  assert.equal(verified.requestId, requestId);
  assert.equal(verified.assignmentId, "7");

  for (const mutatedClient of [
    bindingClient({ receiverEscrow: "0x5656565656565656565656565656565656565656", assignment, campaign }),
    bindingClient({ assignment: [...assignment.slice(0, 3), `0x${"ab".repeat(32)}`, ...assignment.slice(4)], campaign }),
    bindingClient({ assignment: [...assignment.slice(0, 12), 3], campaign }),
    bindingClient({ assignment, campaign: [campaign[0], `0x${"bc".repeat(32)}`, ...campaign.slice(2)] }),
  ]) {
    await assert.rejects(readVerifiedMarketplaceCampaignBinding({
      context,
      nowEpoch: 1_786_233_600,
      client: mutatedClient,
    }));
  }
});

function bindingClient(input: {
  receiverEscrow?: string;
  assignment: readonly unknown[];
  campaign: readonly unknown[];
}): MarketplaceCampaignBindingClient {
  return {
    async getChainId() { return BASE_SEPOLIA_CHAIN_ID; },
    async readContract(call) {
      if (call.functionName === "escrow") {
        return input.receiverEscrow ?? INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.escrow;
      }
      if (call.functionName === "assignments") return input.assignment;
      if (call.functionName === "campaigns") return input.campaign;
      throw new Error("Unexpected Base read.");
    },
  };
}

function metricsBindingClient(
  profile: readonly unknown[],
): MarketplaceMetricsBindingClient {
  return {
    async getChainId() {
      return BASE_SEPOLIA_CHAIN_ID;
    },
    async readContract(call) {
      assert.equal(call.functionName, "getProfile");
      assert.equal(
        call.address,
        INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.registry,
      );
      return profile;
    },
  };
}
