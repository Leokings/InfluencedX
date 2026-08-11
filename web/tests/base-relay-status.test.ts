import assert from "node:assert/strict";
import test from "node:test";
import {
  baseRelayPresentation,
  shouldPollVerificationStatus,
} from "../lib/base-relay-status.ts";

test("keeps DB-only polling active between GenLayer verification and Base confirmation", () => {
  assert.equal(shouldPollVerificationStatus({
    submissionStatus: "FINALIZED",
    genlayerOutcome: "VERIFIED",
    baseRelayStatus: "NOT_STARTED",
  }), true);
  assert.equal(shouldPollVerificationStatus({
    submissionStatus: "FINALIZED",
    genlayerOutcome: "VERIFIED",
    baseRelayStatus: "BROADCASTING",
  }), true);
  assert.equal(shouldPollVerificationStatus({
    submissionStatus: "FINALIZED",
    genlayerOutcome: "VERIFIED",
    baseRelayStatus: "CONFIRMED",
  }), false);
});

test("does not poll Base after a non-verified or failed GenLayer terminal state", () => {
  assert.equal(shouldPollVerificationStatus({
    submissionStatus: "FINALIZED",
    genlayerOutcome: "REJECTED",
    baseRelayStatus: "NOT_STARTED",
  }), false);
  assert.equal(shouldPollVerificationStatus({
    submissionStatus: "EXECUTION_FAILED",
    genlayerOutcome: null,
    baseRelayStatus: "NOT_STARTED",
  }), false);
  assert.equal(shouldPollVerificationStatus({
    submissionStatus: "POLLING",
    genlayerOutcome: null,
    baseRelayStatus: "NOT_STARTED",
  }), true);
});

test("presents Base verification only for a current active registry profile", () => {
  const current = baseRelayPresentation({
    status: "CONFIRMED",
    genlayerVerified: true,
    profileId: "7",
    profileActive: true,
    profileVerified: true,
    profileExpiresAt: "2026-08-20T00:00:00.000Z",
    nowMs: Date.parse("2026-08-09T00:00:00.000Z"),
  });
  assert.deepEqual(current, {
    currentProfile: true,
    needsReview: false,
    boardState: "complete",
    detail: "PROFILE #7",
  });

  const expired = baseRelayPresentation({
    status: "CONFIRMED",
    genlayerVerified: true,
    profileId: "7",
    profileActive: true,
    profileVerified: true,
    profileExpiresAt: "2026-08-08T00:00:00.000Z",
    nowMs: Date.parse("2026-08-09T00:00:00.000Z"),
  });
  assert.equal(expired.currentProfile, false);
  assert.equal(expired.needsReview, true);
  assert.equal(expired.boardState, "error");
  assert.equal(expired.detail, "PROFILE INACTIVE OR EXPIRED");
});

test("keeps watcher and broadcast phases visibly pending", () => {
  const quorum = baseRelayPresentation({
    status: "QUORUM_PENDING",
    genlayerVerified: true,
    profileId: null,
    profileActive: null,
    profileVerified: null,
    profileExpiresAt: null,
  });
  assert.equal(quorum.boardState, "pending");
  assert.equal(quorum.detail, "WATCHER QUORUM PENDING");

  const broadcasting = baseRelayPresentation({
    status: "BROADCASTING",
    genlayerVerified: true,
    profileId: null,
    profileActive: null,
    profileVerified: null,
    profileExpiresAt: null,
  });
  assert.equal(broadcasting.boardState, "pending");
  assert.equal(broadcasting.detail, "TRANSACTION PENDING");
});
