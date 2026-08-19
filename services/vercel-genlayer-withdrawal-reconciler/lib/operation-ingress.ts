import type { ReconcilerConfig } from "./config";
import { requestFingerprint } from "./envelope";
import { project } from "./operation-service";
import type { QueuePublisher } from "./queue-publisher";
import type { ReconciliationRepository, ReconciliationRequest } from "./types";

export class ReconciliationIngressService {
  constructor(
    private readonly repository: ReconciliationRepository,
    private readonly queue: QueuePublisher,
    private readonly config: ReconcilerConfig,
  ) {}

  async accept(request: ReconciliationRequest) {
    const created = await this.repository.createOrReplay(request, requestFingerprint(request, this.config));
    const generation = created.record.enqueueAttempts + 1;
    const messageId = await this.queue.submit(request.withdrawalId, generation);
    const record = await this.repository.recordQueueAccepted(request.withdrawalId, messageId);
    return Object.freeze({ replayed: created.replayed, reconciliation: project(record) });
  }
}
