import { QueueClient } from "@vercel/queue";

import {
  CONFIRMATION_POLL_INTERVAL_SECONDS,
  DISCOVERY_INTERVAL_SECONDS,
  QUEUE_RETENTION_SECONDS,
  QUEUE_TOPIC,
  RECONCILER_SCHEMA_VERSION,
} from "./constants";
import type { QueueMessage } from "./types";

export interface QueuePublisher {
  submit(withdrawalId: string, generation: number): Promise<string | null>;
  discover(withdrawalId: string, attempt: number): Promise<string | null>;
  poll(withdrawalId: string, attempt: number): Promise<string | null>;
}

const { send } = new QueueClient({ region: process.env.VERCEL_REGION ?? "iad1" });

export const vercelQueuePublisher: QueuePublisher = Object.freeze({
  submit(withdrawalId: string, generation: number) {
    return sendMessage(withdrawalId, `withdrawal-submit:${withdrawalId}:${generation}`, 0);
  },
  discover(withdrawalId: string, attempt: number) {
    return sendMessage(withdrawalId, `withdrawal-discovery:${withdrawalId}:${attempt}`, DISCOVERY_INTERVAL_SECONDS);
  },
  poll(withdrawalId: string, attempt: number) {
    return sendMessage(withdrawalId, `withdrawal-confirmation:${withdrawalId}:${attempt}`, CONFIRMATION_POLL_INTERVAL_SECONDS);
  },
});

async function sendMessage(withdrawalId: string, idempotencyKey: string, delaySeconds: number): Promise<string | null> {
  const message: QueueMessage = Object.freeze({ schemaVersion: RECONCILER_SCHEMA_VERSION, withdrawalId });
  const { messageId } = await send(QUEUE_TOPIC, message, {
    idempotencyKey,
    retentionSeconds: QUEUE_RETENTION_SECONDS,
    delaySeconds,
  });
  return messageId;
}
