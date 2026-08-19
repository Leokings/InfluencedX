import { QueueClient } from "@vercel/queue";

import {
  OPERATOR_SCHEMA_VERSION,
  POLL_INTERVAL_SECONDS,
  QUEUE_RETENTION_SECONDS,
  QUEUE_TOPIC,
} from "./constants";
import type { QueueMessage } from "./types";

export interface QueuePublisher {
  submit(operationId: string, generation: number): Promise<string | null>;
  poll(operationId: string, attempt: number): Promise<string | null>;
}

const { send } = new QueueClient({ region: process.env.VERCEL_REGION ?? "iad1" });

export const vercelQueuePublisher: QueuePublisher = Object.freeze({
  submit(operationId: string, generation: number) {
    return sendMessage(operationId, `marketplace-submit:${operationId}:${generation}`);
  },
  poll(operationId: string, attempt: number) {
    return sendMessage(
      operationId,
      `marketplace-poll:${operationId}:${attempt}`,
      POLL_INTERVAL_SECONDS,
    );
  },
});

async function sendMessage(
  operationId: string,
  idempotencyKey: string,
  delaySeconds = 0,
): Promise<string | null> {
  const message: QueueMessage = Object.freeze({
    schemaVersion: OPERATOR_SCHEMA_VERSION,
    operationId,
  });
  const { messageId } = await send(QUEUE_TOPIC, message, {
    idempotencyKey,
    retentionSeconds: QUEUE_RETENTION_SECONDS,
    delaySeconds,
  });
  return messageId;
}
