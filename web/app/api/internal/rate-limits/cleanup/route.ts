import { apiError } from "@/lib/verification-api";
import {
  cleanupExpiredRateLimitBuckets,
  cleanupRequestIsAuthorized,
} from "@/lib/rate-limit-cleanup";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  const secret = process.env.CRON_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    return Response.json(
      {
        error: {
          code: "CRON_CONFIGURATION_REQUIRED",
          message: "Rate-limit cleanup is not configured.",
        },
      },
      { status: 503, headers },
    );
  }
  if (!cleanupRequestIsAuthorized(request, secret)) {
    return Response.json(
      {
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "This maintenance endpoint is not public.",
        },
      },
      { status: 401, headers },
    );
  }

  try {
    const result = await cleanupExpiredRateLimitBuckets();
    return Response.json(
      {
        cleanup: {
          deleted: result.deleted,
          batches: result.batches,
          capped: result.capped,
        },
      },
      { headers },
    );
  } catch (error) {
    return apiError(error);
  }
}
