import { ApiProblem } from "./verification-api.ts";

export const DEFAULT_CAMPAIGN_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const MINIMUM_CALLER_CAMPAIGN_RETENTION_SECONDS = 24 * 60 * 60;
export const MAXIMUM_CAMPAIGN_RETENTION_SECONDS = 365 * 24 * 60 * 60;
export const MINIMUM_PREVIEW_CAMPAIGN_RETENTION_SECONDS = 60;
export const MAXIMUM_PREVIEW_CAMPAIGN_RETENTION_SECONDS =
  MINIMUM_CALLER_CAMPAIGN_RETENTION_SECONDS - 1;

export const PREVIEW_CAMPAIGN_RETENTION_ENV =
  "XPROOF_PREVIEW_CAMPAIGN_RETENTION_SECONDS" as const;

/**
 * Resolves the campaign retention committed to the terms document and Base.
 *
 * A short value is never caller-controlled. It can only be supplied as a
 * server-side default on an actual Vercel Preview deployment. Explicit request
 * values retain the normal one-day minimum even when the Preview override is
 * enabled.
 */
export function resolveCampaignRetentionSeconds(
  requestValue: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const serverDefault = configuredCampaignRetentionDefault(environment);
  if (requestValue === undefined) return serverDefault;

  const normalized =
    typeof requestValue === "string" && /^[0-9]+$/.test(requestValue)
      ? Number(requestValue)
      : requestValue;
  if (
    typeof normalized !== "number" ||
    !Number.isSafeInteger(normalized) ||
    normalized < MINIMUM_CALLER_CAMPAIGN_RETENTION_SECONDS ||
    normalized > MAXIMUM_CAMPAIGN_RETENTION_SECONDS
  ) {
    throw new ApiProblem(
      400,
      "INVALID_REQUEST",
      "retentionSeconds must be between one day and one year.",
    );
  }
  return normalized;
}

export function configuredCampaignRetentionDefault(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const configured = environment[PREVIEW_CAMPAIGN_RETENTION_ENV];
  if (configured === undefined) return DEFAULT_CAMPAIGN_RETENTION_SECONDS;

  const targetEnvironment = environment.VERCEL_TARGET_ENV;
  if (
    environment.VERCEL !== "1" ||
    environment.VERCEL_ENV !== "preview" ||
    (targetEnvironment !== undefined && targetEnvironment !== "preview")
  ) {
    throw configurationError(
      `${PREVIEW_CAMPAIGN_RETENTION_ENV} is allowed only on a Vercel Preview deployment.`,
    );
  }

  if (!/^[1-9][0-9]*$/.test(configured)) {
    throw configurationError(
      `${PREVIEW_CAMPAIGN_RETENTION_ENV} must be a canonical positive integer.`,
    );
  }
  const seconds = Number(configured);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < MINIMUM_PREVIEW_CAMPAIGN_RETENTION_SECONDS ||
    seconds > MAXIMUM_PREVIEW_CAMPAIGN_RETENTION_SECONDS
  ) {
    throw configurationError(
      `${PREVIEW_CAMPAIGN_RETENTION_ENV} must be between ${MINIMUM_PREVIEW_CAMPAIGN_RETENTION_SECONDS} and ${MAXIMUM_PREVIEW_CAMPAIGN_RETENTION_SECONDS} seconds.`,
    );
  }
  return seconds;
}

function configurationError(message: string): Error {
  return new Error(`Invalid campaign retention configuration: ${message}`);
}
