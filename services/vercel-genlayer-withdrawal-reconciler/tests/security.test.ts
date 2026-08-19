import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmationBindingError,
  createPinnedWithdrawalClient,
  externalTransferBindingError,
  finalizedSuccessful,
} from "../lib/studionet-client";
import { MARKETPLACE_ADDRESS, MARKETPLACE_OWNER } from "../lib/constants";
import {
  CHILD_TX,
  CONFIRM_TX,
  confirmationReceipt,
  emittedWithdrawal,
  PARENT_TX,
  RECIPIENT,
  transferProof,
} from "./helpers";
import { configFixture } from "./helpers";

function child(overrides: Record<string, unknown> = {}) {
  return {
    hash: CHILD_TX,
    sender: MARKETPLACE_ADDRESS,
    recipient: RECIPIENT,
    triggered_by: PARENT_TX,
    triggered_on: "FINALIZED",
    statusName: "FINALIZED",
    rawValueAtto: "100",
    value_credited: true,
    ...overrides,
  };
}

test("external transfer evidence binds the unique child to parent, contract, recipient, amount, and credit", () => {
  assert.equal(externalTransferBindingError(child(), PARENT_TX, emittedWithdrawal(), MARKETPLACE_ADDRESS), null);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ triggered_by: `0x${"aa".repeat(32)}` }, "TRANSFER_PARENT_LINK_MISMATCH"],
    [{ triggered_on: "ACCEPTED" }, "TRANSFER_TRIGGER_STATE_MISMATCH"],
    [{ sender: `0x${"bb".repeat(20)}` }, "TRANSFER_SENDER_MISMATCH"],
    [{ recipient: `0x${"cc".repeat(20)}` }, "TRANSFER_RECIPIENT_MISMATCH"],
    [{ rawValueAtto: "101" }, "TRANSFER_AMOUNT_MISMATCH"],
    [{ value_credited: false }, "TRANSFER_VALUE_NOT_CREDITED"],
    [{ hash: PARENT_TX }, "TRANSFER_CHILD_EQUALS_PARENT"],
  ];
  for (const [patch, code] of cases) {
    assert.equal(externalTransferBindingError(child(patch), PARENT_TX, emittedWithdrawal(), MARKETPLACE_ADDRESS), code);
  }
});

test("the signer adapter refuses any private key that does not derive to the live contract owner", () => {
  assert.throws(
    () => createPinnedWithdrawalClient(configFixture()),
    /WITHDRAWAL_SIGNER_IS_NOT_PINNED_OWNER/,
  );
});

test("confirmation receipt must bind the owner, contract, zero value, method, and both exact hashes", () => {
  const proof = transferProof();
  const expected = {
    txHash: CONFIRM_TX,
    signerAddress: MARKETPLACE_OWNER,
    contractAddress: MARKETPLACE_ADDRESS,
    withdrawalId: proof.withdrawalId,
    evidenceHash: proof.evidenceHash,
  };
  assert.equal(confirmationBindingError(confirmationReceipt(), expected), null);
  for (const [patch, code] of [
    [{ sender: RECIPIENT }, "CONFIRMATION_SENDER_MISMATCH"],
    [{ recipient: RECIPIENT }, "CONFIRMATION_CONTRACT_MISMATCH"],
    [{ rawValueAtto: "1" }, "CONFIRMATION_VALUE_MISMATCH"],
    [{ tx_data_decoded: { call_data: { method: "restore_failed_withdrawal", args: [proof.withdrawalId, proof.evidenceHash] } } }, "CONFIRMATION_METHOD_MISMATCH"],
    [{ tx_data_decoded: { call_data: { method: "confirm_withdrawal", args: [proof.withdrawalId, `0x${"aa".repeat(32)}`] } } }, "CONFIRMATION_ARGUMENTS_MISMATCH"],
  ] as Array<[Record<string, unknown>, string]>) {
    assert.equal(confirmationBindingError(confirmationReceipt(patch), expected), code);
  }
});

test("finality requires exactly one successful leader return", () => {
  assert.equal(finalizedSuccessful(confirmationReceipt()), true);
  assert.equal(finalizedSuccessful(confirmationReceipt({ statusName: "ACCEPTED" })), false);
  assert.equal(finalizedSuccessful(confirmationReceipt({ resultName: "MAJORITY_DISAGREE" })), false);
  assert.equal(finalizedSuccessful(confirmationReceipt({ consensus_data: { leader_receipt: [] } })), false);
  assert.equal(finalizedSuccessful(confirmationReceipt({ consensus_data: { leader_receipt: [{ mode: "leader", execution_result: "ERROR", result: { status: "return" } }] } })), false);
});
