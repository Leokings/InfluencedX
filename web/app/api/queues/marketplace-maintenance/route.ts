import { handleCallback, type RetryDirective } from "@vercel/queue";
import {
  MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS,
  MarketplaceMaintenanceMessageError,
  enqueueMarketplaceMaintenanceHeartbeat,
  validateMarketplaceMaintenanceMessage,
} from "@/lib/marketplace-genlayer-maintenance-queue";
import { runGenLayerMaintenanceBatch } from "@/lib/marketplace-genlayer-maintenance";

export const runtime = "nodejs";
export const maxDuration = 300;

export const POST = handleCallback(
  async (payload: unknown) => {
    validateMarketplaceMaintenanceMessage(payload);
    await runGenLayerMaintenanceBatch();
    await enqueueMarketplaceMaintenanceHeartbeat({
      delaySeconds: MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS,
    });
  },
  {
    visibilityTimeoutSeconds: 10 * 60,
    retry: marketplaceMaintenanceRetryDirective,
  },
);

export function marketplaceMaintenanceRetryDirective(
  error: unknown,
  metadata: Readonly<{ deliveryCount: number }>,
): RetryDirective {
  if (error instanceof MarketplaceMaintenanceMessageError) {
    return { acknowledge: true };
  }
  const deliveryCount = Number.isSafeInteger(metadata.deliveryCount)
    ? Math.max(1, metadata.deliveryCount)
    : 1;
  return {
    afterSeconds: Math.min(15 * 60, 60 * 2 ** Math.min(deliveryCount - 1, 4)),
  };
}
