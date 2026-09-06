import { runGenLayerJournalReconciliationBatch } from "./marketplace-genlayer-journal.ts";
import { runGenLayerProgressionBatch } from "./marketplace-genlayer-progression.ts";
import { runGenLayerSharedObservationRepairBatch } from "./marketplace-genlayer-shared-observation.ts";
import { releaseExpiredFinalizedNativeVerificationRuns } from "./verification-native-service.ts";

/** Runs direct-write repair before deadline automation sees the projections. */
export async function runGenLayerMaintenanceBatch(options: {
  nowMs?: number;
  journalLimit?: number;
  sharedObservationLimit?: number;
  progressionLimit?: number;
} = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const journal = await runGenLayerJournalReconciliationBatch({
    nowMs,
    limit: options.journalLimit,
  });
  const sharedObservation = await runGenLayerSharedObservationRepairBatch({
    nowMs,
    limit: options.sharedObservationLimit,
  });
  const verification = await releaseExpiredFinalizedNativeVerificationRuns({
    nowMs,
  });
  const progression = await runGenLayerProgressionBatch({
    nowMs,
    limit: options.progressionLimit,
  });
  return Object.freeze({ journal, sharedObservation, verification, progression });
}
