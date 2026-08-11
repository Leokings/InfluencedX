import { createPinnedBradburyClient } from "./bradbury-client";
import { loadConfig } from "./config";
import { repositoryFor } from "./postgres-repository";
import { vercelQueuePublisher } from "./queue-publisher";
import { SubmissionService } from "./submission-service";

export function createConsumerRuntime() {
  const config = loadConfig();
  const repository = repositoryFor(config.databaseUrl);
  const service = new SubmissionService(repository, createPinnedBradburyClient(config), vercelQueuePublisher);
  return Object.freeze({ repository, service });
}
