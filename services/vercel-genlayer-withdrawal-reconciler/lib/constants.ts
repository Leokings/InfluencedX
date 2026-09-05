import type { ReconciliationStatus } from "./types";

export const RECONCILER_SCHEMA_VERSION = 1 as const;
export const RECONCILER_STAGE = "studionet" as const;
export const RECONCILER_NETWORK = "studionet" as const;
export const STUDIONET_CHAIN_ID = 61_999 as const;
export const STUDIONET_RPC_URL = "https://studio.genlayer.com/api" as const;
export const MARKETPLACE_ADDRESS = "0x492175c248168ddb9571cbf4c6a14296e3348181" as const;
export const MARKETPLACE_RPC_ADDRESS = "0x492175c248168DDB9571CBF4c6A14296e3348181" as const;
export const MARKETPLACE_DEPLOYMENT_TX_HASH =
  "0x3e3b7e8a10ab46c5e19638c3efd6816d78911d10213188571cbd4393f6494da8" as const;
export const MARKETPLACE_WITHDRAWAL_CONFIRMER = "0xaafc5d9075a404d82b8ee1692f7ff802168c5dd8" as const;
export const MARKETPLACE_PROTOCOL = "INFLUENCEDX_MARKETPLACE_V3" as const;
export const MARKETPLACE_SCHEMA_VERSION = 3 as const;
export const WITHDRAWAL_RECOVERY_DELAY_SECONDS = 24 * 60 * 60;

export const QUEUE_TOPIC = "influencedx-genlayer-withdrawal-reconciliation-v1" as const;
export const SIGNER_GATE = "influencedx-withdrawal-confirmer-signer-v1" as const;
export const CONFIRM_METHOD = "confirm_withdrawal" as const;
export const ZERO_VALUE_ATTO = "0" as const;
export const ZERO_HASH = `0x${"0".repeat(64)}` as const;

export const PRECHECK_LEASE_MS = 2 * 60 * 1_000;
export const DISCOVERY_INTERVAL_SECONDS = 60;
export const CONFIRMATION_POLL_INTERVAL_SECONDS = 30;
export const MAX_CONFIRMATION_POLL_ATTEMPTS = 480;
export const QUEUE_RETENTION_SECONDS = 7 * 24 * 60 * 60;
export const MAX_REQUEST_BYTES = 1_024;
export const MAX_HISTORY_CANDIDATES = 64;
export const SERVICE_TOKEN_HEADER = "x-influencedx-withdrawal-service-token";

export const TERMINAL_STATUSES = new Set<ReconciliationStatus>([
  "FINALIZED",
  "RECONCILIATION_REQUIRED",
  "POLLING_EXHAUSTED",
  "POISONED",
]);
