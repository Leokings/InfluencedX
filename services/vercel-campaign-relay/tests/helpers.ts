import {
  getAddress,
  hashTypedData,
  padHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { BaseSettlementTransport, PreparedSettlement } from "../lib/base-settlement";
import type { RelayConfig } from "../lib/config";
import {
  BASE_SEPOLIA_ESCROW,
  BASE_SEPOLIA_RECEIVER,
  GENLAYER_NETWORK,
  STUDIONET_CHAIN_ID,
  STUDIONET_RESOLVER,
  STUDIONET_RPC_URL,
} from "../lib/constants";
import { RelayProblem } from "../lib/problem";
import { typed, type VerifiedQuorum } from "../lib/quorum";
import type { ClaimResult, ResolutionRepository } from "../lib/repository";
import type {
  ClaimedResolution,
  RelayJob,
  ResolutionContext,
  SerializedResolutionMessage,
  WatcherSignature,
} from "../lib/types";

export const watcherKeys = ["11", "22", "33"].map((byte) => `0x${byte.repeat(32)}` as Hex);
export const watcherAccounts = watcherKeys.map((key) => privateKeyToAccount(key));
export const relayerKey = `0x${"44".repeat(32)}` as Hex;
export const relayerAddress = privateKeyToAccount(relayerKey).address;
export const requestId = `0x${"aa".repeat(32)}` as Hex;
export const genlayerTxHash = `0x${"bb".repeat(32)}` as Hex;
export const evidenceHash = `0x${"cc".repeat(32)}` as Hex;

export function configFixture(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return Object.freeze({
    databaseUrl: "postgresql://user:password@db.example.test/db?sslmode=require",
    baseRpcUrl: "https://base.example.test/",
    genlayerNetwork: GENLAYER_NETWORK,
    genlayerChainId: STUDIONET_CHAIN_ID,
    genlayerRpcUrl: STUDIONET_RPC_URL,
    escrow: BASE_SEPOLIA_ESCROW,
    receiver: BASE_SEPOLIA_RECEIVER,
    resolver: STUDIONET_RESOLVER,
    broadcastEnabled: true,
    relayerPrivateKey: relayerKey,
    relayerAddress,
    relayerMaxBalanceWei: 10_000_000_000_000_000n,
    serviceToken: "r".repeat(40),
    watchers: Object.freeze(watcherAccounts.map((account, index) => Object.freeze({
      origin: `https://watcher-${index + 1}.example.test`,
      address: account.address,
      serviceToken: String(index + 1).repeat(40),
    }))) as RelayConfig["watchers"],
    caller: Object.freeze({
      teamSlug: "influencedx",
      teamId: "team_123",
      projectName: "influencedx-web",
      projectId: "prj_123",
      environment: "preview",
    }),
    ...overrides,
  }) as RelayConfig;
}

export function contextFixture(overrides: Partial<ResolutionContext> = {}): ResolutionContext {
  return Object.freeze({
    applicationId: "11111111-1111-4111-8111-111111111111",
    campaignRecordId: "22222222-2222-4222-8222-222222222222",
    requestId,
    resolutionRound: 1,
    assignmentId: "9",
    campaignId: "7",
    brand: getAddress("0x1111111111111111111111111111111111111111"),
    creator: getAddress("0x2222222222222222222222222222222222222222"),
    identityHash: `0x${"55".repeat(32)}`,
    agreementHash: `0x${"66".repeat(32)}`,
    submissionHash: `0x${"77".repeat(32)}`,
    postIdHash: `0x${"88".repeat(32)}`,
    xPostId: "20864108500280",
    expectedHandle: "creator_x",
    termsDocument: Object.freeze({ schemaVersion: 1, network: "base-sepolia" }),
    genlayerTxHash,
    expectedOutcome: "PASS",
    ...overrides,
  });
}

export function messageFixture(overrides: Partial<SerializedResolutionMessage> = {}): SerializedResolutionMessage {
  return Object.freeze({
    requestId,
    assignmentId: "9",
    outcome: 1,
    evidenceHash,
    genlayerContract: padHex(STUDIONET_RESOLVER, { size: 32 }).toLowerCase() as Hex,
    genlayerTxHash,
    resolvedAt: "2000",
    relayDeadline: "606800",
    ...overrides,
  });
}

export async function signaturesFixture(
  message = messageFixture(),
  accounts = watcherAccounts,
): Promise<WatcherSignature[]> {
  const definition = typed(message, BASE_SEPOLIA_RECEIVER);
  const digest = hashTypedData(definition);
  return Promise.all(accounts.map(async (account) => Object.freeze({
    schemaVersion: 1 as const,
    requestId: message.requestId,
    signer: account.address,
    digest,
    signature: await account.signTypedData(definition),
    message,
  })));
}

export function jobFixture(overrides: Partial<RelayJob> = {}): RelayJob {
  return Object.freeze({
    requestId,
    applicationId: contextFixture().applicationId,
    resolutionRound: 1,
    assignmentId: "9",
    genlayerTxHash,
    expectedOutcome: "PASS",
    status: "CLAIMED",
    fenceToken: "fence-1",
    leaseExpiresAt: 100_000,
    attemptCount: 1,
    quorumDigest: null,
    signerAddresses: [],
    baseTxHash: null,
    baseBlockNumber: null,
    errorCode: null,
    ...overrides,
  });
}

export class FakeRepository implements ResolutionRepository {
  events: string[] = [];
  claimResult: ClaimResult;
  constructor(context = contextFixture()) {
    const value: ClaimedResolution = Object.freeze({ job: jobFixture(), context, fenceToken: "fence-1" });
    this.claimResult = Object.freeze({ kind: "CLAIMED", value });
  }
  async claim(): Promise<ClaimResult> { this.events.push("claim"); return this.claimResult; }
  async recordQuorum(): Promise<void> { this.events.push("quorum"); }
  async recordSimulated(): Promise<void> { this.events.push("simulated"); }
  async markBroadcasting(): Promise<void> { this.events.push("broadcasting"); }
  async recordBroadcastHash(): Promise<void> { this.events.push("hash"); }
  async recordConfirmed(): Promise<void> { this.events.push("confirmed"); }
  async markRetryable(): Promise<void> { this.events.push("retryable"); }
  async markFailed(): Promise<void> { this.events.push("failed"); }
  async markReconciliation(): Promise<void> { this.events.push("reconciliation"); }
}

export class FakeTransport implements BaseSettlementTransport {
  events: string[] = [];
  broadcastError: Error | null = null;
  receiptError: Error | null = null;
  async simulate(quorum: VerifiedQuorum): Promise<PreparedSettlement> {
    this.events.push("simulate");
    return Object.freeze({ request: {}, account: relayerAddress, requestId, assignmentId: BigInt(quorum.message.assignmentId), outcome: "PASS", evidenceHash: quorum.message.evidenceHash });
  }
  async broadcast(): Promise<Hex> {
    this.events.push("broadcast");
    if (this.broadcastError) throw this.broadcastError;
    return `0x${"99".repeat(32)}`;
  }
  async waitAndVerify(): Promise<{ blockNumber: string }> {
    this.events.push("receipt");
    if (this.receiptError) throw this.receiptError;
    return { blockNumber: "123" };
  }
}

export const revalidateFixture = async (overrides: { alreadyUsed?: boolean; message?: SerializedResolutionMessage; threshold?: number; enabled?: ReadonlySet<string> } = {}) => Object.freeze({
  message: overrides.message ?? messageFixture(),
  threshold: overrides.threshold ?? 2,
  enabledWatchers: overrides.enabled ?? new Set(watcherAccounts.map((account) => account.address.toLowerCase())),
  alreadyUsed: overrides.alreadyUsed ?? false,
});

export function receiptTimeout(): RelayProblem {
  return new RelayProblem(409, "RECEIPT_RECONCILIATION_REQUIRED", "timeout");
}
