import { envelopeFingerprint, submissionCallFingerprint } from "./envelope";
import type { QueuePublisher } from "./queue-publisher";
import { project } from "./submission-service";
import type { SubmissionEnvelope, SubmissionProjection, SubmissionRepository } from "./types";

export class SubmissionIngressService {
  constructor(
    private readonly repository: SubmissionRepository,
    private readonly queue: QueuePublisher,
  ) {}

  async accept(envelope: SubmissionEnvelope): Promise<{ replayed: boolean; submission: SubmissionProjection }> {
    const created = await this.repository.createOrReplay(
      envelope,
      envelopeFingerprint(envelope),
      submissionCallFingerprint(envelope),
    );
    let record = created.record;
    if (["QUEUED", "PRECHECK_FAILED"].includes(record.status)) {
      const messageId = await this.queue.submit(envelope.requestId);
      record = await this.repository.recordQueueAccepted(envelope.requestId, messageId);
    }
    return { replayed: created.replayed, submission: project(record) };
  }
}
