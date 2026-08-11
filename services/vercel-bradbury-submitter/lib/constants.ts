export const SUBMITTER_SCHEMA_VERSION = 1 as const;
export const SUBMITTER_STAGE = "testnet" as const;
export const SUBMITTER_NETWORK = "testnet-bradbury" as const;
export const SUBMITTER_METHOD = "verify_ownership" as const;
export const CAMPAIGN_SUBMITTER_METHOD = "resolve_submission" as const;
export const METRICS_SUBMITTER_METHOD = "snapshot_metrics" as const;
export const SUBMITTER_METHODS = Object.freeze([
  SUBMITTER_METHOD,
  CAMPAIGN_SUBMITTER_METHOD,
  METRICS_SUBMITTER_METHOD,
]);
export const PINNED_BRADBURY_RESOLVER =
  "0x017311b35dbB9802883bDaE7Fb0Efd7Bd77cB0b2" as const;
export const BRADBURY_RPC_URL = "https://rpc-bradbury.genlayer.com" as const;
export const QUEUE_TOPIC = "xproof-bradbury-ownership-v1" as const;
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
