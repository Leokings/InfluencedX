import type { ReconcilerConfig } from "../lib/config";
import {
  CONFIRM_METHOD,
  MARKETPLACE_ADDRESS,
  MARKETPLACE_OWNER,
  MARKETPLACE_PROTOCOL,
  MARKETPLACE_SCHEMA_VERSION,
  PRECHECK_LEASE_MS,
  RECONCILER_NETWORK,
  STUDIONET_CHAIN_ID,
  STUDIONET_RPC_URL,
} from "../lib/constants";
import { fingerprint, requestFingerprint } from "../lib/envelope";
import { ReconcilerProblem } from "../lib/problem";
import type { QueuePublisher } from "../lib/queue-publisher";
import type {
  MarketplaceCounts,
  Receipt,
  ReconciliationProjection,
  ReconciliationRecord,
  ReconciliationRepository,
  ReconciliationRequest,
  SignerClaim,
  TransferDiscovery,
  TransferProof,
  WithdrawalClient,
  WithdrawalState,
} from "../lib/types";

export const NOW_EPOCH = 1_787_052_000;
export const WITHDRAWAL_ID = `0x${"12".repeat(32)}`;
export const PARENT_TX = `0x${"34".repeat(32)}`;
export const CHILD_TX = `0x${"56".repeat(32)}`;
export const CONFIRM_TX = `0x${"78".repeat(32)}`;
export const RECIPIENT = `0x${"9a".repeat(20)}`;

export function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    INFLUENCEDX_WITHDRAWAL_RECONCILER_ENABLED: "true",
    INFLUENCEDX_WITHDRAWAL_RECONCILER_STAGE: "studionet",
    INFLUENCEDX_GENLAYER_NETWORK: RECONCILER_NETWORK,
    INFLUENCEDX_GENLAYER_CHAIN_ID: String(STUDIONET_CHAIN_ID),
    INFLUENCEDX_GENLAYER_RPC_URL: STUDIONET_RPC_URL,
    INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS: MARKETPLACE_ADDRESS,
    INFLUENCEDX_GENLAYER_MARKETPLACE_OWNER: MARKETPLACE_OWNER,
    INFLUENCEDX_GENLAYER_MARKETPLACE_PROTOCOL: MARKETPLACE_PROTOCOL,
    INFLUENCEDX_GENLAYER_MARKETPLACE_SCHEMA_VERSION: String(MARKETPLACE_SCHEMA_VERSION),
    GENLAYER_WITHDRAWAL_OWNER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    DATABASE_URL: "postgresql://example.invalid/influencedx",
    INFLUENCEDX_WITHDRAWAL_RECONCILER_SERVICE_TOKEN: "aa".repeat(32),
    INFLUENCEDX_WITHDRAWAL_CALLER_TEAM_SLUG: "leokings588-5902s-projects",
    INFLUENCEDX_WITHDRAWAL_CALLER_TEAM_ID: "team_exact",
    INFLUENCEDX_WITHDRAWAL_CALLER_PROJECT_NAME: "influencedx",
    INFLUENCEDX_WITHDRAWAL_CALLER_PROJECT_ID: "prj_exact",
    INFLUENCEDX_WITHDRAWAL_CALLER_ENVIRONMENT: "preview",
    ...overrides,
  };
}

export function configFixture(): ReconcilerConfig {
  return {
    enabled: true,
    stage: "studionet",
    network: "studionet",
    chainId: STUDIONET_CHAIN_ID,
    rpcUrl: STUDIONET_RPC_URL,
    contractAddress: MARKETPLACE_ADDRESS,
    contractOwner: MARKETPLACE_OWNER,
    contractProtocol: MARKETPLACE_PROTOCOL,
    contractSchemaVersion: MARKETPLACE_SCHEMA_VERSION,
    privateKey: `0x${"11".repeat(32)}`,
    databaseUrl: "postgresql://example.invalid/influencedx",
    serviceToken: "aa".repeat(32),
    caller: {
      teamSlug: "leokings588-5902s-projects",
      teamId: "team_exact",
      projectName: "influencedx",
      projectId: "prj_exact",
      environment: "preview",
    },
  };
}

export function request(withdrawalId = WITHDRAWAL_ID): ReconciliationRequest {
  return Object.freeze({ schemaVersion: 1, withdrawalId });
}

export function emittedWithdrawal(overrides: Partial<WithdrawalState> = {}): WithdrawalState {
  return Object.freeze({
    withdrawalId: WITHDRAWAL_ID,
    account: RECIPIENT,
    nonce: 0,
    amountAtto: "100",
    status: "EMITTED_UNCONFIRMED",
    requestedAtEpoch: NOW_EPOCH - 120,
    emittedAtEpoch: NOW_EPOCH - 60,
    reconciledAtEpoch: 0,
    evidenceHash: `0x${"0".repeat(64)}`,
    recapitalizedAtto: "0",
    ...overrides,
  });
}

export function countsBefore(overrides: Partial<MarketplaceCounts> = {}): MarketplaceCounts {
  return Object.freeze({
    withdrawalCount: "1",
    totalEscrowAtto: "900",
    totalClaimableAtto: "300",
    totalPendingWithdrawalAtto: "0",
    totalEmittedUnconfirmedAtto: "100",
    totalLiabilityAtto: "1300",
    totalProtocolFeesAtto: "10",
    totalWithdrawnAtto: "0",
    totalRecapitalizedAtto: "0",
    contractBalanceAtto: "1200",
    ...overrides,
  });
}

export function countsAfter(overrides: Partial<MarketplaceCounts> = {}): MarketplaceCounts {
  return Object.freeze({
    ...countsBefore(),
    totalEmittedUnconfirmedAtto: "0",
    totalLiabilityAtto: "1200",
    totalWithdrawnAtto: "100",
    ...overrides,
  });
}

export function transferProof(overrides: Partial<TransferProof> = {}): TransferProof {
  const base = {
    schemaVersion: 1 as const,
    domain: "influencedx-withdrawal-transfer-evidence-v1" as const,
    network: "studionet" as const,
    chainId: STUDIONET_CHAIN_ID,
    contractAddress: MARKETPLACE_ADDRESS,
    withdrawalId: WITHDRAWAL_ID,
    account: RECIPIENT,
    amountAtto: "100",
    emittedAtEpoch: NOW_EPOCH - 60,
    parentTxHash: PARENT_TX,
    childTxHash: CHILD_TX,
    valueCredited: true as const,
  };
  return Object.freeze({ ...base, evidenceHash: fingerprint(base), ...overrides });
}

export function confirmationReceipt(overrides: Receipt = {}): Receipt {
  const proof = transferProof();
  return {
    hash: CONFIRM_TX,
    sender: MARKETPLACE_OWNER,
    recipient: MARKETPLACE_ADDRESS,
    rawValueAtto: "0",
    statusName: "FINALIZED",
    resultName: "MAJORITY_AGREE",
    consensus_data: {
      leader_receipt: [
        { mode: "leader", execution_result: "SUCCESS", result: { status: "return" } },
        { mode: "validator", execution_result: "SUCCESS", result: { status: "return" } },
      ],
    },
    tx_data_decoded: { call_data: { method: CONFIRM_METHOD, args: [WITHDRAWAL_ID, proof.evidenceHash] } },
    ...overrides,
  };
}

export class FakeQueue implements QueuePublisher {
  submits: Array<{ withdrawalId: string; generation: number }> = [];
  discoveries: Array<{ withdrawalId: string; attempt: number }> = [];
  polls: Array<{ withdrawalId: string; attempt: number }> = [];
  async submit(withdrawalId: string, generation: number) {
    this.submits.push({ withdrawalId, generation });
    return `submit-${this.submits.length}`;
  }
  async discover(withdrawalId: string, attempt: number) {
    this.discoveries.push({ withdrawalId, attempt });
    return `discover-${this.discoveries.length}`;
  }
  async poll(withdrawalId: string, attempt: number) {
    this.polls.push({ withdrawalId, attempt });
    return `poll-${this.polls.length}`;
  }
}

export class FakeClient implements WithdrawalClient {
  readonly signerAddress = MARKETPLACE_OWNER;
  readonly contractAddress = MARKETPLACE_ADDRESS;
  withdrawal: WithdrawalState | null = emittedWithdrawal();
  finalWithdrawal: WithdrawalState | null = emittedWithdrawal({
    status: "CONFIRMED",
    reconciledAtEpoch: NOW_EPOCH + 30,
    evidenceHash: transferProof().evidenceHash,
  });
  beforeCounts = countsBefore();
  afterCounts = countsAfter();
  discovery: TransferDiscovery = { kind: "PROVEN", proof: transferProof() };
  receipt: Receipt = confirmationReceipt();
  submitError: Error | null = null;
  submitBarrier: Promise<void> | null = null;
  submitted = false;
  submitCalls: Array<{ withdrawalId: string; evidenceHash: string }> = [];
  stateError: Error | null = null;
  async readWithdrawal() {
    if (this.stateError) throw this.stateError;
    return this.submitted ? this.finalWithdrawal : this.withdrawal;
  }
  async readCounts() {
    if (this.stateError) throw this.stateError;
    return this.submitted ? this.afterCounts : this.beforeCounts;
  }
  async discoverTransfer() { return this.discovery; }
  async submitConfirmation(withdrawalId: string, evidenceHash: string) {
    this.submitCalls.push({ withdrawalId, evidenceHash });
    if (this.submitBarrier) await this.submitBarrier;
    if (this.submitError) throw this.submitError;
    this.submitted = true;
    return CONFIRM_TX;
  }
  async getTransaction() { return this.receipt; }
}

export class MemoryRepository implements ReconciliationRepository {
  records = new Map<string, ReconciliationRecord>();
  failRecordSubmitted = false;
  private gate: { token: bigint; holder: string | null; withdrawalId: string | null; phase: "PRECHECKING" | "BROADCASTING" | null; expires: number | null } = {
    token: 0n, holder: null, withdrawalId: null, phase: null, expires: null,
  };

  async createOrReplay(input: ReconciliationRequest, fingerprintValue: string) {
    const current = this.records.get(input.withdrawalId);
    if (current) {
      if (current.requestFingerprint !== fingerprintValue) throw new ReconcilerProblem(409, "WITHDRAWAL_ID_COLLISION", "collision");
      return { record: current, replayed: true };
    }
    const now = new Date();
    const record: ReconciliationRecord = Object.freeze({
      withdrawalId: input.withdrawalId,
      requestFingerprint: fingerprintValue,
      network: RECONCILER_NETWORK,
      chainId: STUDIONET_CHAIN_ID,
      contractAddress: MARKETPLACE_ADDRESS,
      contractOwner: MARKETPLACE_OWNER,
      functionName: CONFIRM_METHOD,
      valueAtto: "0",
      status: "QUEUED",
      withdrawal: null,
      countsBefore: null,
      proof: null,
      proofFingerprint: null,
      evidenceHash: null,
      transferParentTxHash: null,
      transferChildTxHash: null,
      confirmationTxHash: null,
      lifecycleStatus: null,
      executionResult: null,
      queueMessageId: null,
      enqueueAttempts: 0,
      deliveryCount: 0,
      discoveryAttempts: 0,
      pollAttempts: 0,
      errorCode: null,
      broadcastStartedAt: null,
      submittedAt: null,
      lastCheckedAt: null,
      finalizedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    this.records.set(input.withdrawalId, record);
    return { record, replayed: false };
  }
  async seed(input = request()) {
    return (await this.createOrReplay(input, requestFingerprint(input, configFixture()))).record;
  }
  async recordQueueAccepted(id: string, messageId: string | null) {
    const current = this.required(id);
    return this.patch(id, { queueMessageId: current.queueMessageId ?? messageId, enqueueAttempts: current.enqueueAttempts + 1 });
  }
  async get(id: string) { return this.records.get(id) ?? null; }
  async getProjection(id: string): Promise<ReconciliationProjection | null> {
    const record = this.records.get(id);
    return record ? projectRecord(record) : null;
  }
  async noteDelivery(id: string, count: number) {
    const record = this.records.get(id);
    if (record) this.patch(id, { deliveryCount: Math.max(record.deliveryCount, count) });
  }
  async recordWaiting(id: string, status: "WAITING_FOR_EMISSION" | "WAITING_FOR_TRANSFER", errorCode: string, checkedAt: Date) {
    const record = this.required(id);
    return this.patch(id, { status, errorCode, lastCheckedAt: checkedAt, discoveryAttempts: record.discoveryAttempts + 1 });
  }
  async requireManual(id: string, errorCode: string) { return this.patch(id, { status: "RECONCILIATION_REQUIRED", errorCode }); }
  async claimProof(id: string, holderId: string, leaseMs: number) {
    if (leaseMs !== PRECHECK_LEASE_MS) throw new Error("lease");
    const expired = this.gate.phase === "PRECHECKING" && this.gate.expires !== null && this.gate.expires <= Date.now();
    if (this.gate.withdrawalId && !expired) return null;
    this.gate = { token: this.gate.token + 1n, holder: holderId, withdrawalId: id, phase: "PRECHECKING", expires: Date.now() + leaseMs };
    this.patch(id, { status: "PROOF_VERIFIED", errorCode: null });
    return { withdrawalId: id, holderId, fencingToken: this.gate.token };
  }
  async recordProof(claim: SignerClaim, withdrawal: WithdrawalState, counts: MarketplaceCounts, proof: TransferProof, proofFp: string) {
    this.assertClaim(claim, "PRECHECKING");
    this.patch(claim.withdrawalId, {
      withdrawal, countsBefore: counts, proof, proofFingerprint: proofFp,
      evidenceHash: proof.evidenceHash, transferParentTxHash: proof.parentTxHash, transferChildTxHash: proof.childTxHash,
    });
  }
  async releasePrecheck(claim: SignerClaim, errorCode: string) {
    this.assertClaim(claim, "PRECHECKING");
    this.patch(claim.withdrawalId, { status: "WAITING_FOR_TRANSFER", errorCode });
    this.release();
  }
  async beginBroadcast(claim: SignerClaim) {
    if (!this.hasClaim(claim, "PRECHECKING")) return false;
    this.gate.phase = "BROADCASTING";
    this.gate.expires = null;
    this.patch(claim.withdrawalId, { status: "BROADCASTING", broadcastStartedAt: new Date() });
    return true;
  }
  async recordSubmitted(claim: SignerClaim, txHash: string) {
    this.assertClaim(claim, "BROADCASTING");
    if (this.failRecordSubmitted) throw new Error("simulated database crash");
    const value = this.patch(claim.withdrawalId, { status: "SUBMITTED", confirmationTxHash: txHash, submittedAt: new Date() });
    this.release();
    return value;
  }
  async quarantineBroadcast(claim: SignerClaim, errorCode: string) {
    this.assertClaim(claim, "BROADCASTING");
    return this.patch(claim.withdrawalId, { status: "RECONCILIATION_REQUIRED", errorCode });
  }
  async quarantineAmbiguousBroadcast(id: string, errorCode: string) { return this.patch(id, { status: "RECONCILIATION_REQUIRED", errorCode }); }
  async recordPoll(id: string, patch: Parameters<ReconciliationRepository["recordPoll"]>[1]) { return this.patch(id, patch as Partial<ReconciliationRecord>); }
  async markPoisoned(id: string, errorCode: string) {
    if (this.records.has(id)) this.patch(id, { status: "POISONED", errorCode });
  }
  patchForTest(id: string, patch: Partial<ReconciliationRecord>) { return this.patch(id, patch); }
  private patch(id: string, patch: Partial<ReconciliationRecord>) {
    const value = Object.freeze({ ...this.required(id), ...patch, updatedAt: new Date() });
    this.records.set(id, value);
    return value;
  }
  private required(id: string) {
    const value = this.records.get(id);
    if (!value) throw new Error("missing record");
    return value;
  }
  private hasClaim(claim: SignerClaim, phase: "PRECHECKING" | "BROADCASTING") {
    return this.gate.holder === claim.holderId && this.gate.withdrawalId === claim.withdrawalId && this.gate.token === claim.fencingToken && this.gate.phase === phase;
  }
  private assertClaim(claim: SignerClaim, phase: "PRECHECKING" | "BROADCASTING") {
    if (!this.hasClaim(claim, phase)) throw new Error("fence lost");
  }
  private release() { this.gate = { ...this.gate, holder: null, withdrawalId: null, phase: null, expires: null }; }
}

function projectRecord(record: ReconciliationRecord): ReconciliationProjection {
  const { requestFingerprint: _a, withdrawal: _b, countsBefore: _c, proof: _d, proofFingerprint: _e, ...value } = record;
  return value;
}
