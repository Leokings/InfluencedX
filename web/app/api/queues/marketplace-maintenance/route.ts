import { handleCallback } from "@vercel/queue";
import {
  MarketplaceMaintenanceRedeliveryError,
  marketplaceMaintenanceResultRetryAfterSeconds,
  marketplaceMaintenanceRetryDirective,
  processMarketplaceMaintenanceHeartbeat,
} from "@/lib/marketplace-genlayer-maintenance-worker";

export const runtime = "nodejs";
export const maxDuration = 300;

export const POST = handleCallback(
  async (payload: unknown, metadata) => {
    const result = await processMarketplaceMaintenanceHeartbeat(payload, metadata);
    const retryAfterSeconds =
      marketplaceMaintenanceResultRetryAfterSeconds(result);
    if (retryAfterSeconds !== null) {
      throw new MarketplaceMaintenanceRedeliveryError(retryAfterSeconds);
    }
  },
  {
    visibilityTimeoutSeconds: 10 * 60,
    retry: marketplaceMaintenanceRetryDirective,
  },
);
