import { DuplicateMessageError, send } from "@vercel/queue";

export const MARKETPLACE_MAINTENANCE_QUEUE_TOPIC =
  "influencedx-studionet-maintenance-v1";
export const MARKETPLACE_MAINTENANCE_QUEUE_SCHEMA_VERSION = 1;
export const MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS = 5 * 60;
export const MARKETPLACE_MAINTENANCE_RETENTION_SECONDS = 7 * 24 * 60 * 60;

export type MarketplaceMaintenanceMessage = Readonly<{
  schemaVersion: 1;
  slot: number;
}>;

type QueueSend = typeof send;

/**
 * Publishes a deployment-local heartbeat only. Every operation and transaction
 * binding is loaded from fenced Neon journals by the consumer.
 */
export async function enqueueMarketplaceMaintenanceHeartbeat(
  input: { nowMs?: number; delaySeconds?: number } = {},
  sendImplementation: QueueSend = send,
): Promise<Readonly<{ messageId: string | null; slot: number }>> {
  const nowMs = input.nowMs ?? Date.now();
  const delaySeconds = input.delaySeconds ?? 0;
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error("The marketplace maintenance clock is invalid.");
  }
  if (
    !Number.isSafeInteger(delaySeconds) ||
    delaySeconds < 0 ||
    delaySeconds > MARKETPLACE_MAINTENANCE_RETENTION_SECONDS
  ) {
    throw new Error("The marketplace maintenance delay is invalid.");
  }
  const slot = Math.floor(
    (nowMs + delaySeconds * 1_000) /
      (MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS * 1_000),
  );
  const message = validateMarketplaceMaintenanceMessage({
    schemaVersion: MARKETPLACE_MAINTENANCE_QUEUE_SCHEMA_VERSION,
    slot,
  });
  try {
    const result = await sendImplementation(
      MARKETPLACE_MAINTENANCE_QUEUE_TOPIC,
      message,
      {
        idempotencyKey: `influencedx-studionet-maintenance-v1:${slot}`,
        retentionSeconds: MARKETPLACE_MAINTENANCE_RETENTION_SECONDS,
        delaySeconds,
      },
    );
    return Object.freeze({ messageId: result.messageId, slot });
  } catch (error) {
    if (error instanceof DuplicateMessageError) {
      return Object.freeze({ messageId: null, slot });
    }
    throw error;
  }
}

export function validateMarketplaceMaintenanceMessage(
  value: unknown,
): MarketplaceMaintenanceMessage {
  if (!plainObject(value)) throw new MarketplaceMaintenanceMessageError();
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "schemaVersion" ||
    keys[1] !== "slot" ||
    value.schemaVersion !== MARKETPLACE_MAINTENANCE_QUEUE_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.slot) ||
    (value.slot as number) <= 0
  ) {
    throw new MarketplaceMaintenanceMessageError();
  }
  return Object.freeze({
    schemaVersion: MARKETPLACE_MAINTENANCE_QUEUE_SCHEMA_VERSION,
    slot: value.slot as number,
  });
}

export class MarketplaceMaintenanceMessageError extends Error {
  constructor() {
    super("The marketplace maintenance heartbeat is invalid.");
    this.name = "MarketplaceMaintenanceMessageError";
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
