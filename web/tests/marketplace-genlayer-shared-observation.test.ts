import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseAssignmentState,
  parseCampaignState,
} from "../lib/marketplace-genlayer-core.ts";
import {
  observeGenLayerResolutionSharedState,
  runGenLayerSharedObservationRepairBatch,
} from "../lib/marketplace-genlayer-shared-observation.ts";
import {
  MARKETPLACE_V3_STUDIONET_ADDRESS,
  canonicalHash,
  type FinalizedMarketplaceTransaction,
} from "../lib/marketplace-genlayer-rpc.ts";
import {
  assertGenLayerCampaignObservationFloors,
  type GenLayerAssignmentProjection,
  type GenLayerCampaignProjection,
} from "../lib/marketplace-genlayer-repository.ts";

const hash = (byte: string) => `0x${byte.repeat(64)}`;
const address = (byte: string) => `0x${byte.repeat(40)}`;
const assignmentId = hash("1");
const campaignId = hash("2");
const requestId = hash("3");
const transactionHash = hash("4");
const creator = address("a");
const brand = address("b");
const finalizedAt = 1_800_000_000;

test("stable shared observation deduplicates wallets and clears only its exact ticket", async () => {
  const fixture = sharedFixture();
  const observedCampaigns: unknown[] = [];
  const observedClaimables: unknown[] = [];
  const completions: unknown[] = [];
  const deferrals: unknown[] = [];
  const result = await observeGenLayerResolutionSharedState({
    assignment: fixture.marker,
    nowMs: finalizedAt * 1_000 + 5_000,
    dependencies: {
      loadFinalized: async () => fixture.finalized,
      begin: async () => ({
        ...fixture.marker,
        sharedProjectionObservationTicket: 41,
      }),
      findCampaign: async () => fixture.campaignProjection,
      readState: fixture.stableReader,
      observeCampaign: async (input) => {
        observedCampaigns.push(input);
        return {} as never;
      },
      observeClaimable: async (input) => {
        observedClaimables.push(input);
        return {} as never;
      },
      complete: async (input) => {
        completions.push(input);
        return true;
      },
      defer: async (input) => {
        deferrals.push(input);
        return true;
      },
    },
  });

  assert.equal(result.status, "OBSERVED");
  assert.equal(result.walletCount, 2, "brand and treasury must be observed once");
  assert.equal(observedCampaigns.length, 1);
  assert.equal(observedClaimables.length, 2);
  assert.equal(deferrals.length, 0);
  assert.equal((observedCampaigns[0] as { observationTicket: number }).observationTicket, 41);
  assert.deepEqual(
    (completions[0] as { observationTicket: number; claimables: unknown[] }),
    {
      projectionId: fixture.marker.projectionId,
      anchorTransactionHash: transactionHash,
      assignmentSnapshotHash: fixture.marker.snapshotHash,
      observationTicket: 41,
      anchorFinalizedAt: finalizedAt * 1_000,
      campaignId,
      campaignSnapshotHash: canonicalHash(fixture.campaign),
      claimables: fixture.claimables.map((state) => ({
        wallet: state.account,
        snapshotHash: canonicalHash(state),
      })),
    },
  );
});

test("moving finalized state performs no writes and defers the fresh attempt once", async () => {
  const fixture = sharedFixture();
  let reads = 0;
  let writes = 0;
  const deferrals: unknown[] = [];
  await assert.rejects(
    observeGenLayerResolutionSharedState({
      assignment: fixture.marker,
      dependencies: {
        loadFinalized: async () => fixture.finalized,
        begin: async () => ({
          ...fixture.marker,
          sharedProjectionObservationTicket: 52,
        }),
        findCampaign: async () => fixture.campaignProjection,
        readState: async (method, args) => {
          const value = await (fixture.stableReader as (
            method: string,
            args: readonly unknown[],
          ) => Promise<unknown>)(method, args);
          reads += 1;
          if (reads > 4 && method === "get_campaign") {
            return { ...(value as Record<string, unknown>), application_count: 3 };
          }
          return value;
        },
        observeCampaign: async () => {
          writes += 1;
          return {} as never;
        },
        observeClaimable: async () => {
          writes += 1;
          return {} as never;
        },
        complete: async () => {
          writes += 1;
          return true;
        },
        defer: async (input) => {
          deferrals.push(input);
          return true;
        },
      },
    }),
    /changed during observation/,
  );
  assert.equal(writes, 0);
  assert.equal(deferrals.length, 1);
  assert.equal((deferrals[0] as { observationTicket: number }).observationTicket, 52);
});

test("receipt mismatch is rejected before ticket minting and defers only the scanned marker", async () => {
  const fixture = sharedFixture();
  let began = false;
  const deferrals: unknown[] = [];
  await assert.rejects(
    observeGenLayerResolutionSharedState({
      assignment: fixture.marker,
      dependencies: {
        loadFinalized: async () => ({
          ...fixture.finalized,
          args: [assignmentId, hash("f")],
        }),
        begin: async () => {
          began = true;
          return null;
        },
        defer: async (input) => {
          deferrals.push(input);
          return true;
        },
      },
    }),
    /exact resolution receipt/,
  );
  assert.equal(began, false);
  assert.deepEqual(deferrals, [{
    projectionId: fixture.marker.projectionId,
    anchorTransactionHash: transactionHash,
    snapshotHash: fixture.marker.snapshotHash,
    observationTicket: null,
    nowMs: (deferrals[0] as { nowMs: number }).nowMs,
  }]);
});

test("partial wallet failure leaves the marker pending and defers the exact attempt once", async () => {
  const fixture = sharedFixture();
  let claimableWrites = 0;
  let completeCalls = 0;
  let deferCalls = 0;
  await assert.rejects(observeGenLayerResolutionSharedState({
    assignment: fixture.marker,
    dependencies: {
      loadFinalized: async () => fixture.finalized,
      begin: async () => ({
        ...fixture.marker,
        sharedProjectionObservationTicket: 63,
      }),
      findCampaign: async () => fixture.campaignProjection,
      readState: fixture.stableReader,
      observeCampaign: async () => ({} as never),
      observeClaimable: async () => {
        claimableWrites += 1;
        if (claimableWrites === 2) throw new Error("simulated wallet write crash");
        return {} as never;
      },
      complete: async () => {
        completeCalls += 1;
        return true;
      },
      defer: async (input) => {
        assert.equal(input.observationTicket, 63);
        deferCalls += 1;
        return true;
      },
    },
  }), /simulated wallet write crash/);
  assert.equal(completeCalls, 0);
  assert.equal(deferCalls, 1);
});

test("maintenance shared repair is bounded and a failed row is deferred once", async () => {
  const fixture = sharedFixture();
  let deferCalls = 0;
  const result = await runGenLayerSharedObservationRepairBatch({
    nowMs: finalizedAt * 1_000 + 10_000,
    limit: 1,
    dependencies: {
      listPending: async (input) => {
        assert.deepEqual(input, { nowMs: finalizedAt * 1_000 + 10_000, limit: 1 });
        return [fixture.marker];
      },
      loadFinalized: async () => {
        throw new Error("temporary receipt outage");
      },
      defer: async () => {
        deferCalls += 1;
        return true;
      },
    },
  });
  assert.deepEqual(result, { scanned: 1, repaired: 0, pending: 1 });
  assert.equal(deferCalls, 1);
});

test("a later observation cannot regress a completed reserve release", () => {
  const fixture = sharedFixture();
  const released = {
    ...fixture.campaignProjection,
    availableAtto: "800",
    reservedAtto: "0",
    settledAtto: "200",
    creatorPaidAtto: "196",
    brandRefundedAtto: "0",
    feeAtto: "4",
    applicationCount: 2,
    assignmentCount: 2,
  } satisfies GenLayerCampaignProjection;
  const knownTerminal = {
    settledAtto: "200",
    creatorPaidAtto: "196",
    brandRefundedAtto: "0",
    feeAtto: "4",
  };

  assert.throws(
    () => assertGenLayerCampaignObservationFloors(
      released,
      {
        ...fixture.campaign,
        availableAtto: "700",
        reservedAtto: "100",
      },
      knownTerminal,
    ),
    /regresses durable accounting/,
  );

  assert.doesNotThrow(() => assertGenLayerCampaignObservationFloors(
    {
      ...released,
      availableAtto: "700",
      reservedAtto: "100",
    },
    {
      ...fixture.campaign,
      availableAtto: "800",
      reservedAtto: "0",
    },
    knownTerminal,
  ));
});

test("same-second withdrawal advancement uses exact prior snapshot and transaction CAS", async () => {
  const [repository, actions] = await Promise.all([
    readFile(new URL("../lib/marketplace-genlayer-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/marketplace-genlayer-actions.ts", import.meta.url), "utf8"),
  ]);
  const withdrawalUpsert = repository.slice(
    repository.indexOf("export async function upsertGenLayerWithdrawalProjection"),
    repository.indexOf("export async function findGenLayerWithdrawalProjectionById"),
  );
  const exactPreviousBranch = withdrawalUpsert.slice(
    withdrawalUpsert.indexOf("setWhere: expectedPreviousSnapshotHash"),
    withdrawalUpsert.indexOf(".returning()"),
  );
  assert.match(exactPreviousBranch, /snapshotHash\} = \$\{expectedPreviousSnapshotHash\}/);
  assert.match(exactPreviousBranch, /lastTxHash\} = \$\{expectedPreviousLastTxHash\}/);
  assert.doesNotMatch(
    exactPreviousBranch.slice(exactPreviousBranch.indexOf(": sql`")),
    /finalizedAt\} < /,
  );
  const execution = actions.slice(
    actions.indexOf("export async function confirmGenLayerWithdrawalExecution"),
    actions.indexOf("type ActionInput"),
  );
  assert.match(execution, /existing\.snapshotHash,\s*existing\.lastTxHash/);
});

test("migration and repository bind completion to tickets, snapshots, and fair retry", async () => {
  const [migration, repository, maintenance, actions, verifier] = await Promise.all([
    readFile(new URL("../drizzle-postgres/0015_resolution_shared_observation.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/marketplace-genlayer-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/marketplace-genlayer-maintenance.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/marketplace-genlayer-actions.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/verify-database.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /shared_observation_ticket_seq/);
  assert.match(migration, /shared_projection_observation_ticket/);
  assert.match(migration, /DROP CONSTRAINT "marketplace_genlayer_campaigns_money"/);
  assert.match(migration, /creator_paid_atto" \+ "fee_atto" <= "settled_atto"/);
  assert.match(migration, /marketplace_genlayer_campaigns_terminal_balances/);
  assert.match(migration, /intentionally does not guess or backfill transaction provenance/);
  assert.doesNotMatch(migration, /\bupdate\s+"marketplace_genlayer_assignments"/i);
  assert.match(verifier, /unanchored_resolution_count/);
  assert.match(repository, /sharedProjectionObservationTicket,\s*input\.observationTicket/);
  assert.match(repository, /observed_claimable\.observation_ticket = \$\{input\.observationTicket\}/);
  assert.match(repository, /sharedProjectionNextRepairAt/);
  const assignmentUpsert = repository.slice(
    repository.indexOf("export async function upsertGenLayerAssignmentProjection"),
    repository.indexOf("export async function upsertGenLayerClaimableBalance"),
  );
  assert.match(
    assignmentUpsert,
    /setWhere: expectedPreviousSnapshotHash === null\s*\? sql`\$\{marketplaceGenLayerAssignments\.finalizedAt\} < \$\{input\.finalizedAt\}`\s*:\s*sql`\$\{marketplaceGenLayerAssignments\.snapshotHash\} = \$\{expectedPreviousSnapshotHash\}`/,
  );
  const withdrawalUpsert = repository.slice(
    repository.indexOf("export async function upsertGenLayerWithdrawalProjection"),
    repository.indexOf("export async function findGenLayerWithdrawalProjectionById"),
  );
  assert.match(
    withdrawalUpsert,
    /snapshotHash\} = \$\{expectedPreviousSnapshotHash\}[\s\S]*lastTxHash\} = \$\{expectedPreviousLastTxHash\}/,
  );
  assert.match(
    withdrawalUpsert,
    /current\.lastTxHash === normalizedLastTxHash[\s\S]*current\.snapshotHash === normalizedSnapshotHash[\s\S]*current\.finalizedAt === input\.finalizedAt/,
  );
  assert.match(
    assignmentUpsert,
    /current\.lastTxHash === normalizedLastTxHash[\s\S]*current\.snapshotHash === normalizedSnapshotHash[\s\S]*current\.finalizedAt === input\.finalizedAt/,
  );
  assert.doesNotMatch(repository, /observedAfterFinalizedAt\} > /);
  const maintenanceBody = maintenance.slice(
    maintenance.indexOf("export async function runGenLayerMaintenanceBatch"),
  );
  assert.ok(
    maintenanceBody.indexOf("const journal =") <
      maintenanceBody.indexOf("const sharedObservation ="),
  );
  assert.ok(
    maintenanceBody.indexOf("const sharedObservation =") <
      maintenanceBody.indexOf("const progression ="),
  );
  const confirmStart = actions.indexOf("export async function confirmGenLayerResolution");
  const confirmEnd = actions.indexOf("export async function reconcileGenLayerOperatorResolution");
  const confirmation = actions.slice(confirmStart, confirmEnd);
  assert.ok(confirmation.indexOf("finalizePrepared") < confirmation.indexOf("repairSharedObservationBestEffort"));
  assert.ok(
    actions.match(/expectedPreviousSnapshotHash:/g)?.length === 6,
    "every existing-assignment transition must use exact previous-state CAS",
  );
  const assignmentSimpleStart = actions.indexOf("async function confirmAssignmentSimple");
  const assignmentSimpleEnd = actions.indexOf(
    "async function confirmCampaignSimple",
    assignmentSimpleStart,
  );
  const assignmentSimple = actions.slice(assignmentSimpleStart, assignmentSimpleEnd);
  assert.match(
    assignmentSimple,
    /expectedStatus === "REFUNDED"[\s\S]*projectClaimable\([\s\S]*context\.draft\.brandWallet/,
  );
  assert.match(
    actions,
    /existing\.snapshotHash,\s*existing\.lastTxHash,\s*\);/,
  );
  const expiryStart = actions.indexOf("export async function reconcileGenLayerOperatorExpiry");
  const expiryEnd = actions.indexOf(
    "export async function reconcileGenLayerOperatorCampaignFinalization",
    expiryStart,
  );
  const expiry = actions.slice(expiryStart, expiryEnd);
  assert.ok(
    expiry.indexOf("await Promise.all") <
      expiry.lastIndexOf("const projected = await projectAssignment"),
    "the expiry assignment must remain scan-visible until shared writes finish",
  );
  assert.match(expiry, /expectedPreviousSnapshotHash: existing\.snapshotHash/);
  const finalizationStart = expiryEnd;
  const finalizationEnd = actions.indexOf(
    "export async function prepareGenLayerRefundUndetermined",
    finalizationStart,
  );
  const finalization = actions.slice(finalizationStart, finalizationEnd);
  assert.ok(
    finalization.indexOf("await Promise.all") <
      finalization.lastIndexOf("const projected = await projectCampaign"),
    "the campaign must remain OPEN and scan-visible until shared writes finish",
  );
});

function sharedFixture() {
  const assignmentRaw = {
    assignment_id: assignmentId,
    campaign_id: campaignId,
    brand,
    creator,
    content_source: "X",
    creator_handle: "creator",
    creator_external_user_id: "creator-1",
    creator_identity_hash: hash("5"),
    application_id: hash("6"),
    agreement_hash: hash("7"),
    agreed_rate_atto: "100",
    status: "SETTLED_PASS",
    selected_at_epoch: 1_799_000_000,
    acceptance_deadline_epoch: 1_799_100_000,
    accepted_at_epoch: 1_799_010_000,
    post_id: "123",
    submission_hash: hash("8"),
    resolution_request_id: requestId,
    resolution_round: 0,
    resolution_attempts: 1,
    resolution_eligible_at_epoch: 1_799_020_000,
    last_resolution_at_epoch: 1_799_030_000,
    outcome: "PASS",
    reasoning: "Verified",
    resolution_checks: {},
    evidence_hash: hash("9"),
    creator_credit_atto: "98",
    brand_credit_atto: "0",
    fee_atto: "2",
    submitted_at_epoch: 1_799_020_000,
    settled_at_epoch: 1_799_030_000,
    closed_at_epoch: 0,
  };
  const assignment = parseAssignmentState(assignmentRaw);
  const campaignRaw = {
    campaign_id: campaignId,
    brand,
    client_nonce: "shared-observation-0001",
    content_source: "X",
    title: "Shared observation campaign",
    brief: "A complete campaign brief used by the shared observation test fixture.",
    required_phrases: [],
    forbidden_phrases: [],
    require_ad_disclosure: true,
    terms_hash: hash("c"),
    status: "OPEN",
    application_deadline_epoch: 1_799_000_000,
    selection_deadline_epoch: 1_799_100_000,
    submission_deadline_epoch: 1_799_200_000,
    retention_seconds: 3_600,
    max_undetermined_retries: 3,
    fee_bps: 200,
    treasury: brand,
    budget_atto: "1000",
    available_atto: "700",
    reserved_atto: "100",
    settled_atto: "200",
    creator_paid_atto: "196",
    brand_refunded_atto: "0",
    fee_atto: "4",
    application_count: 2,
    assignment_count: 2,
    created_at_epoch: 1_798_000_000,
    closed_at_epoch: 0,
  };
  const campaign = parseCampaignState(campaignRaw);
  const claimables = [
    { account: creator, claimable_atto: "196", next_withdrawal_nonce: 0 },
    { account: brand, claimable_atto: "0", next_withdrawal_nonce: 0 },
  ].map((state) => ({
    account: state.account,
    claimableAtto: state.claimable_atto,
    nextWithdrawalNonce: state.next_withdrawal_nonce,
  }));
  const marker = {
    projectionId: hash("d"),
    assignmentId,
    campaignId,
    brandWallet: brand,
    creatorWallet: creator,
    contentSource: "X",
    maxUndeterminedRetries: 3,
    status: "SETTLED_PASS",
    resolutionRequestId: requestId,
    lastTxHash: transactionHash,
    finalizedAt: finalizedAt * 1_000,
    snapshotHash: canonicalHash(assignment),
    sharedProjectionPending: true,
    sharedProjectionAnchorTxHash: transactionHash,
    sharedProjectionObservationTicket: null,
  } as GenLayerAssignmentProjection;
  const campaignProjection = {
    campaignId,
    contractAddress: MARKETPLACE_V3_STUDIONET_ADDRESS,
    brandWallet: brand,
    clientNonce: campaign.clientNonce,
    contentSource: "X",
    termsHash: campaign.termsHash,
    budgetAtto: campaign.budgetAtto,
    availableAtto: "800",
    reservedAtto: "100",
    settledAtto: "100",
    creatorPaidAtto: "98",
    brandRefundedAtto: "0",
    feeAtto: "2",
    status: "OPEN",
    feeBps: campaign.feeBps,
    treasuryWallet: brand,
    applicationCount: 1,
    assignmentCount: 1,
    maxUndeterminedRetries: campaign.maxUndeterminedRetries,
    applicationDeadlineEpoch: campaign.applicationDeadlineEpoch,
    selectionDeadlineEpoch: campaign.selectionDeadlineEpoch,
    submissionDeadlineEpoch: campaign.submissionDeadlineEpoch,
    retentionSeconds: campaign.retentionSeconds,
    createdAtEpoch: campaign.createdAtEpoch,
  } as GenLayerCampaignProjection;
  const finalized: FinalizedMarketplaceTransaction = {
    hash: transactionHash,
    sender: brand,
    recipient: MARKETPLACE_V3_STUDIONET_ADDRESS,
    functionName: "resolve_assignment",
    args: [assignmentId, requestId],
    lifecycleStatus: "FINALIZED",
    executionResult: "SUCCESS",
    consensusResult: "MAJORITY_AGREE",
    valueAtto: "0",
    finalizedAt,
  };
  let readIndex = 0;
  const stableReader = async (method: string) => {
    if (method === "get_assignment") return assignmentRaw;
    if (method === "get_campaign") return campaignRaw;
    if (method === "get_claimable") {
      const claimable = claimables[readIndex % claimables.length]!;
      readIndex += 1;
      return {
        account: claimable.account,
        claimable_atto: claimable.claimableAtto,
        next_withdrawal_nonce: claimable.nextWithdrawalNonce,
      };
    }
    throw new Error(`Unexpected method ${method}`);
  };
  return {
    assignment,
    campaign,
    claimables,
    marker,
    campaignProjection,
    finalized,
    stableReader: stableReader as never,
  };
}
