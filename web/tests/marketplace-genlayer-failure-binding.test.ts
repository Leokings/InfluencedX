import assert from "node:assert/strict";
import test from "node:test";
import { abi } from "genlayer-js";

import { runGenLayerJournalReconciliationBatch } from "../lib/marketplace-genlayer-journal.ts";
import type { GenLayerTransactionRow } from "../lib/marketplace-genlayer-repository.ts";
import {
  MarketplaceGenLayerFinalityError,
  canonicalHash,
  exactTerminalMarketplaceTransaction,
  loadFinalizedMarketplaceTransaction,
  terminalMarketplaceTransactionStatus,
  type FinalizedMarketplaceTransaction,
  type MarketplaceGenLayerCall,
} from "../lib/marketplace-genlayer-rpc.ts";

const actor = "0x1111111111111111111111111111111111111111";
const unrelatedActor = "0x2222222222222222222222222222222222222222";
const contract = "0xb72fe7272a5aedf3c6ba893394ebef818fd86fbb" as const;
const campaignId = `0x${"44".repeat(32)}`;
const txHash = `0x${"33".repeat(32)}`;

const cancelCall: MarketplaceGenLayerCall = Object.freeze({
  network: "studionet",
  chainId: 61_999,
  contractAddress: contract,
  functionName: "cancel_campaign",
  args: [campaignId] as const,
  argTypes: ["string"] as const,
  value: "0",
});

test("a finalized execution failure retains the immutable call envelope for exact binding", async () => {
  const encoded = abi.transactions.serialize([
    abi.calldata.encode(
      abi.calldata.makeCalldataObject(
        cancelCall.functionName,
        [...cancelCall.args],
        undefined,
      ),
    ),
    false,
  ]);
  let caught: unknown;
  try {
    await loadFinalizedMarketplaceTransaction(
      txHash,
      ({
        getTransaction: async () => ({
          status: 7,
          status_name: "FINALIZED",
          result: 6,
          result_name: "MAJORITY_AGREE",
          from_address: actor,
          to_address: contract,
          tx_data: encoded.slice(2),
          created_timestamp: "1800000001",
          consensus_data: {
            leader_receipt: [{
              mode: "leader",
              execution_result: "ERROR",
              result: { status: "rollback" },
            }],
          },
        }) as never,
        readContract: async () => null,
      } as never),
      async () => "0",
    );
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof MarketplaceGenLayerFinalityError);
  assert.equal(caught.code, "GENLAYER_EXECUTION_FAILED");
  const transaction = exactTerminalMarketplaceTransaction(caught, {
    call: cancelCall,
    actorWallet: actor,
    transactionHash: txHash,
  });
  assert.ok(transaction);
  assert.equal(transaction.lifecycleStatus, "FINALIZED");
  assert.equal(transaction.executionResult, "ERROR");
  assert.equal(transaction.functionName, "cancel_campaign");
  assert.deepEqual(transaction.args, [campaignId]);
  assert.equal(transaction.finalizedAt, 1_800_000_001);
});

test("terminal classification rejects every unrelated failed-hash boundary", () => {
  const transaction: FinalizedMarketplaceTransaction = Object.freeze({
    hash: txHash,
    sender: actor,
    recipient: contract,
    functionName: cancelCall.functionName,
    args: cancelCall.args,
    lifecycleStatus: "FINALIZED",
    executionResult: "ERROR",
    consensusResult: "MAJORITY_AGREE",
    valueAtto: "0",
    finalizedAt: 1_800_000_001,
  });
  const error = (change: Partial<FinalizedMarketplaceTransaction>) =>
    new MarketplaceGenLayerFinalityError(
      "GENLAYER_EXECUTION_FAILED",
      "rolled back",
      false,
      Object.freeze({ ...transaction, ...change }),
    );

  assert.throws(
    () => exactTerminalMarketplaceTransaction(error({ sender: unrelatedActor }), {
      call: cancelCall,
      actorWallet: actor,
      transactionHash: txHash,
    }),
    /another wallet/,
  );
  assert.throws(
    () => exactTerminalMarketplaceTransaction(error({ hash: `0x${"66".repeat(32)}` }), {
      call: cancelCall,
      actorWallet: actor,
      transactionHash: txHash,
    }),
    /hash does not match/,
  );
  assert.throws(
    () => exactTerminalMarketplaceTransaction(error({ recipient: unrelatedActor }), {
      call: cancelCall,
      actorWallet: actor,
      transactionHash: txHash,
    }),
    /another contract/,
  );
  assert.throws(
    () => exactTerminalMarketplaceTransaction(error({ functionName: "refund_unallocated" }), {
      call: cancelCall,
      actorWallet: actor,
      transactionHash: txHash,
    }),
    /another method/,
  );
  assert.throws(
    () => exactTerminalMarketplaceTransaction(error({ args: [`0x${"55".repeat(32)}`] }), {
      call: cancelCall,
      actorWallet: actor,
      transactionHash: txHash,
    }),
    /arguments/,
  );
  assert.throws(
    () => exactTerminalMarketplaceTransaction(error({ valueAtto: "1" }), {
      call: cancelCall,
      actorWallet: actor,
      transactionHash: txHash,
    }),
    /value/,
  );
  assert.throws(
    () => exactTerminalMarketplaceTransaction(
      new MarketplaceGenLayerFinalityError(
        "GENLAYER_EXECUTION_FAILED",
        "rolled back",
        false,
      ),
      { call: cancelCall, actorWallet: actor, transactionHash: txHash },
    ),
    /no verifiable envelope/,
  );

  const terminated = new MarketplaceGenLayerFinalityError(
    "GENLAYER_TRANSACTION_TERMINATED",
    "terminated",
    false,
    transaction,
  );
  assert.equal(
    terminalMarketplaceTransactionStatus(terminated),
    "NETWORK_TERMINATED",
  );
  assert.equal(
    exactTerminalMarketplaceTransaction(terminated, {
      call: cancelCall,
      actorWallet: actor,
      transactionHash: txHash,
    }),
    transaction,
  );
});

test("journal reconciliation poisons an unrelated failed hash instead of terminalizing the intent", async () => {
  const row = journalClaim();
  const unrelatedTransaction: FinalizedMarketplaceTransaction = Object.freeze({
    hash: txHash,
    sender: unrelatedActor,
    recipient: contract,
    functionName: row.functionName,
    args: row.args,
    lifecycleStatus: "FINALIZED",
    executionResult: "ERROR",
    consensusResult: "MAJORITY_AGREE",
    valueAtto: row.valueAtto,
    finalizedAt: 1_800_000_001,
  });
  let claimed = false;
  const recorded: Array<Record<string, unknown>> = [];
  const result = await runGenLayerJournalReconciliationBatch({
    nowMs: 1_800_000_000_000,
    limit: 1,
    dependencies: {
      claim: async () => {
        if (claimed) return null;
        claimed = true;
        return row;
      },
      dispatch: async () => {
        throw new MarketplaceGenLayerFinalityError(
          "GENLAYER_EXECUTION_FAILED",
          "rolled back",
          false,
          unrelatedTransaction,
        );
      },
      find: async () => row,
      record: async (input) => {
        recorded.push(input);
        return {
          ...row,
          status: input.status,
          fenceToken: null,
          fenceExpiresAt: null,
        };
      },
    },
  });

  assert.deepEqual(result, {
    claimed: 1,
    finalized: 0,
    retryScheduled: 0,
    terminal: 0,
    manual: 1,
    capped: true,
  });
  assert.deepEqual(recorded, [{
    preparedId: row.preparedId,
    status: "RECONCILIATION_REQUIRED",
    lifecycleStatus: null,
    executionResult: null,
    errorCode: "GENLAYER_JOURNAL_POISONED",
    retryAtMs: 0,
    nowMs: 1_800_000_000_000,
    fenceToken: row.fenceToken,
  }]);
});

function journalClaim(): GenLayerTransactionRow & { fenceToken: string } {
  const args = [...cancelCall.args];
  return {
    preparedId: "11111111-1111-4111-8111-111111111111",
    network: "studionet",
    chainId: 61_999,
    contractAddress: contract,
    operation: "CANCEL_CAMPAIGN",
    functionName: cancelCall.functionName,
    args,
    argTypes: [...cancelCall.argTypes],
    argsHash: canonicalHash(args),
    intentKey: null,
    valueAtto: cancelCall.value,
    actorWallet: actor,
    localCampaignId: "22222222-2222-4222-8222-222222222222",
    localApplicationId: null,
    onchainEntityId: campaignId,
    transactionHash: txHash,
    status: "SUBMITTED",
    lifecycleStatus: null,
    executionResult: null,
    errorCode: null,
    submittedAt: 1_800_000_000_000,
    acceptedAt: null,
    finalizedAt: null,
    lastCheckedAt: 1_800_000_000_000,
    reconciliationAttempts: 1,
    nextReconcileAt: 1_800_000_000_000,
    fenceToken: "44444444-4444-4444-8444-444444444444",
    fenceExpiresAt: 1_800_000_240_000,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  };
}
