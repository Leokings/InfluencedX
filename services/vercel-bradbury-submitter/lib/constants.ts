export const SUBMITTER_SCHEMA_VERSION = 1 as const;
export const SUBMITTER_STAGE = "studionet" as const;
export const SUBMITTER_NETWORK = "studionet" as const;
export const STUDIONET_CHAIN_ID = 61_999 as const;
export const SUBMITTER_METHOD = "verify_ownership" as const;
export const CAMPAIGN_SUBMITTER_METHOD = "resolve_submission" as const;
export const METRICS_SUBMITTER_METHOD = "snapshot_metrics" as const;
export const SUBMITTER_METHODS = Object.freeze([
  SUBMITTER_METHOD,
  CAMPAIGN_SUBMITTER_METHOD,
  METRICS_SUBMITTER_METHOD,
]);
export const PINNED_STUDIONET_RESOLVER =
  "0x0913b5593Ff16974E2fd616cA678A4986Cb48600" as const;
export const STUDIONET_RESOLVER_DEPLOYMENT_TX =
  "0xc723b84f49e6842419ac926808d962c4611678b02fbb5b1b1cdba6fe94920591" as const;
export const STUDIONET_RPC_URL = "https://studio.genlayer.com/api" as const;
export const QUEUE_TOPIC = "influencedx-studionet-submissions-v1" as const;
// The singleton database gate name is a persisted compatibility boundary.
export const SIGNER_GATE = "bradbury-signer-v1" as const;

export const MIN_CHALLENGE_SECONDS = 5 * 60;
export const MAX_CHALLENGE_SECONDS = 60 * 60;
export const MIN_CREDENTIAL_SECONDS = 24 * 60 * 60;
export const MAX_CREDENTIAL_SECONDS = 90 * 24 * 60 * 60;
export const MAX_METRICS_SECONDS = 7 * 24 * 60 * 60;
export const X_EPOCH_MS = 1_288_834_974_657n;
export const MAX_REQUEST_BYTES = 4_096;
export const PRECHECK_LEASE_MS = 2 * 60 * 1_000;
export const POLL_INTERVAL_SECONDS = 30;
export const MAX_POLL_ATTEMPTS = 480;
export const QUEUE_RETENTION_SECONDS = 24 * 60 * 60;

export const TERMINAL_STATUSES = new Set<SubmissionStatus>([
  "FINALIZED",
  "EXECUTION_FAILED",
  "NETWORK_TERMINATED",
  "RECONCILIATION_REQUIRED",
  "POLLING_EXHAUSTED",
  "POISONED",
]);

export type SubmissionStatus =
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
