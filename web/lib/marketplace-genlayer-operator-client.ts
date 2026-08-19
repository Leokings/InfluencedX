import { getVercelOidcToken } from "@vercel/oidc";

const MAX_RESPONSE_BYTES = 32_768;
const REQUEST_TIMEOUT_MS = 15_000;

export const GENLAYER_OPERATOR_ACTIONS = [
  "resolve_assignment",
  "expire_assignment",
  "finalize_campaign",
] as const;

export const GENLAYER_OPERATOR_STATUSES = [
  "QUEUED",
  "PRECHECKING",
  "PRECHECK_FAILED",
  "BROADCASTING",
  "SUBMITTED",
  "POLLING",
  "FINALIZED",
  "EXECUTION_FAILED",
  "NETWORK_TERMINATED",
  "RECONCILIATION_REQUIRED",
  "POLLING_EXHAUSTED",
  "POISONED",
] as const;

export type GenLayerOperatorAction =
  (typeof GENLAYER_OPERATOR_ACTIONS)[number];
export type GenLayerOperatorStatus =
  (typeof GENLAYER_OPERATOR_STATUSES)[number];

export type GenLayerOperatorRequest =
  | Readonly<{
      schemaVersion: 1;
      action: "resolve_assignment";
      assignmentId: string;
      requestId: string;
    }>
  | Readonly<{
      schemaVersion: 1;
      action: "expire_assignment";
      assignmentId: string;
    }>
  | Readonly<{
      schemaVersion: 1;
      action: "finalize_campaign";
      campaignId: string;
    }>;

export type GenLayerOperatorProjection = Readonly<{
  operationId: string;
  network: "studionet";
  chainId: 61_999;
  contractAddress: string;
  action: GenLayerOperatorAction;
  functionName: GenLayerOperatorAction;
  valueAtto: "0";
  preStateFingerprint: string | null;
  postStateFingerprint: string | null;
  status: GenLayerOperatorStatus;
  lifecycleStatus: string | null;
  executionResult: string | null;
  txHash: string | null;
  queueMessageId: string | null;
  enqueueAttempts: number;
  deliveryCount: number;
  pollAttempts: number;
  errorCode: string | null;
  broadcastStartedAt: string | null;
  submittedAt: string | null;
  lastPolledAt: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type GenLayerOperatorConfig = Readonly<{
  origin: string;
  oidcToken: string;
  serviceToken: string;
}>;

export class GenLayerOperatorClientProblem extends Error {
  readonly code:
    | "OPERATOR_CONFIGURATION_REQUIRED"
    | "OPERATOR_UNAVAILABLE"
    | "OPERATOR_RESPONSE_INVALID";
  readonly retryable: boolean;

  constructor(
    code:
      | "OPERATOR_CONFIGURATION_REQUIRED"
      | "OPERATOR_UNAVAILABLE"
      | "OPERATOR_RESPONSE_INVALID",
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "GenLayerOperatorClientProblem";
    this.code = code;
    this.retryable = retryable;
  }
}

export async function loadGenLayerOperatorConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GenLayerOperatorConfig | null> {
  if (env.INFLUENCEDX_MARKETPLACE_OPERATOR_ENABLED !== "true") return null;
  const origin = exactOrigin(env.INFLUENCEDX_MARKETPLACE_OPERATOR_URL);
  const serviceToken = env.INFLUENCEDX_OPERATOR_SERVICE_TOKEN;
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

export function createGenLayerOperatorClient(
  config: GenLayerOperatorConfig,
  fetchImplementation: typeof fetch = fetch,
) {
  const headers = Object.freeze({
    authorization: `Bearer ${config.oidcToken}`,
    "x-vercel-trusted-oidc-idp-token": config.oidcToken,
    "x-influencedx-service-token": config.serviceToken,
    accept: "application/json",
  });
  return Object.freeze({
    async submit(
      request: GenLayerOperatorRequest,
    ): Promise<{ replayed: boolean; operation: GenLayerOperatorProjection }> {
      validateRequest(request);
      const response = await requestJson(
        fetchImplementation,
        `${config.origin}/v1/operations`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(request),
        },
      );
      if (!plain(response) || typeof response.replayed !== "boolean") {
        throw invalid();
      }
      return Object.freeze({
        replayed: response.replayed,
        operation: parseProjection(response.operation),
      });
    },

    async get(operationId: string): Promise<GenLayerOperatorProjection> {
      const normalized = hash(operationId, "operationId");
      const response = await requestJson(
        fetchImplementation,
        `${config.origin}/v1/operations/${encodeURIComponent(normalized)}`,
        { method: "GET", headers },
      );
      if (!plain(response)) throw invalid();
      return parseProjection(response.operation);
    },
  });
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
    throw new GenLayerOperatorClientProblem(
      "OPERATOR_UNAVAILABLE",
      "Automatic StudioNet progression is temporarily unavailable.",
      true,
    );
  }
  const text = await boundedText(response);
  if (
    !response.ok ||
    !(response.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    throw new GenLayerOperatorClientProblem(
      "OPERATOR_UNAVAILABLE",
      "Automatic StudioNet progression was not accepted.",
      response.status >= 500 || response.status === 429,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalid();
  }
}

async function boundedText(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    throw invalid();
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw invalid();
  return text;
}

function validateRequest(request: GenLayerOperatorRequest): void {
  if (request.schemaVersion !== 1) throw invalid();
  if (request.action === "resolve_assignment") {
    exactKeys(request, ["action", "assignmentId", "requestId", "schemaVersion"]);
    hash(request.assignmentId, "assignmentId");
    hash(request.requestId, "requestId");
    return;
  }
  if (request.action === "expire_assignment") {
    exactKeys(request, ["action", "assignmentId", "schemaVersion"]);
    hash(request.assignmentId, "assignmentId");
    return;
  }
  if (request.action === "finalize_campaign") {
    exactKeys(request, ["action", "campaignId", "schemaVersion"]);
    hash(request.campaignId, "campaignId");
    return;
  }
  throw invalid();
}

function parseProjection(value: unknown): GenLayerOperatorProjection {
  if (!plain(value)) throw invalid();
  const operationId = hash(value.operationId, "operationId");
  const contractAddress = address(value.contractAddress, "contractAddress");
  if (
    value.network !== "studionet" ||
    value.chainId !== 61_999 ||
    !GENLAYER_OPERATOR_ACTIONS.includes(value.action as GenLayerOperatorAction) ||
    value.functionName !== value.action ||
    value.valueAtto !== "0" ||
    !GENLAYER_OPERATOR_STATUSES.includes(value.status as GenLayerOperatorStatus)
  ) {
    throw invalid();
  }
  const txHash = nullableHash(value.txHash, "txHash");
  if (value.status === "FINALIZED" && txHash === null) throw invalid();
  return Object.freeze({
    operationId,
    network: "studionet",
    chainId: 61_999,
    contractAddress,
    action: value.action as GenLayerOperatorAction,
    functionName: value.functionName as GenLayerOperatorAction,
    valueAtto: "0",
    preStateFingerprint: nullableHash(value.preStateFingerprint, "preStateFingerprint"),
    postStateFingerprint: nullableHash(value.postStateFingerprint, "postStateFingerprint"),
    status: value.status as GenLayerOperatorStatus,
    lifecycleStatus: nullableText(value.lifecycleStatus, 64),
    executionResult: nullableText(value.executionResult, 64),
    txHash,
    queueMessageId: nullableText(value.queueMessageId, 256),
    enqueueAttempts: nonNegativeInteger(value.enqueueAttempts),
    deliveryCount: nonNegativeInteger(value.deliveryCount),
    pollAttempts: nonNegativeInteger(value.pollAttempts),
    errorCode: nullableCode(value.errorCode),
    broadcastStartedAt: nullableTimestamp(value.broadcastStartedAt),
    submittedAt: nullableTimestamp(value.submittedAt),
    lastPolledAt: nullableTimestamp(value.lastPolledAt),
    finalizedAt: nullableTimestamp(value.finalizedAt),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  });
}

function exactKeys(value: object, keys: readonly string[]): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw invalid();
  }
}

function exactOrigin(value: unknown): string {
  if (typeof value !== "string") throw configuration();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw configuration();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.port
  ) {
    throw configuration();
  }
  return parsed.origin;
}

function hash(value: unknown, label: string): string {
  void label;
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) throw invalid();
  return value;
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : hash(value, label);
}

function address(value: unknown, label: string): string {
  void label;
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/.test(value)) throw invalid();
  return value;
}

function nullableText(value: unknown, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw invalid();
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

function configuration(): GenLayerOperatorClientProblem {
  return new GenLayerOperatorClientProblem(
    "OPERATOR_CONFIGURATION_REQUIRED",
    "Automatic StudioNet progression is not configured.",
  );
}

function invalid(): GenLayerOperatorClientProblem {
  return new GenLayerOperatorClientProblem(
    "OPERATOR_RESPONSE_INVALID",
    "Automatic StudioNet progression returned an invalid response.",
  );
}
