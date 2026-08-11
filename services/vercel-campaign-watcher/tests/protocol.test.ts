import assert from "node:assert/strict";
import test from "node:test";
import { getAddress, recoverTypedDataAddress } from "viem";
import { TransactionStatus } from "genlayer-js/types";
import { campaignResolutionTypes } from "../lib/constants";
import {
  parseCampaignSignatureRequest,
  signVerifiedCampaignResolution,
} from "../lib/protocol";
import {
  agreementHash,
  assignmentFixture,
  assignmentId,
  baseClientFixture,
  campaignFixture,
  configFixture,
  creator,
  evidenceHash,
  requestFixture,
  requestId,
  sourceFixture,
  submissionHash,
  termsHash,
  watcherAddress,
} from "./helpers";

test("one watcher independently verifies Base and finalized Bradbury state before signing", async () => {
  const result = await signVerifiedCampaignResolution(requestFixture(), configFixture(), {
    baseClient: baseClientFixture(),
    readFinalizedSource: async () => sourceFixture(),
    nowEpoch: () => 2_000,
  });
  assert.equal(result.signer, getAddress(watcherAddress));
  assert.equal(result.requestId, requestId);
  assert.equal(result.message.assignmentId, assignmentId.toString());
  assert.equal(result.message.outcome, 1);
  assert.equal(result.message.evidenceHash, evidenceHash);
  const recovered = await recoverTypedDataAddress({
    domain: {
      name: "XProofAttestationReceiver",
      version: "2",
      chainId: 84_532,
      verifyingContract: configFixture().receiver,
    },
    types: campaignResolutionTypes,
    primaryType: "CampaignResolution",
    message: {
      ...result.message,
      assignmentId: BigInt(result.message.assignmentId),
      resolvedAt: BigInt(result.message.resolvedAt),
      relayDeadline: BigInt(result.message.relayDeadline),
    },
    signature: result.signature,
  });
  assert.equal(getAddress(recovered), getAddress(watcherAddress));
});

test("request parser is exact and does not accept coordinator-injected fields", () => {
  assert.deepEqual(parseCampaignSignatureRequest(requestFixture()), requestFixture());
  assert.throws(() => parseCampaignSignatureRequest({ ...requestFixture(), outcome: "PASS" }), /unexpected fields/);
  assert.throws(() => parseCampaignSignatureRequest({ ...requestFixture(), binding: { ...requestFixture().binding, privateKey: "x" } }), /unexpected fields/);
});

test("watcher rejects every mutable Base assignment commitment and lifecycle mismatch", async () => {
  const cases: Array<[Record<number, unknown>, RegExp]> = [
    [{ 0: 8n }, /campaign mismatch/],
    [{ 1: "0x3333333333333333333333333333333333333333" }, /creator mismatch/],
    [{ 2: `0x${"aa".repeat(32)}` }, /identity mismatch/],
    [{ 3: `0x${"aa".repeat(32)}` }, /agreement mismatch/],
    [{ 6: 0n }, /no submitted evidence/],
    [{ 7: `0x${"aa".repeat(32)}` }, /post mismatch/],
    [{ 8: `0x${"aa".repeat(32)}` }, /submission mismatch/],
    [{ 9: `0x${"aa".repeat(32)}` }, /request mismatch/],
    [{ 10: 2n }, /escrow formula/],
    [{ 12: 3n }, /not awaiting resolution/],
  ];
  for (const [mutation, pattern] of cases) {
    await assert.rejects(signVerifiedCampaignResolution(requestFixture(), configFixture(), {
      baseClient: baseClientFixture({ assignment: assignmentFixture(mutation) }),
      readFinalizedSource: async () => sourceFixture(),
      nowEpoch: () => 2_000,
    }), pattern);
  }
});

test("watcher rejects receiver configuration, replay, and campaign terms divergence", async () => {
  const cases: Array<[Parameters<typeof baseClientFixture>[0], RegExp]> = [
    [{ chainId: 1 }, /not Base Sepolia/],
    [{ wiredEscrow: "0x3333333333333333333333333333333333333333" }, /another escrow/],
    [{ wiredResolver: `0x${"aa".repeat(32)}` }, /another GenLayer resolver/],
    [{ threshold: 1n }, /threshold is unsafe/],
    [{ enabled: false }, /not enabled/],
    [{ used: true }, /already relayed/],
    [{ paused: true }, /paused/],
    [{ campaign: campaignFixture({ 0: creator }) }, /brand mismatch/],
    [{ campaign: campaignFixture({ 1: `0x${"aa".repeat(32)}` }) }, /terms document/],
    [{ campaign: campaignFixture({ 9: 11n }) }, /retention commitment/],
  ];
  for (const [mutation, pattern] of cases) {
    await assert.rejects(signVerifiedCampaignResolution(requestFixture(), configFixture(), {
      baseClient: baseClientFixture(mutation),
      readFinalizedSource: async () => sourceFixture(),
      nowEpoch: () => 2_000,
    }), pattern);
  }
  assert.notEqual(termsHash, agreementHash);
  assert.notEqual(submissionHash, agreementHash);
});

test("watcher rejects non-final, wrong-call, divergent-result, and stale GenLayer sources", async () => {
  const cases: Array<[ReturnType<typeof sourceFixture>, number, RegExp]> = [
    [sourceFixture({ receipt: { statusName: TransactionStatus.ACCEPTED } }), 2_000, /not finalized/],
    [sourceFixture({ receipt: { toAddress: creator } }), 2_000, /another resolver/],
    [sourceFixture({ receipt: { txDataDecoded: { callData: { method: "verify_ownership", args: [] } } } }), 2_000, /method or arguments/],
    [sourceFixture({ args: [requestId, "wrong", ...sourceFixture().receipt.txDataDecoded ? [] : []] }), 2_000, /method or arguments|argument/],
    [sourceFixture({ result: { request_id: `0x${"aa".repeat(32)}` } }), 2_000, /another campaign request/],
    [sourceFixture({ result: { agreement_hash: `0x${"aa".repeat(32)}` } }), 2_000, /agreement mismatch/],
    [sourceFixture({ result: { submission_hash: `0x${"aa".repeat(32)}` } }), 2_000, /submission mismatch/],
    [sourceFixture({ result: { outcome: "MAYBE" } }), 2_000, /outcome is invalid/],
    [sourceFixture({ result: { resolved_at_epoch: 1_005 } }), 2_000, /predates campaign retention/],
    [sourceFixture({ result: { resolved_at_epoch: 2_301 } }), 2_000, /in the future/],
    [sourceFixture({ result: { resolved_at_epoch: 1_500 } }), 1_500 + 7 * 24 * 60 * 60 + 1, /deadline has expired/],
  ];
  for (const [source, nowEpoch, pattern] of cases) {
    await assert.rejects(signVerifiedCampaignResolution(requestFixture(), configFixture(), {
      baseClient: baseClientFixture(),
      readFinalizedSource: async () => source,
      nowEpoch: () => nowEpoch,
    }), pattern);
  }
});
