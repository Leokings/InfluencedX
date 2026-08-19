export type ReconciliationRequest = Readonly<{ schemaVersion: 1; withdrawalId: string }>;
export type QueueMessage = ReconciliationRequest;

export type WithdrawalState = Readonly<{
  withdrawalId: string;
  account: string;
  nonce: number;
  amountAtto: string;
  status: "PENDING" | "EMITTED_UNCONFIRMED" | "CONFIRMED" | "RESTORED_FAILED";
  requestedAtEpoch: number;
  emittedAtEpoch: number;
  reconciledAtEpoch: number;
  evidenceHash: string;
  recapitalizedAtto: string;
}>;

export type MarketplaceCounts = Readonly<{
  withdrawalCount: string;
  totalEscrowAtto: string;
  totalClaimableAtto: string;
  totalPendingWithdrawalAtto: string;
  totalEmittedUnconfirmedAtto: string;
  totalLiabilityAtto: string;
  totalProtocolFeesAtto: string;
  totalWithdrawnAtto: string;
  totalRecapitalizedAtto: string;
  contractBalanceAtto: string;
}>;

export type TransferProof = Readonly<{
  schemaVersion: 1;
  domain: "influencedx-withdrawal-transfer-evidence-v1";
  network: "studionet";
  chainId: 61_999;
  contractAddress: string;
  withdrawalId: string;
  account: string;
  amountAtto: string;
  emittedAtEpoch: number;
  parentTxHash: string;
  childTxHash: string;
  valueCredited: true;
  evidenceHash: string;
}>;

export type TransferDiscovery =
  | Readonly<{ kind: "PENDING"; code: string }>
  | Readonly<{ kind: "PROVEN"; proof: TransferProof }>
  | Readonly<{ kind: "MANUAL"; code: string }>;

export type ReconciliationStatus =
  | "QUEUED" | "WAITING_FOR_EMISSION" | "WAITING_FOR_TRANSFER" | "PROOF_VERIFIED"
  | "BROADCASTING" | "SUBMITTED" | "POLLING" | "FINALIZED"
  | "RECONCILIATION_REQUIRED" | "POLLING_EXHAUSTED" | "POISONED";

export type ReconciliationRecord = Readonly<{
  withdrawalId: string;
  requestFingerprint: string;
  network: string;
  chainId: number;
  contractAddress: string;
  withdrawalConfirmer: string;
  functionName: "confirm_withdrawal";
  valueAtto: "0";
  status: ReconciliationStatus;
  withdrawal: WithdrawalState | null;
  countsBefore: MarketplaceCounts | null;
  proof: TransferProof | null;
  proofFingerprint: string | null;
  evidenceHash: string | null;
  transferParentTxHash: string | null;
  transferChildTxHash: string | null;
  confirmationTxHash: string | null;
  lifecycleStatus: string | null;
  executionResult: string | null;
  queueMessageId: string | null;
  enqueueAttempts: number;
  deliveryCount: number;
  discoveryAttempts: number;
  pollAttempts: number;
  errorCode: string | null;
  broadcastStartedAt: Date | null;
  submittedAt: Date | null;
  lastCheckedAt: Date | null;
  finalizedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type ReconciliationProjection = Readonly<Omit<
  ReconciliationRecord,
  "requestFingerprint" | "withdrawal" | "countsBefore" | "proof" | "proofFingerprint"
>>;

export type SignerClaim = Readonly<{ withdrawalId: string; holderId: string; fencingToken: bigint }>;
export type Receipt = Record<string, unknown>;

export interface ReconciliationRepository {
  createOrReplay(request: ReconciliationRequest, requestFingerprint: string): Promise<{ record: ReconciliationRecord; replayed: boolean }>;
  recordQueueAccepted(withdrawalId: string, messageId: string | null): Promise<ReconciliationRecord>;
  get(withdrawalId: string): Promise<ReconciliationRecord | null>;
  getProjection(withdrawalId: string): Promise<ReconciliationProjection | null>;
  noteDelivery(withdrawalId: string, deliveryCount: number): Promise<void>;
  recordWaiting(withdrawalId: string, status: "WAITING_FOR_EMISSION" | "WAITING_FOR_TRANSFER", errorCode: string, checkedAt: Date): Promise<ReconciliationRecord>;
  requireManual(withdrawalId: string, errorCode: string): Promise<ReconciliationRecord>;
  claimProof(withdrawalId: string, holderId: string, leaseMs: number): Promise<SignerClaim | null>;
  recordProof(claim: SignerClaim, withdrawal: WithdrawalState, counts: MarketplaceCounts, proof: TransferProof, proofFingerprint: string): Promise<void>;
  releasePrecheck(claim: SignerClaim, errorCode: string): Promise<void>;
  beginBroadcast(claim: SignerClaim): Promise<boolean>;
  recordSubmitted(claim: SignerClaim, txHash: string): Promise<ReconciliationRecord>;
  quarantineBroadcast(claim: SignerClaim, errorCode: string): Promise<ReconciliationRecord>;
  quarantineAmbiguousBroadcast(withdrawalId: string, errorCode: string): Promise<ReconciliationRecord>;
  recordPoll(withdrawalId: string, patch: Readonly<Partial<Pick<ReconciliationRecord,
    "status" | "lifecycleStatus" | "executionResult" | "pollAttempts" | "errorCode" | "lastCheckedAt" | "finalizedAt"
  >>>): Promise<ReconciliationRecord>;
  markPoisoned(withdrawalId: string, errorCode: string): Promise<void>;
}

export interface WithdrawalClient {
  readonly signerAddress: string;
  readonly contractAddress: string;
  readWithdrawal(withdrawalId: string): Promise<WithdrawalState | null>;
  readCounts(): Promise<MarketplaceCounts>;
  discoverTransfer(withdrawal: WithdrawalState, nowEpoch: number): Promise<TransferDiscovery>;
  submitConfirmation(withdrawalId: string, evidenceHash: string): Promise<string>;
  getTransaction(txHash: string): Promise<Receipt>;
}
