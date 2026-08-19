import type {
  EXPIRE_ASSIGNMENT,
  FINALIZE_CAMPAIGN,
  RESOLVE_ASSIGNMENT,
} from "./constants";

export type OperatorAction =
  | typeof RESOLVE_ASSIGNMENT
  | typeof EXPIRE_ASSIGNMENT
  | typeof FINALIZE_CAMPAIGN;

export type OperationRequest =
  | Readonly<{
      schemaVersion: 1;
      action: typeof RESOLVE_ASSIGNMENT;
      assignmentId: string;
      requestId: string;
    }>
  | Readonly<{
      schemaVersion: 1;
      action: typeof EXPIRE_ASSIGNMENT;
      assignmentId: string;
    }>
  | Readonly<{
      schemaVersion: 1;
      action: typeof FINALIZE_CAMPAIGN;
      campaignId: string;
    }>;

export type OperationEnvelope = Readonly<{
  schemaVersion: 1;
  operationId: string;
  network: "studionet";
  chainId: 61_999;
  contractAddress: string;
  action: OperatorAction;
  args: readonly string[];
  valueAtto: "0";
}>;

export type QueueMessage = Readonly<{
  schemaVersion: 1;
  operationId: string;
}>;

export type StateSnapshot = Readonly<{
  action: OperatorAction;
  assignment: Record<string, unknown> | null;
  campaign: Record<string, unknown> | null;
}>;

export type OperationStatus =
  | "QUEUED"
  | "PRECHECKING"
  | "PRECHECK_FAILED"
  | "BROADCASTING"
  | "SUBMITTED"
  | "POLLING"
  | "FINALIZED"
  | "EXECUTION_FAILED"
  | "NETWORK_TERMINATED"
  | "RECONCILIATION_REQUIRED"
  | "POLLING_EXHAUSTED"
  | "POISONED";

export type OperationRecord = Readonly<{
  operationId: string;
  network: string;
  chainId: number;
  contractAddress: string;
  action: OperatorAction;
  functionName: OperatorAction;
  valueAtto: string;
  envelope: OperationEnvelope | null;
  envelopeFingerprint: string;
  callFingerprint: string;
  preState: StateSnapshot | null;
  preStateFingerprint: string | null;
  postStateFingerprint: string | null;
  status: OperationStatus;
  lifecycleStatus: string | null;
  executionResult: string | null;
  txHash: string | null;
  queueMessageId: string | null;
  enqueueAttempts: number;
  deliveryCount: number;
  pollAttempts: number;
  errorCode: string | null;
  broadcastStartedAt: Date | null;
  submittedAt: Date | null;
  lastPolledAt: Date | null;
  finalizedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type OperationProjection = Readonly<Omit<
  OperationRecord,
  "envelope" | "envelopeFingerprint" | "callFingerprint" | "preState"
>>;

export type SignerClaim = Readonly<{
  operationId: string;
  holderId: string;
  fencingToken: bigint;
}>;

export type Receipt = Record<string, unknown>;

export type PollPatch = Readonly<{
  status?: OperationStatus;
  lifecycleStatus?: string | null;
  executionResult?: string | null;
  postStateFingerprint?: string | null;
  pollAttempts?: number;
  errorCode?: string | null;
  lastPolledAt?: Date | null;
  finalizedAt?: Date | null;
}>;

export interface OperatorRepository {
  createOrReplay(envelope: OperationEnvelope, envelopeFingerprint: string, callFingerprint: string): Promise<{ record: OperationRecord; replayed: boolean }>;
  recordQueueAccepted(operationId: string, messageId: string | null): Promise<OperationRecord>;
  get(operationId: string): Promise<OperationRecord | null>;
  getProjection(operationId: string): Promise<OperationProjection | null>;
  claimPrecheck(operationId: string, holderId: string, leaseMs: number): Promise<SignerClaim | null>;
  recordPreState(claim: SignerClaim, state: StateSnapshot, fingerprint: string): Promise<void>;
  failPrecheck(claim: SignerClaim, errorCode: string): Promise<void>;
  beginBroadcast(claim: SignerClaim): Promise<boolean>;
  recordSubmitted(claim: SignerClaim, txHash: string): Promise<OperationRecord>;
  quarantineBroadcast(claim: SignerClaim, errorCode: string): Promise<OperationRecord>;
  quarantineAmbiguousBroadcast(operationId: string, errorCode: string): Promise<OperationRecord>;
  quarantineWithoutBroadcast(claim: SignerClaim, errorCode: string): Promise<OperationRecord>;
  recordPoll(operationId: string, patch: PollPatch): Promise<OperationRecord>;
  markPoisoned(operationId: string, errorCode: string): Promise<void>;
  noteDelivery(operationId: string, deliveryCount: number): Promise<void>;
}

export interface MarketplaceClient {
  readonly signerAddress: string;
  readonly contractAddress: string;
  readState(envelope: OperationEnvelope, finalized: boolean): Promise<StateSnapshot>;
  submit(envelope: OperationEnvelope): Promise<string>;
  getTransaction(txHash: string): Promise<Receipt>;
}
