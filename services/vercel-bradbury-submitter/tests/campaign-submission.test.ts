import assert from "node:assert/strict";
import test from "node:test";

import {
  campaignSubmissionArgs,
  submissionCallFingerprint,
  submissionFunctionName,
  validateCampaignEnvelope,
  validateQueueMessage,
} from "../lib/envelope";
import { SubmissionIngressService } from "../lib/submission-ingress";
import {
  assertResolverResult,
  SubmissionService,
  transactionBindingError,
} from "../lib/submission-service";
import {
  campaignResult,
  FakeBradburyClient,
  FakeQueue,
  finalizedCampaignReceipt,
  makeCampaignEnvelope,
  makeEnvelope,
  MemoryRepository,
  NOW_EPOCH,
  SIGNER,
  TX_HASH,
} from "./helpers";

function setup() {
  const repository = new MemoryRepository();
  const client = new FakeBradburyClient();
  const queue = new FakeQueue();
  const ingress = new SubmissionIngressService(repository, queue);
  const processor = new SubmissionService(repository, client, queue);
  return { repository, client, queue, ingress, processor };
}

function message(requestId: string) {
  return validateQueueMessage({ schemaVersion: 1, requestId });
}

test("campaign envelopes are exact, canonical, retention-ended, and resolve_submission-only", async () => {
  const envelope = makeCampaignEnvelope();
  assert.deepEqual(await validateCampaignEnvelope(envelope, { nowEpoch: NOW_EPOCH }), envelope);
  assert.equal(submissionFunctionName(envelope), "resolve_submission");
  assert.equal(campaignSubmissionArgs(envelope).length, 11);

  const invalid: unknown[] = [
    { ...envelope, extraMethod: "verify_ownership" },
    { ...envelope, kind: "OWNERSHIP" },
    { ...envelope, expectedHandle: "@Influenced_Creator" },
    { ...envelope, requiredPhrasesJson: "[\"InfluencedX\" ]" },
    { ...envelope, forbiddenPhrasesJson: "{}" },
    { ...envelope, requireAdDisclosure: 1 },
    { ...envelope, semanticBrief: " trailing " },
    { ...envelope, resolveNotBeforeEpoch: NOW_EPOCH + 1 },
    { ...envelope, assignmentId: 0 },
    { ...envelope, agreementHash: `0x${"00".repeat(31)}` },
    { ...envelope, submissionHash: `0x${"gg".repeat(32)}` },
  ];
  for (const value of invalid) {
    await assert.rejects(
      validateCampaignEnvelope(value, { nowEpoch: NOW_EPOCH }),
      (error: unknown) => (error as { code?: string }).code === "INVALID_CAMPAIGN_ENVELOPE",
    );
  }
});

test("campaign ingress is idempotent and a request ID cannot cross submission kinds", async () => {
  const { ingress, repository } = setup();
  const campaign = makeCampaignEnvelope();
  const first = await ingress.accept(campaign);
  const replay = await ingress.accept(campaign);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(repository.records.get(campaign.requestId)?.functionName, "resolve_submission");

  const ownership = makeEnvelope({ requestId: campaign.requestId });
  await assert.rejects(
    ingress.accept(ownership),
    (error: unknown) => (error as { code?: string }).code === "REQUEST_ID_COLLISION",
  );
});

test("campaign jobs use only the hard-coded campaign writer and reach bound finality", async () => {
  const { ingress, processor, repository, client, queue } = setup();
  const envelope = makeCampaignEnvelope();
  await ingress.accept(envelope);
  await processor.process(message(envelope.requestId), 1);
  assert.equal(client.submitCampaignCalls, 1);
  assert.equal(client.submitOwnershipCalls, 0);
  assert.deepEqual(queue.polls[0], { requestId: envelope.requestId, attempt: 0 });

  client.receipt = finalizedCampaignReceipt(envelope);
  client.finalResult = campaignResult(envelope, "PASS");
  await processor.process(message(envelope.requestId), 2);
  const record = repository.records.get(envelope.requestId);
  assert.equal(record?.status, "FINALIZED");
  assert.equal(record?.resultOutcome, "PASS");
});

test("durable campaign envelope tampering is poisoned before the signer is claimed", async () => {
  const { ingress, processor, repository, client } = setup();
  const envelope = makeCampaignEnvelope();
  await ingress.accept(envelope);
  const record = repository.records.get(envelope.requestId);
  assert.ok(record);
  repository.records.set(envelope.requestId, Object.freeze({
    ...record,
    envelope: Object.freeze({ ...envelope, semanticBrief: "Tampered brief." }),
  }));
  await assert.rejects(
    processor.process(message(envelope.requestId), 1),
    (error: unknown) =>
      (error as { code?: string }).code === "SUBMISSION_ENVELOPE_INTEGRITY_MISMATCH",
  );
  assert.equal(client.submitCalls, 0);
  assert.equal(repository.records.get(envelope.requestId)?.status, "POISONED");
});

test("campaign receipt binding rejects a wrong method and every mutated canonical argument", () => {
  const envelope = makeCampaignEnvelope();
  const record = {
    requestId: envelope.requestId,
    txHash: TX_HASH,
    functionName: "resolve_submission" as const,
    callFingerprint: submissionCallFingerprint(envelope),
  };
  assert.equal(transactionBindingError(finalizedCampaignReceipt(envelope), record, SIGNER), null);

  const wrongMethod = finalizedCampaignReceipt(envelope);
  (wrongMethod.txDataDecoded as { callData: { method: string } }).callData.method = "verify_ownership";
  assert.equal(transactionBindingError(wrongMethod, record, SIGNER), "TRANSACTION_METHOD_MISMATCH");

  const args = [...campaignSubmissionArgs(envelope)];
  const replacements: unknown[] = [
    `0x${"99".repeat(32)}`,
    "other_creator",
    "1234567890123456789",
    JSON.stringify(["different"]),
    JSON.stringify(["different"]),
    false,
    "Different semantic brief.",
    envelope.resolveNotBeforeEpoch - 1,
    envelope.assignmentId + 1,
    `0x${"66".repeat(32)}`,
    `0x${"77".repeat(32)}`,
  ];
  for (let index = 0; index < args.length; index += 1) {
    const mutated = [...args];
    mutated[index] = replacements[index];
    const receipt = finalizedCampaignReceipt(envelope, {
      txDataDecoded: { callData: { method: "resolve_submission", args: mutated } },
    });
    assert.equal(
      transactionBindingError(receipt, record, SIGNER),
      "TRANSACTION_ARGUMENTS_MISMATCH",
      `argument ${index} must be bound`,
    );
  }
});

test("campaign final result binds identity, post, assignment, agreement, and submission", () => {
  const envelope = makeCampaignEnvelope();
  const result = campaignResult(envelope, "FAIL");
  assert.equal(
    assertResolverResult(result, envelope.requestId, "resolve_submission", envelope),
    "FAIL",
  );
  const mutations = [
    { request_id: `0x${"98".repeat(32)}` },
    { handle: "wrong_creator" },
    { post_id: "1234567890123456789" },
    { assignment_id: envelope.assignmentId + 1 },
    { agreement_hash: `0x${"88".repeat(32)}` },
    { submission_hash: `0x${"99".repeat(32)}` },
    { outcome: "VERIFIED" },
  ];
  for (const mutation of mutations) {
    assert.throws(
      () => assertResolverResult(
        { ...result, ...mutation },
        envelope.requestId,
        "resolve_submission",
        envelope,
      ),
    );
  }
});
