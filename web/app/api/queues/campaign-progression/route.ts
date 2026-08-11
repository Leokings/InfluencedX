import { handleCallback, type RetryDirective } from "@vercel/queue";
import {
  CampaignProgressionPoisonError,
  campaignProgressionQueueRetryDelaySeconds,
  processQueuedCampaignProgression,
} from "../../../../lib/campaign-progression.ts";
import {
  CampaignProgressionQueueMessageError,
  validateCampaignProgressionQueueMessage,
} from "../../../../lib/campaign-progression-queue.ts";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Vercel invokes this route through an air-gapped queue trigger. There is no
 * browser/session authentication path and the payload contains identifiers
 * only; the worker rebinds those identifiers to Neon before progressing.
 */
export const POST = handleCallback(
  async (payload: unknown) => {
    const message = validateCampaignProgressionQueueMessage(payload);
    await processQueuedCampaignProgression(message);
  },
  {
    visibilityTimeoutSeconds: 10 * 60,
    retry: campaignProgressionQueueRetryDirective,
  },
);

export function campaignProgressionQueueRetryDirective(
  error: unknown,
  metadata: Readonly<{ deliveryCount: number }>,
): RetryDirective {
  if (
    error instanceof CampaignProgressionQueueMessageError ||
    error instanceof CampaignProgressionPoisonError
  ) {
    return { acknowledge: true };
  }
  return {
    afterSeconds: campaignProgressionQueueRetryDelaySeconds(
      metadata.deliveryCount,
    ),
  };
}
