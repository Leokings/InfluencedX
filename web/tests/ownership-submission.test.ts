import assert from "node:assert/strict";
import test from "node:test";
import type { Address } from "viem";
import {
  buildOwnershipSubmissionEnvelope,
  ownershipSubmissionRequestId,
  parseSubmitterSubmission,
} from "../lib/ownership-submission.ts";

function envelopeFixture() {
  const unsigned = {
    baseWallet: "0x1212121212121212121212121212121212121212" as Address,
    expectedHandle: "creator_name",
    postId: "2109876543210987654",
    challenge: `APV2-${"b".repeat(24)}`,
    issuedAtEpoch: 1_786_233_540,
    expiresAtEpoch: 1_786_234_440,
    credentialExpiresAtEpoch: 1_788_825_540,
  };
  return buildOwnershipSubmissionEnvelope({
    ...unsigned,
    requestId: ownershipSubmissionRequestId(unsigned),
  });
}

test("the web envelope recomputes and pins the APV2 request ID", () => {
  const envelope = envelopeFixture();
  assert.match(envelope.requestId, /^0x[0-9a-f]{64}$/);
  assert.throws(
    () => buildOwnershipSubmissionEnvelope({ ...envelope, challenge: `APV2-${"c".repeat(24)}` }),
    /does not bind/,
  );
});

test("submitter responses accept only the bounded ownership lifecycle", () => {
  const envelope = envelopeFixture();
  const response = {
    requestId: envelope.requestId,
    status: "QUEUED",
    lifecycleStatus: "PENDING",
    executionResult: null,
    resultOutcome: null,
    txHash: `0x${"ab".repeat(32)}`,
    queueMessageId: "queue-message-1",
    enqueueAttempts: 1,
    deliveryCount: 0,
    pollAttempts: 0,
    errorCode: null,
    broadcastStartedAt: null,
    submittedAt: new Date(1_786_233_600_000).toISOString(),
    lastPolledAt: null,
    finalizedAt: null,
    createdAt: new Date(1_786_233_600_000).toISOString(),
    updatedAt: new Date(1_786_233_600_000).toISOString(),
  };
  assert.equal(parseSubmitterSubmission(response).requestId, envelope.requestId);
  assert.throws(
    () => parseSubmitterSubmission({ ...response, status: "ARBITRARY_CALL" }),
    /status is invalid/,
  );
});

test("finalized lifecycle is not accepted without a resolver outcome", () => {
  const envelope = envelopeFixture();
  assert.throws(
    () => parseSubmitterSubmission({
      requestId: envelope.requestId,
      status: "FINALIZED",
      lifecycleStatus: "FINALIZED",
      executionResult: "FINISHED_WITH_RETURN",
      resultOutcome: null,
      txHash: `0x${"ab".repeat(32)}`,
      queueMessageId: "queue-message-1",
      enqueueAttempts: 1,
      deliveryCount: 1,
      pollAttempts: 2,
      errorCode: null,
      broadcastStartedAt: new Date(1_786_233_610_000).toISOString(),
      submittedAt: new Date(1_786_233_600_000).toISOString(),
      lastPolledAt: new Date(1_786_233_700_000).toISOString(),
      finalizedAt: new Date(1_786_233_700_000).toISOString(),
      createdAt: new Date(1_786_233_600_000).toISOString(),
      updatedAt: new Date(1_786_233_700_000).toISOString(),
    }),
    /no resolver outcome/,
  );
});
