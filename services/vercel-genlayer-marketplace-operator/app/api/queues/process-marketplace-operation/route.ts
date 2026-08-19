import { handleCallback } from "@vercel/queue";

import { validateQueueMessage } from "@/lib/envelope";
import { GateBusyError, PoisonMessageError } from "@/lib/problem";
import { createConsumerRuntime } from "@/lib/runtimes";

export const runtime = "nodejs";
export const maxDuration = 300;

export const POST = handleCallback(
  async (rawMessage, metadata) => {
    const runtime = createConsumerRuntime();
    try {
      const message = validateQueueMessage(rawMessage);
      await runtime.service.process(message, metadata.deliveryCount);
    } catch (error) {
      if (error instanceof PoisonMessageError && error.operationId) {
        await runtime.repository.markPoisoned(error.operationId, error.code);
      }
      throw error;
    }
  },
  {
    visibilityTimeoutSeconds: 600,
    retry: (error, metadata) => {
      if (error instanceof PoisonMessageError) return { acknowledge: true };
      if (error instanceof GateBusyError) return { afterSeconds: 15 };
      return {
        afterSeconds: Math.min(300, Math.max(30, 2 ** Math.min(metadata.deliveryCount, 6) * 5)),
      };
    },
  },
);
