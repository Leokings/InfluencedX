import {
  genLayerProgressionRequestIsAuthorized,
} from "@/lib/marketplace-genlayer-progression";
import {
  MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS,
  enqueueMarketplaceMaintenanceHeartbeat,
} from "@/lib/marketplace-genlayer-maintenance-queue";
import { runGenLayerMaintenanceBatch } from "@/lib/marketplace-genlayer-maintenance";
import { apiError } from "@/lib/verification-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
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
  if (!genLayerProgressionRequestIsAuthorized(request, secret)) {
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
    const maintenance = await runGenLayerMaintenanceBatch();
    const heartbeat = await enqueueMarketplaceMaintenanceHeartbeat({
      delaySeconds: MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS,
    });
    return Response.json(
      { maintenance, heartbeat },
      { headers },
    );
  } catch (error) {
    return apiError(error);
  }
}
