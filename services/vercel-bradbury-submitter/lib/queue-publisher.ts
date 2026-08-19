import { send } from "@vercel/queue";

import {
  POLL_INTERVAL_SECONDS,
  QUEUE_RETENTION_SECONDS,
  QUEUE_TOPIC,
  SUBMITTER_SCHEMA_VERSION,
} from "./constants";
import type { QueueMessage } from "./types";

export interface QueuePublisher {
  submit(requestId: string): Promise<string | null>;
  poll(requestId: string, attempt: number): Promise<string | null>;
}

export const vercelQueuePublisher: QueuePublisher = Object.freeze({
  async submit(requestId: string) {
    return sendMessage(requestId, `influencedx-studionet-submit:${requestId}`);
  },
  async poll(requestId: string, attempt: number) {
    return sendMessage(
      requestId,
      `influencedx-studionet-poll:${requestId}:${attempt}`,
      POLL_INTERVAL_SECONDS,
    );
  },
});

async function sendMessage(requestId: string, idempotencyKey: string, delaySeconds = 0): Promise<string | null> {
  const message: QueueMessage = Object.freeze({ schemaVersion: SUBMITTER_SCHEMA_VERSION, requestId });
  const { messageId } = await send(QUEUE_TOPIC, message, {
    idempotencyKey,
    retentionSeconds: QUEUE_RETENTION_SECONDS,
    delaySeconds,
  });
  return messageId;
}
