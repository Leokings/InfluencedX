import { getVercelOidcToken } from "@vercel/oidc";

import {
  MARKETPLACE_GENLAYER_CHAIN_ID,
  MARKETPLACE_GENLAYER_NETWORK,
  marketplaceContractAddress,
} from "./marketplace-genlayer-rpc.ts";

const MAX_RESPONSE_BYTES = 32_768;
const REQUEST_TIMEOUT_MS = 15_000;
const LIVE_WITHDRAWAL_CONFIRMER = "0xaafc5d9075a404d82b8ee1692f7ff802168c5dd8";

export const WITHDRAWAL_RECONCILIATION_STATUSES = [
  "QUEUED",
  "WAITING_FOR_EMISSION",
  "WAITING_FOR_TRANSFER",
  "PROOF_VERIFIED",
  "BROADCASTING",
  "SUBMITTED",
  "POLLING",
  "FINALIZED",
  "RECONCILIATION_REQUIRED",
  "POLLING_EXHAUSTED",
  "POISONED",
] as const;

export type WithdrawalReconciliationStatus =
  (typeof WITHDRAWAL_RECONCILIATION_STATUSES)[number];

export type WithdrawalReconciliationProjection = Readonly<{
  withdrawalId: string;
  network: "studionet";
  chainId: 61_999;
  contractAddress: string;
  withdrawalConfirmer: string;
  functionName: "confirm_withdrawal";
  valueAtto: "0";
  status: WithdrawalReconciliationStatus;
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
  broadcastStartedAt: string | null;
  submittedAt: string | null;
  lastCheckedAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

type WithdrawalReconcilerConfig = Readonly<{
  origin: string;
  oidcToken: string;
  serviceToken: string;
}>;

export class WithdrawalReconcilerClientProblem extends Error {
  readonly code:
    | "WITHDRAWAL_RECONCILER_CONFIGURATION_REQUIRED"
    | "WITHDRAWAL_RECONCILER_UNAVAILABLE"
    | "WITHDRAWAL_RECONCILER_RESPONSE_INVALID";
  readonly retryable: boolean;

  constructor(
    code: WithdrawalReconcilerClientProblem["code"],
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "WithdrawalReconcilerClientProblem";
    this.code = code;
    this.retryable = retryable;
  }
}

export async function loadWithdrawalReconcilerConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<WithdrawalReconcilerConfig | null> {
  if (env.INFLUENCEDX_WITHDRAWAL_RECONCILER_ENABLED !== "true") return null;
  const origin = exactOrigin(env.INFLUENCEDX_WITHDRAWAL_RECONCILER_URL);
  const serviceToken = env.INFLUENCEDX_WITHDRAWAL_RECONCILER_SERVICE_TOKEN;
  if (typeof serviceToken !== "string" || !/^[0-9a-fA-F]{64}$/.test(serviceToken)) {
    throw configuration();
  }
  let oidcToken: string;
  try {
    oidcToken = await getVercelOidcToken();
  } catch {
    throw configuration();
  }
  if (oidcToken.length > 16_384 || oidcToken.split(".").length !== 3) {
    throw configuration();
  }
  return Object.freeze({
    origin,
    oidcToken,
    serviceToken: serviceToken.toLowerCase(),
  });
}

export function createWithdrawalReconcilerClient(
  config: WithdrawalReconcilerConfig,
  fetchImplementation: typeof fetch = fetch,
) {
  const headers = Object.freeze({
    authorization: `Bearer ${config.oidcToken}`,
    "x-influencedx-withdrawal-service-token": config.serviceToken,
    accept: "application/json",
  });
  return Object.freeze({
    async submit(withdrawalId: string): Promise<{
      replayed: boolean;
      reconciliation: WithdrawalReconciliationProjection;
    }> {
      const normalized = hash(withdrawalId);
      const response = await requestJson(
        fetchImplementation,
        `${config.origin}/v1/withdrawals/reconciliations`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: 1, withdrawalId: normalized }),
        },
      );
      if (!plain(response) || typeof response.replayed !== "boolean") throw invalid();
      return Object.freeze({
        replayed: response.replayed,
        reconciliation: parseProjection(response.reconciliation, normalized),
      });
    },

    async get(withdrawalId: string): Promise<WithdrawalReconciliationProjection> {
      const normalized = hash(withdrawalId);
      const response = await requestJson(
        fetchImplementation,
        `${config.origin}/v1/withdrawals/reconciliations/${encodeURIComponent(normalized)}`,
        { method: "GET", headers },
      );
      if (!plain(response)) throw invalid();
      return parseProjection(response.reconciliation, normalized);
    },
  });
}

export async function requireWithdrawalReconcilerClient() {
  const config = await loadWithdrawalReconcilerConfig();
  if (!config) throw configuration();
  return createWithdrawalReconcilerClient(config);
}

async function requestJson(
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw unavailable(true);
  }
  const text = await boundedText(response);
  if (
    !response.ok ||
    !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")
  ) {
    throw unavailable(response.status >= 500 || response.status === 429);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalid();
  }
}

async function boundedText(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) throw invalid();
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw invalid();
  return text;
}

function parseProjection(
  value: unknown,
  expectedWithdrawalId: string,
): WithdrawalReconciliationProjection {
  if (!plain(value)) throw invalid();
  exactKeys(value, [
    "withdrawalId", "network", "chainId", "contractAddress", "withdrawalConfirmer",
    "functionName", "valueAtto", "status", "evidenceHash", "transferParentTxHash",
    "transferChildTxHash", "confirmationTxHash", "lifecycleStatus", "executionResult",
    "queueMessageId", "enqueueAttempts", "deliveryCount", "discoveryAttempts",
    "pollAttempts", "errorCode", "broadcastStartedAt", "submittedAt", "lastCheckedAt",
    "finalizedAt", "createdAt", "updatedAt",
  ]);
  const contractAddress = address(value.contractAddress);
  const withdrawalConfirmer = address(value.withdrawalConfirmer);
  if (
    hash(value.withdrawalId) !== expectedWithdrawalId ||
    value.network !== MARKETPLACE_GENLAYER_NETWORK ||
    value.chainId !== MARKETPLACE_GENLAYER_CHAIN_ID ||
    contractAddress !== marketplaceContractAddress().toLowerCase() ||
    withdrawalConfirmer !== LIVE_WITHDRAWAL_CONFIRMER ||
    value.functionName !== "confirm_withdrawal" ||
    value.valueAtto !== "0" ||
    !WITHDRAWAL_RECONCILIATION_STATUSES.includes(value.status as WithdrawalReconciliationStatus)
  ) throw invalid();
  const status = value.status as WithdrawalReconciliationStatus;
  const confirmationTxHash = nullableHash(value.confirmationTxHash);
  const evidenceHash = nullableHash(value.evidenceHash);
  if (status === "FINALIZED" && (!confirmationTxHash || !evidenceHash || !value.finalizedAt)) {
    throw invalid();
  }
  return Object.freeze({
    withdrawalId: expectedWithdrawalId,
    network: "studionet",
    chainId: 61_999,
    contractAddress,
    withdrawalConfirmer,
    functionName: "confirm_withdrawal",
    valueAtto: "0",
    status,
    evidenceHash,
    transferParentTxHash: nullableHash(value.transferParentTxHash),
    transferChildTxHash: nullableHash(value.transferChildTxHash),
    confirmationTxHash,
    lifecycleStatus: nullableText(value.lifecycleStatus, 64),
    executionResult: nullableText(value.executionResult, 64),
    queueMessageId: nullableText(value.queueMessageId, 256),
    enqueueAttempts: nonNegativeInteger(value.enqueueAttempts),
    deliveryCount: nonNegativeInteger(value.deliveryCount),
    discoveryAttempts: nonNegativeInteger(value.discoveryAttempts),
    pollAttempts: nonNegativeInteger(value.pollAttempts),
    errorCode: nullableCode(value.errorCode),
    broadcastStartedAt: nullableTimestamp(value.broadcastStartedAt),
    submittedAt: nullableTimestamp(value.submittedAt),
    lastCheckedAt: nullableTimestamp(value.lastCheckedAt),
    finalizedAt: nullableTimestamp(value.finalizedAt),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
}

function exactKeys(value: object, keys: readonly string[]) {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw invalid();
}

function exactOrigin(value: unknown): string {
  if (typeof value !== "string") throw configuration();
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw configuration(); }
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" ||
    parsed.search || parsed.hash || parsed.port
  ) throw configuration();
  return parsed.origin;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) throw invalid();
  return value;
}

function nullableHash(value: unknown): string | null {
  return value === null ? null : hash(value);
}

function address(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/.test(value)) throw invalid();
  return value;
}

function nullableText(value: unknown, maxLength: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) throw invalid();
  return value;
}

function nullableCode(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[A-Z0-9_]{1,64}$/.test(value)) throw invalid();
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw invalid();
  return value;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configuration(): WithdrawalReconcilerClientProblem {
  return new WithdrawalReconcilerClientProblem(
    "WITHDRAWAL_RECONCILER_CONFIGURATION_REQUIRED",
    "Hosted GEN withdrawal reconciliation is not configured.",
  );
}

function unavailable(retryable: boolean): WithdrawalReconcilerClientProblem {
  return new WithdrawalReconcilerClientProblem(
    "WITHDRAWAL_RECONCILER_UNAVAILABLE",
    "Hosted GEN withdrawal reconciliation is temporarily unavailable.",
    retryable,
  );
}

function invalid(): WithdrawalReconcilerClientProblem {
  return new WithdrawalReconcilerClientProblem(
    "WITHDRAWAL_RECONCILER_RESPONSE_INVALID",
    "Hosted GEN withdrawal reconciliation returned an invalid response.",
  );
}
