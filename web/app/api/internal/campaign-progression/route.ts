import {
  campaignProgressionRequestIsAuthorized,
  runCampaignProgressionBatch,
} from "@/lib/campaign-progression";
import { apiError } from "@/lib/verification-api";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  const secret = process.env.CRON_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    return Response.json(
      {
        error: {
          code: "CRON_CONFIGURATION_REQUIRED",
          message: "Automatic campaign progression is not configured.",
        },
      },
      { status: 503, headers },
    );
  }
  if (!campaignProgressionRequestIsAuthorized(request, secret)) {
    return Response.json(
      {
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "This campaign progression endpoint is not public.",
        },
      },
      { status: 401, headers },
    );
  }

  try {
    return Response.json(
      { progression: await runCampaignProgressionBatch() },
      { headers },
    );
  } catch (error) {
    return apiError(error);
  }
}
