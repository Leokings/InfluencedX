import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { validateOperationRequest } from "../lib/envelope";
import { assertPostState, assertPreState } from "../lib/state";
import {
  expireEnvelope,
  expirePostState,
  expirePreState,
  finalizeEnvelope,
  finalizePostState,
  finalizePreState,
  NOW_EPOCH,
  resolveEnvelope,
  resolvePassState,
  resolvePreState,
  configFixture,
} from "./helpers";

test("resolve, expire, and finalize preconditions are re-read and validated", () => {
  assert.doesNotThrow(() => assertPreState(resolveEnvelope(), resolvePreState(), NOW_EPOCH));
  assert.doesNotThrow(() => assertPreState(expireEnvelope(), expirePreState(), NOW_EPOCH));
  assert.doesNotThrow(() => assertPreState(finalizeEnvelope(), finalizePreState(), NOW_EPOCH));
});

test("resolve, expire, and finalize post-state accounting is exact", () => {
  assert.doesNotThrow(() => assertPostState(resolveEnvelope(), resolvePreState(), resolvePassState()));
  assert.doesNotThrow(() => assertPostState(expireEnvelope(), expirePreState(), expirePostState()));
  assert.doesNotThrow(() => assertPostState(finalizeEnvelope(), finalizePreState(), finalizePostState()));
});

test("post-state checks reject accounting drift even after a successful receipt", () => {
  const badResolve = {
    ...resolvePassState(),
    campaign: { ...resolvePassState().campaign, creator_paid_atto: "89" },
  };
  assert.throws(() => assertPostState(resolveEnvelope(), resolvePreState(), badResolve));

  const badExpire = {
    ...expirePostState(),
    campaign: { ...expirePostState().campaign, available_atto: "999" },
  };
  assert.throws(() => assertPostState(expireEnvelope(), expirePreState(), badExpire));

  const badFinalize = {
    ...finalizePostState(),
    campaign: { ...finalizePostState().campaign, brand_refunded_atto: "499" },
  };
  assert.throws(() => assertPostState(finalizeEnvelope(), finalizePreState(), badFinalize));
});

test("post-state checks tolerate concurrent same-campaign operations", () => {
  const resolveBefore = {
    ...resolvePreState(),
    campaign: {
      ...resolvePreState().campaign,
      available_atto: "700",
      reserved_atto: "300",
    },
  };
  const resolveAfter = {
    ...resolvePassState(),
    campaign: {
      ...resolvePassState().campaign,
      available_atto: "700",
      reserved_atto: "0",
      settled_atto: "300",
      creator_paid_atto: "270",
      fee_atto: "30",
    },
  };
  assert.doesNotThrow(() => assertPostState(resolveEnvelope(), resolveBefore, resolveAfter));

  const expireAfterConcurrentSelection = {
    ...expirePostState(),
    campaign: {
      ...expirePostState().campaign,
      available_atto: "800",
      reserved_atto: "200",
    },
  };
  assert.doesNotThrow(() => assertPostState(
    expireEnvelope(),
    expirePreState(),
    expireAfterConcurrentSelection,
  ));
});

test("v2 undetermined retries bind content_source into the next request id", () => {
  const before = resolvePreState();
  const assignment = before.assignment!;
  const current = resolutionId(assignment, 0);
  const next = resolutionId(assignment, 1);
  const envelope = validateOperationRequest({
    schemaVersion: 1,
    action: "resolve_assignment",
    assignmentId: assignment.assignment_id,
    requestId: current,
  }, configFixture());
  const pre = {
    ...before,
    assignment: {
      ...assignment,
      status: "UNDETERMINED",
      resolution_request_id: current,
    },
  };
  const post = {
    ...pre,
    assignment: {
      ...pre.assignment,
      resolution_attempts: 1,
      resolution_round: 1,
      resolution_request_id: next,
      outcome: "UNDETERMINED",
    },
  };
  assert.doesNotThrow(() => assertPostState(envelope, pre, post));
  assert.throws(() => assertPostState(envelope, pre, {
    ...post,
    assignment: { ...post.assignment, content_source: "FARCASTER" },
  }));
});

function resolutionId(assignment: Record<string, unknown>, round: number): string {
  return `0x${createHash("sha256").update([
    "influencedx-resolution-v2",
    assignment.assignment_id,
    assignment.agreement_hash,
    assignment.submission_hash,
    assignment.content_source,
    assignment.post_id,
    round,
  ].join("|")).digest("hex")}`;
}
