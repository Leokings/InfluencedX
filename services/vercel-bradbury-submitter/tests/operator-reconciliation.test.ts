import assert from "node:assert/strict";
import test from "node:test";

import { submissionCallFingerprint } from "../lib/envelope";
import {
  inspectLegacyValueOmission,
  LEGACY_VALUE_OMISSION_ERROR,
} from "../lib/operator-reconciliation";
import type { BradburyReader, SubmissionRecord } from "../lib/types";
import {
  finalizedReceipt,
  makeEnvelope,
  ownershipResult,
  SIGNER,
  TX_HASH,
} from "./helpers";

function fixture() {
  const envelope = makeEnvelope();
  const now = new Date();
  const record: SubmissionRecord = Object.freeze({
    requestId: envelope.requestId,
    envelope: null,
    functionName: "verify_ownership",
    envelopeFingerprint: "f".repeat(64),
    callFingerprint: submissionCallFingerprint(envelope),
    status: "RECONCILIATION_REQUIRED",
    lifecycleStatus: null,
    executionResult: null,
    resultOutcome: null,
    resultData: null,
    txHash: TX_HASH,
    queueMessageId: "message-1",
    enqueueAttempts: 1,
    deliveryCount: 1,
    pollAttempts: 1,
    errorCode: LEGACY_VALUE_OMISSION_ERROR,
    broadcastStartedAt: now,
    submittedAt: now,
    lastPolledAt: now,
    finalizedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const receipt = finalizedReceipt(envelope);
  delete receipt.value;
  const reader: BradburyReader = {
    signerAddress: SIGNER,
    async getTransaction() { return receipt; },
    async readFinalResult() { return ownershipResult(envelope.requestId, "VERIFIED"); },
  };
  return { envelope, record, receipt, reader };
}

test("legacy value omission reconciliation accepts the exact value-less finalized Bradbury receipt", async () => {
  const { record, reader } = fixture();
  const observed = await inspectLegacyValueOmission(record, reader);
  assert.equal(observed.state, "FINALIZED");
  assert.equal(observed.resultOutcome, "VERIFIED");
  assert.equal(observed.submission.txHash, TX_HASH);
});

test("legacy reconciliation remains read-only while exact transaction finality is pending", async () => {
  const { record, receipt, reader } = fixture();
  receipt.statusName = "ACCEPTED";
  const observed = await inspectLegacyValueOmission(record, reader);
  assert.equal(observed.state, "PENDING");
  assert.equal(observed.resultOutcome, null);
});

test("legacy reconciliation refuses unrelated quarantines and mismatched calls", async () => {
  const { record, receipt, reader } = fixture();
  await assert.rejects(
    inspectLegacyValueOmission({ ...record, errorCode: "OTHER" }, reader),
    (error: unknown) => (error as { code?: string }).code === "LEGACY_RECONCILIATION_NOT_APPLICABLE",
  );
  receipt.txDataDecoded = { callData: { method: "other", args: [] } };
  await assert.rejects(
    inspectLegacyValueOmission(record, reader),
    (error: unknown) => (error as { code?: string }).code === "RECONCILIATION_BINDING_FAILED",
  );
});

test("legacy reconciliation does not terminalize an unknown finalized execution result", async () => {
  const { record, receipt, reader } = fixture();
  receipt.txExecutionResultName = undefined;
  await assert.rejects(
    inspectLegacyValueOmission(record, reader),
    (error: unknown) => (error as { code?: string }).code === "RECONCILIATION_EXECUTION_RESULT_UNKNOWN",
  );
});
