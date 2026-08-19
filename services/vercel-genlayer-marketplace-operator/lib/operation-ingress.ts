import { callFingerprint, envelopeFingerprint } from "./envelope";
import { project } from "./operation-service";
import type { QueuePublisher } from "./queue-publisher";
import type { OperationEnvelope, OperatorRepository } from "./types";

export class OperationIngressService {
  constructor(
    private readonly repository: OperatorRepository,
    private readonly queue: QueuePublisher,
  ) {}

  async accept(envelope: OperationEnvelope) {
    const created = await this.repository.createOrReplay(
      envelope,
      envelopeFingerprint(envelope),
      callFingerprint(envelope),
    );
    // The durable operation ID remains the execution idempotency boundary. The
    // queue generation must advance on ingress replay because Vercel retains a
    // consumed idempotency key for the topic retention window.
    const generation = created.record.enqueueAttempts + 1;
    const messageId = await this.queue.submit(envelope.operationId, generation);
    const record = await this.repository.recordQueueAccepted(envelope.operationId, messageId);
    return Object.freeze({ replayed: created.replayed, operation: project(record) });
  }
}
