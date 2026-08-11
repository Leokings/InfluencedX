import { getVercelOidcToken } from "@vercel/oidc";
import {
  parseSubmitterSubmission,
  type OwnershipSubmissionEnvelope,
  type SubmitterSubmission,
} from "./ownership-submission.ts";
import {
  parseCampaignSubmitterSubmission,
  type CampaignSubmissionEnvelope,
  type CampaignSubmitterSubmission,
} from "./campaign-submission.ts";
import {
  parseMetricsSubmitterSubmission,
  type MetricsSubmissionEnvelope,
  type MetricsSubmitterSubmission,
} from "./metrics-submission.ts";

const MAX_RESPONSE_BYTES = 16_384;
const REQUEST_TIMEOUT_MS = 30_000;

export type BradburySubmitterConfig = {
  origin: string;
  vercelOidcToken: string;
};

export class BradburySubmitterProblem extends Error {
  readonly code:
    | "CONFIGURATION_REQUIRED"
    | "SUBMITTER_UNAVAILABLE"
    | "SUBMITTER_RESPONSE_INVALID";
  readonly ambiguous: boolean;

  constructor(
    code: BradburySubmitterProblem["code"],
    message: string,
    options: { ambiguous?: boolean } = {},
  ) {
    super(message);
    this.name = "BradburySubmitterProblem";
    this.code = code;
    this.ambiguous = options.ambiguous ?? false;
  }
}

export async function loadBradburySubmitterConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<BradburySubmitterConfig> {
  if (environment.XPROOF_SUBMITTER_BRIDGE_ENABLED !== "true") {
    throw configurationRequired();
  }
  const origin = normalizeSubmitterOrigin(environment.XPROOF_SUBMITTER_URL);
  let vercelOidcToken: string;
  try {
    vercelOidcToken = await getVercelOidcToken();
  } catch {
    throw configurationRequired();
  }
  if (!looksLikeJwt(vercelOidcToken)) throw configurationRequired();
  return Object.freeze({ origin, vercelOidcToken });
}

export function createBradburySubmitterClient(
  config: BradburySubmitterConfig,
  fetchImplementation: typeof fetch = fetch,
) {
  const headers = Object.freeze({
    authorization: `Bearer ${config.vercelOidcToken}`,
    "x-vercel-trusted-oidc-idp-token": config.vercelOidcToken,
  });
  return Object.freeze({
    async submit(
      envelope: OwnershipSubmissionEnvelope,
    ): Promise<{ replayed: boolean; submission: SubmitterSubmission }> {
      const response = await request(
        fetchImplementation,
        `${config.origin}/api/v1/ownership-submissions`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(envelope),
        },
        true,
      );
      if (!isPlainObject(response) || typeof response.replayed !== "boolean") {
        throw invalidResponse();
      }
      return Object.freeze({
        replayed: response.replayed,
        submission: parseSubmitterSubmission(response.submission),
      });
    },

    async status(requestId: string): Promise<SubmitterSubmission | null> {
      let response: unknown;
      try {
        response = await request(
          fetchImplementation,
          `${config.origin}/api/v1/ownership-submissions/${encodeURIComponent(requestId)}`,
          { method: "GET", headers },
          false,
        );
      } catch (error) {
        if (error instanceof SubmitterNotFound) return null;
        throw error;
      }
      if (!isPlainObject(response)) throw invalidResponse();
      return parseSubmitterSubmission(response.submission);
    },

    async submitCampaign(
      envelope: CampaignSubmissionEnvelope,
    ): Promise<{ replayed: boolean; submission: CampaignSubmitterSubmission }> {
      const response = await request(
        fetchImplementation,
        `${config.origin}/api/v1/campaign-submissions`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(envelope),
        },
        true,
      );
      if (!isPlainObject(response) || typeof response.replayed !== "boolean") {
        throw invalidResponse();
      }
      return Object.freeze({
        replayed: response.replayed,
        submission: parseCampaignSubmitterSubmission(response.submission),
      });
    },

    async campaignStatus(
      requestId: string,
    ): Promise<CampaignSubmitterSubmission | null> {
      let response: unknown;
      try {
        response = await request(
          fetchImplementation,
          `${config.origin}/api/v1/campaign-submissions/${encodeURIComponent(requestId)}`,
          { method: "GET", headers },
          false,
        );
      } catch (error) {
        if (error instanceof SubmitterNotFound) return null;
        throw error;
      }
      if (!isPlainObject(response)) throw invalidResponse();
      return parseCampaignSubmitterSubmission(response.submission);
    },

    async submitMetrics(
      envelope: MetricsSubmissionEnvelope,
    ): Promise<{ replayed: boolean; submission: MetricsSubmitterSubmission }> {
      const response = await request(
        fetchImplementation,
        `${config.origin}/api/v1/metrics-submissions`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(envelope),
        },
        true,
      );
      if (!isPlainObject(response) || typeof response.replayed !== "boolean") {
        throw invalidResponse();
      }
      return Object.freeze({
        replayed: response.replayed,
        submission: parseMetricsSubmitterSubmission(response.submission),
      });
    },

    async metricsStatus(requestId: string): Promise<MetricsSubmitterSubmission | null> {
      let response: unknown;
      try {
        response = await request(
          fetchImplementation,
          `${config.origin}/api/v1/metrics-submissions/${encodeURIComponent(requestId)}`,
          { method: "GET", headers },
          false,
        );
      } catch (error) {
        if (error instanceof SubmitterNotFound) return null;
        throw error;
      }
      if (!isPlainObject(response)) throw invalidResponse();
      return parseMetricsSubmitterSubmission(response.submission);
    },
  });
}

async function request(
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
  ambiguousOnFailure: boolean,
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
    throw new BradburySubmitterProblem(
      "SUBMITTER_UNAVAILABLE",
      "The Bradbury submission service is temporarily unavailable.",
      { ambiguous: ambiguousOnFailure },
    );
  }
  if (response.status === 404) throw new SubmitterNotFound();
  const text = await boundedResponseText(response);
  if (!response.ok) {
    throw new BradburySubmitterProblem(
      "SUBMITTER_UNAVAILABLE",
      "The Bradbury submission service did not accept the request.",
      { ambiguous: ambiguousOnFailure },
    );
  }
  if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw invalidResponse();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw invalidResponse();
  }
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw invalidResponse();
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw invalidResponse();
  }
  return text;
}

function normalizeSubmitterOrigin(value: unknown): string {
  if (typeof value !== "string") throw configurationRequired();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationRequired();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.port
  ) {
    throw configurationRequired();
  }
  return url.origin;
}

function looksLikeJwt(value: unknown): value is string {
  return typeof value === "string" && value.length <= 16_384 && value.split(".").length === 3;
}

function configurationRequired(): BradburySubmitterProblem {
  return new BradburySubmitterProblem(
    "CONFIGURATION_REQUIRED",
    "The authenticated Bradbury submission boundary is not configured.",
  );
}

function invalidResponse(): BradburySubmitterProblem {
  return new BradburySubmitterProblem(
    "SUBMITTER_RESPONSE_INVALID",
    "The Bradbury submission service returned an invalid response.",
  );
}

class SubmitterNotFound extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
