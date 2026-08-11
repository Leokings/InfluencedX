export const SUBMITTER_SCHEMA_VERSION = 1;
export const SUBMITTER_NETWORK = 'testnet-bradbury';
export const SUBMITTER_STAGE = 'testnet';
export const SUBMITTER_METHOD = 'verify_ownership';
export const PINNED_BRADBURY_RESOLVER = '0x017311b35dbB9802883bDaE7Fb0Efd7Bd77cB0b2';
export const BRADBURY_RPC_URL = 'https://rpc-bradbury.genlayer.com';

export const MIN_CHALLENGE_SECONDS = 5 * 60;
export const MAX_CHALLENGE_SECONDS = 60 * 60;
export const MIN_CREDENTIAL_SECONDS = 24 * 60 * 60;
export const MAX_CREDENTIAL_SECONDS = 90 * 24 * 60 * 60;
export const X_EPOCH_MS = 1_288_834_974_657n;

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_POLL_ATTEMPTS = 480;
export const MAX_REQUEST_BYTES = 4_096;

export const TERMINAL_SUBMISSION_STATUSES = new Set([
  'FINALIZED',
  'EXECUTION_FAILED',
  'NETWORK_TERMINATED',
  'RECONCILIATION_REQUIRED',
  'POLLING_EXHAUSTED',
]);
