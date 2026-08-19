import type { OperationStatus } from "./types";

export const OPERATOR_SCHEMA_VERSION = 1 as const;
export const OPERATOR_STAGE = "studionet" as const;
export const OPERATOR_NETWORK = "studionet" as const;
export const STUDIONET_CHAIN_ID = 61_999 as const;
export const STUDIONET_RPC_URL = "https://studio.genlayer.com/api" as const;
export const MARKETPLACE_ADDRESS = "0xeaceba807a7a4dc370f3b5a8e45539596b8551b4" as const;
export const MARKETPLACE_RPC_ADDRESS = "0xEaCeBa807a7A4dc370f3B5a8e45539596b8551b4" as const;
export const MARKETPLACE_DEPLOYMENT_TX_HASH =
  "0x8881290fcbe992a222995fccc0f2994e3752bd4e4aad35e6d25628e3c6df21d2" as const;
export const QUEUE_TOPIC = "influencedx-genlayer-marketplace-ops-v1" as const;
export const SIGNER_GATE = "influencedx-marketplace-operator-signer-v1" as const;
export const ZERO_VALUE_ATTO = "0" as const;

export const RESOLVE_ASSIGNMENT = "resolve_assignment" as const;
export const EXPIRE_ASSIGNMENT = "expire_assignment" as const;
export const FINALIZE_CAMPAIGN = "finalize_campaign" as const;
export const OPERATOR_ACTIONS = Object.freeze([
  RESOLVE_ASSIGNMENT,
  EXPIRE_ASSIGNMENT,
  FINALIZE_CAMPAIGN,
]);

export const PRECHECK_LEASE_MS = 2 * 60 * 1_000;
export const POLL_INTERVAL_SECONDS = 30;
export const MAX_POLL_ATTEMPTS = 480;
export const QUEUE_RETENTION_SECONDS = 24 * 60 * 60;
export const MAX_REQUEST_BYTES = 2_048;
export const SERVICE_TOKEN_HEADER = "x-influencedx-service-token";

export const TERMINAL_STATUSES = new Set<OperationStatus>([
  "FINALIZED",
  "EXECUTION_FAILED",
  "NETWORK_TERMINATED",
  "RECONCILIATION_REQUIRED",
  "POLLING_EXHAUSTED",
  "POISONED",
]);
