import type {
  CAMPAIGN_SUBMITTER_METHOD,
  METRICS_SUBMITTER_METHOD,
  SUBMITTER_METHOD,
  SubmissionStatus,
} from "./constants";

export type OwnershipEnvelope = Readonly<{
  schemaVersion: 1;
  requestId: string;
  baseWallet: string;
  expectedHandle: string;
  postId: string;
  challenge: string;
  issuedAtEpoch: number;
  expiresAtEpoch: number;
  credentialExpiresAtEpoch: number;
}>;

export type CampaignEnvelope = Readonly<{
  schemaVersion: 1;
  kind: "CAMPAIGN";
  requestId: string;
  expectedHandle: string;
  postId: string;
  requiredPhrasesJson: string;
  forbiddenPhrasesJson: string;
  requireAdDisclosure: boolean;
  semanticBrief: string;
  resolveNotBeforeEpoch: number;
  assignmentId: number;
  agreementHash: string;
  submissionHash: string;
}>;

export type MetricsEnvelope = Readonly<{
  schemaVersion: 1;
  kind: "METRICS";
  requestId: string;
  baseWallet: string;
  identityHash: string;
  expectedHandle: string;
  metricsExpiresAtEpoch: number;
}>;

export type MetricsResultData = Readonly<{
  kind: "METRICS";
  request_id: string;
  base_wallet: string;
  identity_hash: string;
  handle: string;
  x_user_id: string;
  outcome: "VERIFIED";
  identity_match: true;
  protected: false;
  http_status: number;
  measured_at_epoch: number;
  metrics_expires_at_epoch: number;
  account_created_at_ms: number;
  followers: number;
  following: number;
  total_posts: number;
  posts_analyzed: number;
  median_likes: number;
  median_replies: number;
  median_reposts: number;
  median_views: number;
  engagement_rate_bps: number;
  engagement_consistency: "LOW_RISK" | "MEDIUM_RISK" | "HIGH_RISK" | "INSUFFICIENT";
}>;

export type SubmissionEnvelope = OwnershipEnvelope | CampaignEnvelope | MetricsEnvelope;
export type SubmitterFunctionName =
  | typeof SUBMITTER_METHOD
  | typeof CAMPAIGN_SUBMITTER_METHOD
  | typeof METRICS_SUBMITTER_METHOD;

export type QueueMessage = Readonly<{
  schemaVersion: 1;
  requestId: string;
}>;

export type ResolverOutcome =
  | "VERIFIED"
  | "REJECTED"
  | "PASS"
  | "FAIL"
  | "UNDETERMINED";

export type SubmissionRecord = Readonly<{
  requestId: string;
  network: string;
  resolver: string;
  envelope: SubmissionEnvelope | null;
  functionName: SubmitterFunctionName;
  envelopeFingerprint: string;
  callFingerprint: string;
  status: SubmissionStatus;
  lifecycleStatus: string | null;
  executionResult: string | null;
  resultOutcome: ResolverOutcome | null;
  resultData: MetricsResultData | null;
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

export type SubmissionProjection = Readonly<Omit<SubmissionRecord, "envelope" | "envelopeFingerprint" | "callFingerprint">>;

export type SignerClaim = Readonly<{
  requestId: string;
  holderId: string;
  fencingToken: bigint;
}>;

export type Receipt = Record<string, unknown>;

export interface StudioNetClient {
  readonly signerAddress: string;
  readExistingResult(requestId: string): Promise<unknown>;
  submitOwnership(envelope: OwnershipEnvelope): Promise<string>;
  submitCampaign(envelope: CampaignEnvelope): Promise<string>;
  submitMetrics(envelope: MetricsEnvelope): Promise<string>;
  getTransaction(txHash: string): Promise<Receipt>;
  readFinalResult(requestId: string): Promise<unknown>;
}

export type GenLayerReader = Pick<
  StudioNetClient,
  "signerAddress" | "getTransaction" | "readFinalResult"
> & Readonly<{ resolverAddress: string }>;

export interface SubmissionRepository {
  createOrReplay(envelope: SubmissionEnvelope, envelopeFingerprint: string, callFingerprint: string): Promise<{ record: SubmissionRecord; replayed: boolean }>;
  recordQueueAccepted(requestId: string, messageId: string | null): Promise<SubmissionRecord>;
  get(requestId: string): Promise<SubmissionRecord | null>;
  getProjection(requestId: string): Promise<SubmissionProjection | null>;
  claimPrecheck(requestId: string, holderId: string, leaseMs: number): Promise<SignerClaim | null>;
  failPrecheck(claim: SignerClaim, errorCode: string): Promise<void>;
  beginBroadcast(claim: SignerClaim): Promise<boolean>;
  recordSubmitted(claim: SignerClaim, txHash: string): Promise<SubmissionRecord>;
  quarantineBroadcast(claim: SignerClaim, errorCode: string): Promise<SubmissionRecord>;
  quarantineWithoutBroadcast(requestId: string, claim: SignerClaim, errorCode: string, resultOutcome?: ResolverOutcome | null): Promise<SubmissionRecord>;
  recordPoll(requestId: string, patch: PollPatch): Promise<SubmissionRecord>;
  markPoisoned(requestId: string, errorCode: string): Promise<void>;
  noteDelivery(requestId: string, deliveryCount: number): Promise<void>;
}

export type PollPatch = Readonly<{
  status?: SubmissionStatus;
  lifecycleStatus?: string | null;
  executionResult?: string | null;
  resultOutcome?: ResolverOutcome | null;
  resultData?: MetricsResultData | null;
  pollAttempts?: number;
  errorCode?: string | null;
  lastPolledAt?: Date | null;
  finalizedAt?: Date | null;
}>;
