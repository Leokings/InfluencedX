import {
  marketplaceMaintenanceGenerationIsActive,
} from "./marketplace-genlayer-maintenance-generation.ts";
import {
  MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS,
  enqueueMarketplaceMaintenanceHeartbeat,
  validateMarketplaceMaintenanceMessage,
} from "./marketplace-genlayer-maintenance-queue.ts";
import { runGenLayerMaintenanceBatch } from "./marketplace-genlayer-maintenance.ts";

export type MarketplaceMaintenanceWorkerResult = Readonly<{
  kind: "PROCESSED" | "STALE" | "SUPERSEDED";
}>;

/**
 * Processes a clock-only message under a database-authorized deployment fence.
 * A stale delivery returns normally so Vercel acknowledges it, and it never
 * performs work or extends its deployment-local heartbeat chain.
 */
export async function processMarketplaceMaintenanceHeartbeat(
  payload: unknown,
  dependencies: {
    isActive?: typeof marketplaceMaintenanceGenerationIsActive;
    runMaintenance?: typeof runGenLayerMaintenanceBatch;
    enqueue?: typeof enqueueMarketplaceMaintenanceHeartbeat;
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

  await (dependencies.runMaintenance ?? runGenLayerMaintenanceBatch)();

  // A deployment may be promoted while the bounded batch is running. Prove
  // ownership again before extending this deployment-local queue chain.
  if (!(await isActive(expected))) {
    return Object.freeze({ kind: "SUPERSEDED" });
  }
  await (dependencies.enqueue ?? enqueueMarketplaceMaintenanceHeartbeat)({
    delaySeconds: MARKETPLACE_MAINTENANCE_INTERVAL_SECONDS,
  });
  return Object.freeze({ kind: "PROCESSED" });
}
