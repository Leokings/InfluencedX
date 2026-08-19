import { handleCallback, type RetryDirective } from "@vercel/queue";
import {
  MarketplaceMaintenanceMessageError,
} from "@/lib/marketplace-genlayer-maintenance-queue";
import { processMarketplaceMaintenanceHeartbeat } from "@/lib/marketplace-genlayer-maintenance-worker";

export const runtime = "nodejs";
export const maxDuration = 300;

export const POST = handleCallback(
  async (payload: unknown) => {
    await processMarketplaceMaintenanceHeartbeat(payload);
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
