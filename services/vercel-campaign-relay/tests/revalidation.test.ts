import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionResult, TransactionStatus } from "genlayer-js/types";
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  padHex,
  parseAbiParameters,
  stringToHex,
  type Hex,
} from "viem";
import {
  BASE_SEPOLIA_CHAIN_ID,
  STUDIONET_RESOLVER,
} from "../lib/constants";
import {
  independentlyResolveCampaign,
  type CoordinatorBaseClient,
  type CoordinatorSource,
} from "../lib/revalidation";
import { buildWatcherRequest } from "../lib/watcher-client";
import type { ResolutionContext } from "../lib/types";
import { configFixture } from "./helpers";

const config = configFixture();
const campaignId = 7n;
const assignmentId = 9n;
const round = 1n;
const brand = getAddress("0x1111111111111111111111111111111111111111");
const creator = getAddress("0x2222222222222222222222222222222222222222");
const identityHash = `0x${"33".repeat(32)}` as Hex;
const agreementHash = `0x${"44".repeat(32)}` as Hex;
const genlayerTxHash = `0x${"55".repeat(32)}` as Hex;
const evidenceHash = `0x${"66".repeat(32)}` as Hex;
const postId = "20864108500280";
const handle = "creator_x";
const submittedAt = 1_000n;
const retention = 10n;
const termsDocument = Object.freeze({
  schemaVersion: 1,
  network: "base-sepolia",
  chainId: BASE_SEPOLIA_CHAIN_ID,
  brandWallet: brand,
  requiredPhrases: ["InfluencedX"],
  forbiddenPhrases: ["scam"],
  requireAdDisclosure: true,
  semanticBrief: "Show the product honestly.",
  retentionSeconds: retention.toString(),
});
const submissionDocument = Object.freeze({
  schemaVersion: 1,
  chainId: BASE_SEPOLIA_CHAIN_ID,
  escrowContract: getAddress(config.escrow),
  assignmentId: assignmentId.toString(),
  agreementHash,
  creatorWallet: creator,
  expectedHandle: handle,
  xPostId: postId,
});
const termsHash = documentHash("campaign-terms", termsDocument);
const submissionHash = documentHash("submission-evidence", submissionDocument);
const postIdHash = keccak256(stringToHex(`x-post-id:${postId}`));
const requestId = keccak256(encodeAbiParameters(
  parseAbiParameters("uint256 chainId,address escrow,uint256 assignmentId,uint32 resolutionRound,bytes32 agreementHash,bytes32 submissionHash"),
  [BigInt(BASE_SEPOLIA_CHAIN_ID), config.escrow, assignmentId, Number(round), agreementHash, submissionHash],
));
const context: ResolutionContext = Object.freeze({
  applicationId: "11111111-1111-4111-8111-111111111111",
  campaignRecordId: "22222222-2222-4222-8222-222222222222",
  requestId,
  resolutionRound: 1,
  assignmentId: assignmentId.toString(),
  campaignId: campaignId.toString(),
  brand,
  creator,
  identityHash,
  agreementHash,
  submissionHash,
  postIdHash,
  xPostId: postId,
  expectedHandle: handle,
  termsDocument,
  genlayerTxHash,
  expectedOutcome: "PASS",
});
const request = buildWatcherRequest(context, config.escrow);

function baseFixture(overrides: { used?: boolean; assignment?: unknown[]; campaign?: unknown[] } = {}): CoordinatorBaseClient {
  const assignment = overrides.assignment ?? [campaignId, creator, identityHash, agreementHash, 1_000_000n, 900n, submittedAt, postIdHash, submissionHash, requestId, round, 250n, 4n];
  const campaign = overrides.campaign ?? [brand, termsHash, 2_000_000n, 1_000_000n, 0n, 0n, 800n, 850n, 3_000n, retention];
  return Object.freeze({
    async getChainId() { return BASE_SEPOLIA_CHAIN_ID; },
    async readContract(input: { functionName: string }) {
      if (input.functionName === "escrow") return config.escrow;
      if (input.functionName === "genlayerContract") return padHex(STUDIONET_RESOLVER, { size: 32 });
      if (input.functionName === "threshold") return 2n;
      if (input.functionName === "usedAttestations") return overrides.used ?? false;
      if (input.functionName === "paused") return false;
      if (input.functionName === "isWatcher") return true;
      if (input.functionName === "assignments") return assignment;
      if (input.functionName === "campaigns") return campaign;
      throw new Error(`unexpected ${input.functionName}`);
    },
  });
}

function sourceFixture(overrides: { receipt?: Record<string, unknown>; result?: Record<string, unknown>; args?: unknown[] } = {}): CoordinatorSource {
  const args = overrides.args ?? [requestId, handle, postId, JSON.stringify(termsDocument.requiredPhrases), JSON.stringify(termsDocument.forbiddenPhrases), true, termsDocument.semanticBrief, Number(submittedAt + retention), Number(assignmentId), agreementHash, submissionHash];
  return Object.freeze({
    receipt: {
      statusName: TransactionStatus.FINALIZED,
      txExecutionResultName: ExecutionResult.FINISHED_WITH_RETURN,
      toAddress: STUDIONET_RESOLVER,
      txDataDecoded: { callData: { method: "resolve_submission", args } },
      ...(overrides.receipt ?? {}),
    },
    result: {
      kind: "CAMPAIGN",
      request_id: requestId,
      assignment_id: Number(assignmentId),
      agreement_hash: agreementHash,
      submission_hash: submissionHash,
      handle,
      post_id: postId,
      outcome: "PASS",
      evidence_hash: evidenceHash,
      resolved_at_epoch: 1_500,
      ...(overrides.result ?? {}),
    },
  });
}

test("coordinator independently derives the same settlement from live Base and finalized StudioNet state", async () => {
  const result = await independentlyResolveCampaign({
    request,
    config,
    dependencies: { baseClient: baseFixture(), readFinalizedSource: async () => sourceFixture(), nowEpoch: () => 2_000 },
  });
  assert.equal(result.threshold, 2);
  assert.equal(result.enabledWatchers.size, 3);
  assert.equal(result.alreadyUsed, false);
  assert.equal(result.message.requestId, requestId);
  assert.equal(result.message.outcome, 1);
  assert.equal(result.message.evidenceHash, evidenceHash);
});

test("coordinator reports an already-consumed request but does not weaken any binding checks", async () => {
  const result = await independentlyResolveCampaign({
    request,
    config,
    dependencies: { baseClient: baseFixture({ used: true }), readFinalizedSource: async () => sourceFixture(), nowEpoch: () => 2_000 },
  });
  assert.equal(result.alreadyUsed, true);
});

test("coordinator rejects Base lifecycle, campaign commitment, GenLayer finality, and calldata mutations", async () => {
  const invalidAssignment = [campaignId, creator, identityHash, agreementHash, 1_000_000n, 900n, submittedAt, postIdHash, submissionHash, requestId, round, 250n, 3n];
  const invalidCampaign = [brand, `0x${"99".repeat(32)}`, 2_000_000n, 1_000_000n, 0n, 0n, 800n, 850n, 3_000n, retention];
  const goodArgs = (sourceFixture().receipt.txDataDecoded as { callData: { args: unknown[] } }).callData.args;
  const changedArgs = [...goodArgs]; changedArgs[1] = "attacker";
  const cases: Array<[CoordinatorBaseClient, CoordinatorSource, RegExp]> = [
    [baseFixture({ assignment: invalidAssignment }), sourceFixture(), /not awaiting resolution/],
    [baseFixture({ campaign: invalidCampaign }), sourceFixture(), /terms commitment/],
    [baseFixture(), sourceFixture({ receipt: { statusName: TransactionStatus.ACCEPTED } }), /not finalized successfully/],
    [baseFixture(), sourceFixture({ receipt: { toAddress: "0x017311b35dbB9802883bDaE7Fb0Efd7Bd77cB0b2" } }), /another resolver/],
    [baseFixture(), sourceFixture({ args: changedArgs }), /argument 1 mismatch/],
    [baseFixture(), sourceFixture({ result: { evidence_hash: "0x1234" } }), /result evidence is invalid/],
  ];
  for (const [baseClient, source, pattern] of cases) {
    await assert.rejects(independentlyResolveCampaign({
      request,
      config,
      dependencies: { baseClient, readFinalizedSource: async () => source, nowEpoch: () => 2_000 },
    }), pattern);
  }
});

function documentHash(kind: string, value: unknown): Hex {
  return keccak256(stringToHex(`influencedx.marketplace/v1|${kind}|${canonical(value)}`));
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
