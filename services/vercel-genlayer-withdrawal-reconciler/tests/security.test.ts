import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmationBindingError,
  createPinnedWithdrawalClient,
  externalTransferBindingError,
  finalizedSuccessful,
  marketplaceConfigBoundaryError,
} from "../lib/studionet-client";
import { MARKETPLACE_ADDRESS } from "../lib/constants";
import {
  CHILD_TX,
  CONFIRM_TX,
  confirmationReceipt,
  emittedWithdrawal,
  PARENT_TX,
  RECIPIENT,
  TEST_PRIVATE_KEY_SIGNER,
  transferProof,
  WITHDRAWAL_CONFIRMER,
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

test("the signer adapter requires the key to derive to the configured withdrawal confirmer", () => {
  assert.doesNotThrow(() => createPinnedWithdrawalClient({
    ...configFixture(),
    contractWithdrawalConfirmer: TEST_PRIVATE_KEY_SIGNER,
  }));
  assert.throws(
    () => createPinnedWithdrawalClient(configFixture()),
    /WITHDRAWAL_SIGNER_IS_NOT_PINNED_WITHDRAWAL_CONFIRMER/,
  );
});

test("live config binds the signer to a non-governance withdrawal confirmer", () => {
  const config = configFixture();
  const identity = {
    protocol_version: config.contractProtocol,
    storage_schema_version: config.contractSchemaVersion,
    native_token_symbol: "GEN",
    native_token_decimals: 18,
    withdrawal_recovery_delay_seconds: 24 * 60 * 60,
    withdrawal_confirmer: WITHDRAWAL_CONFIRMER,
    owner: `0x${"21".repeat(20)}`,
    upgrade_admin: `0x${"22".repeat(20)}`,
    pending_owner: `0x${"00".repeat(20)}`,
    pending_owner_active: false,
  };
  assert.equal(marketplaceConfigBoundaryError(identity, config, WITHDRAWAL_CONFIRMER), null);
  for (const [patch, signer, code] of [
    [{ withdrawal_confirmer: RECIPIENT }, WITHDRAWAL_CONFIRMER, "WITHDRAWAL_CONFIRMER_MISMATCH"],
    [{}, RECIPIENT, "WITHDRAWAL_CONFIRMER_MISMATCH"],
    [{ owner: WITHDRAWAL_CONFIRMER }, WITHDRAWAL_CONFIRMER, "WITHDRAWAL_CONFIRMER_GOVERNANCE_ROLE_OVERLAP"],
    [{ upgrade_admin: WITHDRAWAL_CONFIRMER }, WITHDRAWAL_CONFIRMER, "WITHDRAWAL_CONFIRMER_GOVERNANCE_ROLE_OVERLAP"],
    [{ pending_owner_active: true, pending_owner: WITHDRAWAL_CONFIRMER }, WITHDRAWAL_CONFIRMER, "WITHDRAWAL_CONFIRMER_GOVERNANCE_ROLE_OVERLAP"],
  ] as Array<[Record<string, unknown>, string, string]>) {
    assert.equal(marketplaceConfigBoundaryError({ ...identity, ...patch }, config, signer), code);
  }
});

test("confirmation receipt must bind the confirmer, contract, zero value, method, and both exact hashes", () => {
  const proof = transferProof();
  const expected = {
    txHash: CONFIRM_TX,
    signerAddress: WITHDRAWAL_CONFIRMER,
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
