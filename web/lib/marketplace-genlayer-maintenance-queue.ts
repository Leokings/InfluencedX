import { DuplicateMessageError, send } from "@vercel/queue";
import {
  readCurrentMarketplaceMaintenanceGeneration,
  type MarketplaceMaintenanceGeneration,
} from "./marketplace-genlayer-maintenance-generation.ts";

export const MARKETPLACE_MAINTENANCE_QUEUE_TOPIC =
  "influencedx-studionet-maintenance-v2";
export const MARKETPLACE_MAINTENANCE_QUEUE_SCHEMA_VERSION = 2;
export const MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS = 5 * 60;
export const MARKETPLACE_MAINTENANCE_RETENTION_SECONDS = 7 * 24 * 60 * 60;

export type MarketplaceMaintenanceMessage = Readonly<{
  schemaVersion: 2;
  deploymentId: string;
  generation: number;
  slot: number;
}>;

type QueueSend = typeof send;
type QueueDependencies = Readonly<{
  send?: QueueSend;
  readGeneration?: () => Promise<MarketplaceMaintenanceGeneration | null>;
}>;

/**
 * Publishes a deployment-local heartbeat only. Every operation and transaction
 * binding is loaded from fenced Neon journals by the consumer.
 */
export async function enqueueMarketplaceMaintenanceHeartbeat(
  input: { nowMs?: number; delaySeconds?: number } = {},
  dependencies: QueueDependencies = {},
): Promise<
  Readonly<{
    messageId: string | null;
    deploymentId: string;
    generation: number;
    slot: number;
  }>
> {
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
  const activeGeneration = await (
    dependencies.readGeneration ?? readCurrentMarketplaceMaintenanceGeneration
  )();
  if (!activeGeneration) {
    throw new MarketplaceMaintenanceGenerationInactiveError();
  }
  const message = validateMarketplaceMaintenanceMessage({
    schemaVersion: MARKETPLACE_MAINTENANCE_QUEUE_SCHEMA_VERSION,
    deploymentId: activeGeneration.deploymentId,
    generation: activeGeneration.generation,
    slot,
  });
  try {
    const result = await (dependencies.send ?? send)(
      MARKETPLACE_MAINTENANCE_QUEUE_TOPIC,
      message,
      {
        idempotencyKey: `influencedx-studionet-maintenance-v2:${message.deploymentId}:${message.generation}:${slot}`,
        retentionSeconds: MARKETPLACE_MAINTENANCE_RETENTION_SECONDS,
        delaySeconds,
      },
    );
    return Object.freeze({
      messageId: result.messageId,
      deploymentId: message.deploymentId,
      generation: message.generation,
      slot,
    });
  } catch (error) {
    if (error instanceof DuplicateMessageError) {
      return Object.freeze({
        messageId: null,
        deploymentId: message.deploymentId,
        generation: message.generation,
        slot,
      });
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
    keys.length !== 4 ||
    keys[0] !== "deploymentId" ||
    keys[1] !== "generation" ||
    keys[2] !== "schemaVersion" ||
    keys[3] !== "slot" ||
    value.schemaVersion !== MARKETPLACE_MAINTENANCE_QUEUE_SCHEMA_VERSION ||
    typeof value.deploymentId !== "string" ||
    !/^dpl_[A-Za-z0-9]{16,96}$/.test(value.deploymentId) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) <= 0 ||
    !Number.isSafeInteger(value.slot) ||
    (value.slot as number) <= 0
  ) {
    throw new MarketplaceMaintenanceMessageError();
  }
  return Object.freeze({
    schemaVersion: MARKETPLACE_MAINTENANCE_QUEUE_SCHEMA_VERSION,
    deploymentId: value.deploymentId,
    generation: value.generation as number,
    slot: value.slot as number,
  });
}

export class MarketplaceMaintenanceMessageError extends Error {
  constructor() {
    super("The marketplace maintenance heartbeat is invalid.");
    this.name = "MarketplaceMaintenanceMessageError";
  }
}

export class MarketplaceMaintenanceGenerationInactiveError extends Error {
  constructor() {
    super("This deployment does not own the active marketplace maintenance generation.");
    this.name = "MarketplaceMaintenanceGenerationInactiveError";
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
