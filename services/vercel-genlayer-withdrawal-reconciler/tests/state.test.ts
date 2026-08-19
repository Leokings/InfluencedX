import assert from "node:assert/strict";
import test from "node:test";

import {
  assertConfirmedPostState,
  assertEmittedWithdrawal,
  parseCounts,
  parseWithdrawal,
} from "../lib/state";
import {
  countsAfter,
  countsBefore,
  emittedWithdrawal,
  NOW_EPOCH,
  RECIPIENT,
  transferProof,
  WITHDRAWAL_ID,
} from "./helpers";

test("withdrawal and accounting parsers reject malformed chain data", () => {
  const raw = {
    withdrawal_id: WITHDRAWAL_ID,
    account: RECIPIENT,
    nonce: 0,
    amount_atto: "100",
    status: "EMITTED_UNCONFIRMED",
    requested_at_epoch: NOW_EPOCH - 120,
    emitted_at_epoch: NOW_EPOCH - 60,
    reconciled_at_epoch: 0,
    evidence_hash: `0x${"0".repeat(64)}`,
    recapitalized_atto: "0",
  };
  assert.deepEqual(parseWithdrawal(raw, WITHDRAWAL_ID), emittedWithdrawal());
  assert.equal(parseWithdrawal({}, WITHDRAWAL_ID), null);
  assert.throws(() => parseWithdrawal({ ...raw, amount_atto: -1 }, WITHDRAWAL_ID));
  assert.throws(() => parseWithdrawal({ ...raw, account: `0x${"0".repeat(40)}` }, WITHDRAWAL_ID));

  const snake = Object.fromEntries(Object.entries(countsBefore()).map(([key, value]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value]));
  assert.deepEqual(parseCounts(snake), countsBefore());
  assert.throws(() => parseCounts({ ...snake, total_liability_atto: "-1" }));
});

test("only pristine EMITTED_UNCONFIRMED state is confirmable", () => {
  assert.doesNotThrow(() => assertEmittedWithdrawal(emittedWithdrawal()));
  assert.throws(() => assertEmittedWithdrawal(emittedWithdrawal({ status: "PENDING" })));
  assert.throws(() => assertEmittedWithdrawal(emittedWithdrawal({ evidenceHash: `0x${"11".repeat(32)}` })));
  assert.throws(() => assertEmittedWithdrawal(emittedWithdrawal({ reconciledAtEpoch: NOW_EPOCH })));
});

test("final confirmation requires the exact withdrawal and exact accounting deltas", () => {
  const before = emittedWithdrawal();
  const proof = transferProof();
  const after = emittedWithdrawal({ status: "CONFIRMED", evidenceHash: proof.evidenceHash, reconciledAtEpoch: NOW_EPOCH + 30 });
  assert.doesNotThrow(() => assertConfirmedPostState(before, countsBefore(), proof, after, countsAfter()));
  assert.throws(() => assertConfirmedPostState(before, countsBefore(), proof, after, countsAfter({ totalWithdrawnAtto: "101" })));
  assert.throws(() => assertConfirmedPostState(before, countsBefore(), proof, { ...after, evidenceHash: `0x${"99".repeat(32)}` }, countsAfter()));
  assert.throws(() => assertConfirmedPostState(before, countsBefore(), proof, { ...after, amountAtto: "99" }, countsAfter()));
  assert.throws(() => assertConfirmedPostState(before, countsBefore(), { ...proof, evidenceHash: `0x${"99".repeat(32)}` }, after, countsAfter()));
});
