import {
  applicationOriginForRequest,
  verificationMutationsEnabled,
} from "./verification-config.ts";
import { classifyDatabaseFailure } from "./database-error.ts";

export class ApiProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly responseHeaders: HeadersInit;

  constructor(
    status: number,
    code: string,
    message: string,
    responseHeaders: HeadersInit = {},
  ) {
    super(message);
    this.name = "ApiProblem";
    this.status = status;
    this.code = code;
    this.responseHeaders = responseHeaders;
  }
}

export async function readSameOriginJson(
  request: Request,
  options: {
    mutationsEnabled?: () => boolean;
    disabledCode?: string;
    disabledMessage?: string;
  } = {},
): Promise<Record<string, unknown>> {
  if (request.method !== "POST") {
    throw new ApiProblem(405, "METHOD_NOT_ALLOWED", "Use POST.");
  }

  if (!(options.mutationsEnabled ?? verificationMutationsEnabled)()) {
    throw new ApiProblem(
      503,
      options.disabledCode ?? "VERIFICATION_MUTATIONS_DISABLED",
      options.disabledMessage ??
        "Wallet and X verification actions are not enabled in this deployment.",
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ApiProblem(
      415,
      "JSON_REQUIRED",
      "Requests must use the application/json content type.",
    );
  }

  const origin = request.headers.get("origin");
  let applicationOrigin: string;
  try {
    applicationOrigin = applicationOriginForRequest(request);
  } catch {
    throw new ApiProblem(
      403,
      "SAME_ORIGIN_REQUIRED",
      "This InfluencedX application origin is not allowed.",
    );
  }
  if (!origin || origin !== applicationOrigin) {
    throw new ApiProblem(
      403,
      "SAME_ORIGIN_REQUIRED",
      "This action must come from the InfluencedX application.",
    );
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    throw new ApiProblem(
      403,
      "SAME_ORIGIN_REQUIRED",
      "Cross-site requests are not accepted.",
    );
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 16_384) {
    throw new ApiProblem(413, "PAYLOAD_TOO_LARGE", "The request is too large.");
  }

  const text = await request.text();
  if (text.length > 16_384) {
    throw new ApiProblem(413, "PAYLOAD_TOO_LARGE", "The request is too large.");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiProblem(400, "INVALID_JSON", "The JSON body is invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiProblem(400, "INVALID_JSON", "Send a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function requireString(
  body: Record<string, unknown>,
  field: string,
  maxLength = 1_024,
): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new ApiProblem(
      400,
      "INVALID_REQUEST",
      `${field} is required.`,
    );
  }
  return value.trim();
}

export function apiError(error: unknown): Response {
  if (error instanceof ApiProblem) {
    const headers = new Headers(error.responseHeaders);
    headers.set("Cache-Control", "private, no-store");
    return Response.json(
      { error: { code: error.code, message: error.message } },
      {
        status: error.status,
        headers,
      },
    );
  }

  const databaseFailure = classifyDatabaseFailure(error);
  if (databaseFailure?.kind === "configuration") {
    return Response.json(
      {
        error: {
          code: "DATABASE_CONFIGURATION_REQUIRED",
          message: "The verification database is not configured.",
        },
      },
      {
        status: 503,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
  if (databaseFailure?.kind === "not_migrated") {
    return Response.json(
      {
        error: {
          code: "DATABASE_NOT_MIGRATED",
          message:
            "The verification database is not ready. Apply the generated Postgres migration.",
        },
      },
      {
        status: 503,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
  if (databaseFailure?.kind === "unavailable") {
    console.error("InfluencedX verification database request failed", {
      postgresCode: databaseFailure.postgresCode ?? "unknown",
    });
    return Response.json(
      {
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "The verification database is temporarily unavailable.",
        },
      },
      {
        status: 503,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }

  console.error("InfluencedX verification route failed", error);
  return Response.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "The verification service could not complete this request.",
      },
    },
    {
      status: 500,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
