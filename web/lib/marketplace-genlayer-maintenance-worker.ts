import {
  MARKETPLACE_MAINTENANCE_SLOT_DURATION_MS,
  claimMarketplaceMaintenanceSlot,
  marketplaceMaintenanceGenerationIsActive,
} from "./marketplace-genlayer-maintenance-generation.ts";
import {
  MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS,
  MarketplaceMaintenanceMessageError,
  enqueueMarketplaceMaintenanceHeartbeat,
  validateMarketplaceMaintenanceMessage,
} from "./marketplace-genlayer-maintenance-queue.ts";
import { runGenLayerMaintenanceBatch } from "./marketplace-genlayer-maintenance.ts";
import type { MessageMetadata, RetryDirective } from "@vercel/queue";

export const MARKETPLACE_MAINTENANCE_RENEW_AFTER_DELIVERY = 20;
export const MARKETPLACE_MAINTENANCE_RENEW_BEFORE_EXPIRY_SECONDS = 60 * 60;
export const MARKETPLACE_MAINTENANCE_MIN_PRECLAIM_RETRY_SECONDS = 1;

export type MarketplaceMaintenanceWorkerResult =
  | Readonly<{ kind: "PROCESSED"; renewalPublished: boolean }>
  | Readonly<{ kind: "FUTURE"; retryAfterSeconds: number }>
  | Readonly<{
      kind: "STALE" | "SUPERSEDED" | "DUPLICATE" | "LEASED_DUPLICATE";
    }>;

export type MarketplaceMaintenanceDelivery = Readonly<
  Pick<MessageMetadata, "messageId" | "deliveryCount" | "expiresAt">
>;

/**
 * Processes a clock-only message under a database-authorized deployment fence.
 * A stale delivery returns normally so Vercel acknowledges it, and it never
 * performs work or extends its deployment-local heartbeat chain.
 */
export async function processMarketplaceMaintenanceHeartbeat(
  payload: unknown,
  delivery: MarketplaceMaintenanceDelivery,
  dependencies: {
    isActive?: typeof marketplaceMaintenanceGenerationIsActive;
    claimSlot?: typeof claimMarketplaceMaintenanceSlot;
    runMaintenance?: typeof runGenLayerMaintenanceBatch;
    enqueue?: typeof enqueueMarketplaceMaintenanceHeartbeat;
    nowMs?: () => number;
  } = {},
): Promise<MarketplaceMaintenanceWorkerResult> {
  const message = validateMarketplaceMaintenanceMessage(payload);
  const expected = Object.freeze({
    deploymentId: message.deploymentId,
    generation: message.generation,
  });
  const isActive = dependencies.isActive ?? marketplaceMaintenanceGenerationIsActive;
  if (!(await isActive(expected))) {
    return Object.freeze({ kind: "STALE" });
  }

  const nowMs = (dependencies.nowMs ?? Date.now)();
  const currentSlot = Math.floor(
    nowMs / MARKETPLACE_MAINTENANCE_SLOT_DURATION_MS,
  );
  if (message.slot > currentSlot + 1) {
    // Queue traffic is internal, but an impossible clock must not consume the
    // finite retry budget forever.
    throw new MarketplaceMaintenanceMessageError();
  }
  if (message.slot === currentSlot + 1) {
    return Object.freeze({
      kind: "FUTURE",
      retryAfterSeconds: Math.min(
        MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS,
        Math.max(
          MARKETPLACE_MAINTENANCE_MIN_PRECLAIM_RETRY_SECONDS,
          Math.ceil(
            (message.slot * MARKETPLACE_MAINTENANCE_SLOT_DURATION_MS - nowMs) /
              1_000,
          ),
        ),
      ),
    });
  }
  const claim = await (
    dependencies.claimSlot ?? claimMarketplaceMaintenanceSlot
  )({
    expected,
    messageId: delivery.messageId,
    nowMs,
  });
  if (claim === "SAME_MESSAGE") {
    // Never acknowledge a concurrent duplicate delivery of the same queue
    // message. The delivery that owns the slot may still fail before it can
    // arrange redelivery, so this receipt remains a liveness fallback.
    return Object.freeze({ kind: "LEASED_DUPLICATE" });
  }
  if (claim === "CONFLICT") {
    return Object.freeze({
      kind: (await isActive(expected)) ? "DUPLICATE" : "SUPERSEDED",
    });
  }

  const renewalPublished = marketplaceMaintenanceHeartbeatNeedsRenewal(
    delivery,
    nowMs,
  );
  if (renewalPublished) {
    // Prove ownership immediately before renewal. Publication happens before
    // the fallible maintenance batch so a persistent RPC or row-level failure
    // cannot carry the only live message into forced backoff and TTL expiry.
    if (!(await isActive(expected))) {
      return Object.freeze({ kind: "SUPERSEDED" });
    }
    // Publish a fresh message before the retry attempt budget reaches the
    // service's forced-backoff range. The current message deliberately stays
    // unacknowledged until a distinct successor actually receives and wins a
    // database slot; accepted-but-never-notified sends therefore cannot break
    // the heartbeat.
    await (dependencies.enqueue ?? enqueueMarketplaceMaintenanceHeartbeat)({
      nowMs,
      slot: "NEXT",
    });
  }

  await (dependencies.runMaintenance ?? runGenLayerMaintenanceBatch)();

  // A deployment may be promoted while the bounded batch is running. Prove
  // ownership again before continuing this deployment-local heartbeat.
  if (!(await isActive(expected))) {
    return Object.freeze({ kind: "SUPERSEDED" });
  }
  return Object.freeze({ kind: "PROCESSED", renewalPublished });
}

export function marketplaceMaintenanceHeartbeatNeedsRenewal(
  delivery: MarketplaceMaintenanceDelivery,
  nowMs: number,
): boolean {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) return true;
  if (
    !Number.isSafeInteger(delivery.deliveryCount) ||
    delivery.deliveryCount < 1
  ) {
    return true;
  }
  if (delivery.deliveryCount >= MARKETPLACE_MAINTENANCE_RENEW_AFTER_DELIVERY) {
    return true;
  }
  const expiresAtMs = delivery.expiresAt?.getTime();
  return (
    !Number.isSafeInteger(expiresAtMs) ||
    (expiresAtMs as number) - nowMs <=
      MARKETPLACE_MAINTENANCE_RENEW_BEFORE_EXPIRY_SECONDS * 1_000
  );
}

export class MarketplaceMaintenanceRedeliveryError extends Error {
  readonly afterSeconds: number;

  constructor(
    afterSeconds: number = MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS,
  ) {
    super("The active marketplace maintenance heartbeat must be redelivered.");
    this.name = "MarketplaceMaintenanceRedeliveryError";
    if (
      !Number.isSafeInteger(afterSeconds) ||
      afterSeconds < MARKETPLACE_MAINTENANCE_MIN_PRECLAIM_RETRY_SECONDS ||
      afterSeconds > MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS
    ) {
      throw new Error("The marketplace maintenance retry delay is invalid.");
    }
    this.afterSeconds = afterSeconds;
  }
}

export function marketplaceMaintenanceResultRetryAfterSeconds(
  result: MarketplaceMaintenanceWorkerResult,
): number | null {
  if (result.kind === "FUTURE") return result.retryAfterSeconds;
  if (result.kind === "PROCESSED" || result.kind === "LEASED_DUPLICATE") {
    return MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS;
  }
  return null;
}

export function marketplaceMaintenanceRetryDirective(
  error: unknown,
  metadata: Readonly<{ deliveryCount: number }>,
): RetryDirective {
  void metadata;
  if (error instanceof MarketplaceMaintenanceMessageError) {
    return { acknowledge: true };
  }
  if (error instanceof MarketplaceMaintenanceRedeliveryError) {
    return { afterSeconds: error.afterSeconds };
  }
  // A slot claim is durable. Retrying earlier than the next five-minute slot
  // could make the sole live message look like a duplicate and acknowledge it.
  // The same fixed delay is also the normal heartbeat cadence and avoids a
  // noisy/tight error loop; handleCallback converts this directive to a 200.
  return { afterSeconds: MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS };
}
