import assert from "node:assert/strict";
import test from "node:test";
import type { Address, Hex } from "viem";
import {
  buildOwnershipSubmissionEnvelope,
  ownershipSubmissionRequestId,
} from "../lib/ownership-submission.ts";
import {
  openSubmissionEvidence,
  sealSubmissionEvidence,
  SubmissionEvidenceError,
  submissionEvidenceDigest,
  type SubmissionEvidence,
  type SubmissionEvidenceBinding,
  type SubmissionSealKeyring,
} from "../lib/submission-evidence.ts";

const NOW_MS = 1_786_233_600_000;
const WALLET = "0x1212121212121212121212121212121212121212" as Address;
const KEY_A = base64url(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const KEY_B = base64url(Uint8Array.from({ length: 32 }, (_, index) => 255 - index));

function keyring(activeKeyId = "key-a", includeOld = true): SubmissionSealKeyring {
  return {
    activeKeyId,
    keys: new Map([
      ...(includeOld ? [["key-a", KEY_A] as const] : []),
      ["key-b", KEY_B] as const,
    ]),
  };
}

function fixture(): { evidence: SubmissionEvidence; binding: SubmissionEvidenceBinding } {
  const unsigned = {
    baseWallet: WALLET,
    expectedHandle: "xproof_creator",
    postId: "2109876543210987654",
    challenge: `APV2-${"a".repeat(24)}`,
    issuedAtEpoch: Math.floor(NOW_MS / 1_000) - 60,
    expiresAtEpoch: Math.floor(NOW_MS / 1_000) + 840,
    credentialExpiresAtEpoch: Math.floor(NOW_MS / 1_000) + 30 * 24 * 60 * 60,
  };
  const requestId = ownershipSubmissionRequestId(unsigned);
  const envelope = buildOwnershipSubmissionEnvelope({ ...unsigned, requestId });
  const evidence = {
    version: 1,
    verificationRequestId: "verification-row-1",
    ownerUserId: "wallet-session-subject-1",
    envelope,
    ownershipIntentSignature: `0x${"ab".repeat(65)}` as Hex,
    sealedAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 60_000,
  } as const;
  return {
    evidence,
    binding: {
      verificationRequestId: evidence.verificationRequestId,
      ownerUserId: evidence.ownerUserId,
      wallet: WALLET,
      finalizedRequestId: requestId,
    },
  };
}

test("sealed evidence recovers the exact challenge and raw ownership signature", async () => {
  const { evidence, binding } = fixture();
  const token = await sealSubmissionEvidence(evidence, {
    binding,
    keyring: keyring(),
  });
  assert.match(token, /^xpe1\.key-a\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.match(submissionEvidenceDigest(token), /^0x[0-9a-f]{64}$/);
  const opened = await openSubmissionEvidence(token, {
    binding,
    keyring: keyring(),
    nowMs: NOW_MS + 1,
  });
  assert.deepEqual(opened, evidence);
});

test("ciphertext tampering and row swapping fail authentication", async () => {
  const { evidence, binding } = fixture();
  const token = await sealSubmissionEvidence(evidence, { binding, keyring: keyring() });
  const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
  await assert.rejects(
    openSubmissionEvidence(tampered, { binding, keyring: keyring(), nowMs: NOW_MS + 1 }),
    (error) => error instanceof SubmissionEvidenceError && error.code === "INVALID_EVIDENCE",
  );
  await assert.rejects(
    openSubmissionEvidence(token, {
      binding: { ...binding, verificationRequestId: "verification-row-2" },
      keyring: keyring(),
      nowMs: NOW_MS + 1,
    }),
    (error) => error instanceof SubmissionEvidenceError && error.code === "INVALID_EVIDENCE",
  );
});

test("key rotation keeps an old key only while it remains in the server keyring", async () => {
  const { evidence, binding } = fixture();
  const oldToken = await sealSubmissionEvidence(evidence, { binding, keyring: keyring("key-a") });
  const rotating = keyring("key-b", true);
  assert.equal(
    (await openSubmissionEvidence(oldToken, { binding, keyring: rotating, nowMs: NOW_MS + 1 })).envelope.requestId,
    evidence.envelope.requestId,
  );
  await assert.rejects(
    openSubmissionEvidence(oldToken, {
      binding,
      keyring: keyring("key-b", false),
      nowMs: NOW_MS + 1,
    }),
    SubmissionEvidenceError,
  );
});

test("expired evidence cannot be opened for submission or relay", async () => {
  const { evidence, binding } = fixture();
  const token = await sealSubmissionEvidence(evidence, { binding, keyring: keyring() });
  await assert.rejects(
    openSubmissionEvidence(token, {
      binding,
      keyring: keyring(),
      nowMs: evidence.expiresAtMs,
    }),
    (error) => error instanceof SubmissionEvidenceError && error.code === "EVIDENCE_EXPIRED",
  );
});

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
