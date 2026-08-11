import assert from "node:assert/strict";
import test from "node:test";
import { RelayProblem } from "../lib/problem";
import { settleFinalizedCampaignResolution } from "../lib/service";
import {
  configFixture,
  contextFixture,
  FakeRepository,
  FakeTransport,
  jobFixture,
  messageFixture,
  receiptTimeout,
  requestId,
  revalidateFixture,
  signaturesFixture,
  watcherAccounts,
} from "./helpers";

function deps(repository: FakeRepository, transport: FakeTransport, signatures = signaturesFixture()) {
  return {
    repository,
    transport,
    requestSignatures: async () => await signatures,
    revalidate: async () => await revalidateFixture(),
    nowMs: () => 3_000_000,
  };
}

test("coordinator obtains quorum, independently revalidates, simulates, broadcasts once, and confirms", async () => {
  const repository = new FakeRepository();
  const transport = new FakeTransport();
  const result = await settleFinalizedCampaignResolution({ requestId, config: configFixture(), dependencies: deps(repository, transport) });
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.broadcast, true);
  assert.deepEqual(repository.events, ["claim", "quorum", "simulated", "broadcasting", "hash", "confirmed"]);
  assert.deepEqual(transport.events, ["simulate", "broadcast", "receipt"]);
});

test("confirmed jobs are idempotent and never ask watchers or broadcast again", async () => {
  const repository = new FakeRepository();
  repository.claimResult = { kind: "CONFIRMED", job: jobFixture({ status: "CONFIRMED", baseTxHash: `0x${"99".repeat(32)}`, baseBlockNumber: "123" }) };
  const transport = new FakeTransport();
  let watcherCalls = 0;
  const result = await settleFinalizedCampaignResolution({
    requestId,
    config: configFixture(),
    dependencies: { repository, transport, requestSignatures: async () => { watcherCalls += 1; return []; } },
  });
  assert.equal(result.status, "CONFIRMED");
  assert.equal(watcherCalls, 0);
  assert.deepEqual(transport.events, []);
});

test("fewer than two distinct enabled signatures is retryable and never reaches simulation", async () => {
  const repository = new FakeRepository();
  const transport = new FakeTransport();
  await assert.rejects(settleFinalizedCampaignResolution({
    requestId,
    config: configFixture(),
    dependencies: deps(repository, transport, signaturesFixture(messageFixture(), [watcherAccounts[0]!])),
  }), (error: unknown) => (error as { code?: string }).code === "WATCHER_QUORUM_UNAVAILABLE");
  assert.deepEqual(repository.events, ["claim", "retryable"]);
  assert.deepEqual(transport.events, []);
});

test("duplicate, disabled, divergent, or tampered watcher signatures fail before simulation", async () => {
  const good = await signaturesFixture();
  const cases = [
    [good[0]!, good[0]!],
    [good[0]!, good[1]!, { ...good[2]!, signer: "0x5555555555555555555555555555555555555555" }],
    [good[0]!, { ...good[1]!, digest: `0x${"dd".repeat(32)}` }],
    [good[0]!, { ...good[1]!, message: messageFixture({ evidenceHash: `0x${"ee".repeat(32)}` }) }],
  ];
  for (const signatures of cases) {
    const repository = new FakeRepository();
    const transport = new FakeTransport();
    await assert.rejects(settleFinalizedCampaignResolution({
      requestId,
      config: configFixture(),
      dependencies: deps(repository, transport, Promise.resolve(signatures as never)),
    }), /Watcher|watcher/);
    assert.deepEqual(repository.events, ["claim", "failed"]);
    assert.deepEqual(transport.events, []);
  }
});

test("deterministic simulation rejection is terminal and cannot broadcast", async () => {
  const repository = new FakeRepository();
  const transport = new FakeTransport();
  transport.simulate = async () => { transport.events.push("simulate"); throw new RelayProblem(409, "BASE_SIMULATION_REJECTED", "rejected"); };
  await assert.rejects(settleFinalizedCampaignResolution({ requestId, config: configFixture(), dependencies: deps(repository, transport) }));
  assert.deepEqual(repository.events, ["claim", "quorum", "failed"]);
  assert.deepEqual(transport.events, ["simulate"]);
});

test("unknown broadcast result is permanently fenced for reconciliation", async () => {
  const repository = new FakeRepository();
  const transport = new FakeTransport();
  transport.broadcastError = new Error("RPC disconnected after send");
  await assert.rejects(settleFinalizedCampaignResolution({ requestId, config: configFixture(), dependencies: deps(repository, transport) }), (error: unknown) => (error as { code?: string }).code === "RECONCILIATION_REQUIRED");
  assert.deepEqual(repository.events, ["claim", "quorum", "simulated", "broadcasting", "reconciliation"]);
  assert.deepEqual(transport.events, ["simulate", "broadcast"]);
});

test("known tx with unknown receipt is reconciled by hash rather than rebroadcast", async () => {
  const repository = new FakeRepository();
  const transport = new FakeTransport();
  transport.receiptError = receiptTimeout();
  await assert.rejects(settleFinalizedCampaignResolution({ requestId, config: configFixture(), dependencies: deps(repository, transport) }));
  assert.deepEqual(repository.events, ["claim", "quorum", "simulated", "broadcasting", "hash", "reconciliation"]);
  assert.deepEqual(transport.events, ["simulate", "broadcast", "receipt"]);
});

test("a broadcast hash that cannot be persisted is still reconciliation-only", async () => {
  const repository = new FakeRepository();
  repository.recordBroadcastHash = async () => {
    repository.events.push("hash");
    throw new Error("database unavailable");
  };
  const transport = new FakeTransport();
  await assert.rejects(
    settleFinalizedCampaignResolution({ requestId, config: configFixture(), dependencies: deps(repository, transport) }),
    (error: unknown) => (error as { code?: string }).code === "RECONCILIATION_REQUIRED",
  );
  assert.deepEqual(repository.events, ["claim", "quorum", "simulated", "broadcasting", "hash", "reconciliation"]);
  assert.deepEqual(transport.events, ["simulate", "broadcast"]);
});

test("already-used Base request is reconciliation-only and never simulates", async () => {
  const repository = new FakeRepository(contextFixture());
  const transport = new FakeTransport();
  await assert.rejects(settleFinalizedCampaignResolution({
    requestId,
    config: configFixture(),
    dependencies: { ...deps(repository, transport), revalidate: async () => await revalidateFixture({ alreadyUsed: true }) },
  }), /consumed outside/);
  assert.deepEqual(repository.events, ["claim", "reconciliation"]);
  assert.deepEqual(transport.events, []);
});

test("broadcast feature gate completes simulation without loading or using the relayer signer", async () => {
  const repository = new FakeRepository();
  const transport = new FakeTransport();
  const result = await settleFinalizedCampaignResolution({ requestId, config: configFixture({ broadcastEnabled: false }), dependencies: deps(repository, transport) });
  assert.equal(result.status, "SIMULATED");
  assert.deepEqual(repository.events, ["claim", "quorum", "simulated"]);
  assert.deepEqual(transport.events, ["simulate"]);
});
