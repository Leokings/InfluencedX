import { runGenLayerJournalReconciliationBatch } from "./marketplace-genlayer-journal.ts";
import { runGenLayerProgressionBatch } from "./marketplace-genlayer-progression.ts";

/** Runs direct-write repair before deadline automation sees the projections. */
export async function runGenLayerMaintenanceBatch(options: {
  nowMs?: number;
  journalLimit?: number;
  progressionLimit?: number;
} = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const journal = await runGenLayerJournalReconciliationBatch({
    nowMs,
    limit: options.journalLimit,
  });
  const progression = await runGenLayerProgressionBatch({
    nowMs,
    limit: options.progressionLimit,
  });
  return Object.freeze({ journal, progression });
}
