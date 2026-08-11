import type { Address, Hex } from "viem";

export type ResolutionOutcome = "PASS" | "FAIL" | "UNDETERMINED";
export type RelayStatus =
  | "PENDING"
  | "CLAIMED"
  | "QUORUM_READY"
  | "SIMULATED"
  | "BROADCASTING"
  | "CONFIRMED"
  | "RETRYABLE"
  | "RECONCILIATION_REQUIRED"
  | "FAILED";

export type ResolutionContext = Readonly<{
  applicationId: string;
  campaignRecordId: string;
  requestId: Hex;
  resolutionRound: number;
  assignmentId: string;
  campaignId: string;
  brand: Address;
  creator: Address;
  identityHash: Hex;
  agreementHash: Hex;
  submissionHash: Hex;
  postIdHash: Hex;
  xPostId: string;
  expectedHandle: string;
  termsDocument: Readonly<Record<string, unknown>>;
  genlayerTxHash: Hex;
  expectedOutcome: ResolutionOutcome;
}>;

export type WatcherRequest = Readonly<{
  schemaVersion: 1;
  requestId: Hex;
  genlayerTxHash: Hex;
  binding: Readonly<{
    campaignId: string;
    assignmentId: string;
    brand: Address;
    creator: Address;
    identityHash: Hex;
    agreementHash: Hex;
    submissionHash: Hex;
    postIdHash: Hex;
    termsDocument: Readonly<Record<string, unknown>>;
    submissionDocument: Readonly<Record<string, unknown>>;
  }>;
}>;

export type SerializedResolutionMessage = Readonly<{
  requestId: Hex;
  assignmentId: string;
  outcome: number;
  evidenceHash: Hex;
  genlayerContract: Hex;
  genlayerTxHash: Hex;
  resolvedAt: string;
  relayDeadline: string;
}>;

export type WatcherSignature = Readonly<{
  schemaVersion: 1;
  requestId: Hex;
  signer: Address;
  digest: Hex;
  signature: Hex;
  message: SerializedResolutionMessage;
}>;

export type RelayJob = Readonly<{
  requestId: Hex;
  applicationId: string;
  resolutionRound: number;
  assignmentId: string;
  genlayerTxHash: Hex;
  expectedOutcome: ResolutionOutcome;
  status: RelayStatus;
  fenceToken: string | null;
  leaseExpiresAt: number | null;
  attemptCount: number;
  quorumDigest: Hex | null;
  signerAddresses: readonly Address[];
  baseTxHash: Hex | null;
  baseBlockNumber: string | null;
  errorCode: string | null;
}>;

export type ClaimedResolution = Readonly<{
  job: RelayJob;
  context: ResolutionContext;
  fenceToken: string;
}>;
