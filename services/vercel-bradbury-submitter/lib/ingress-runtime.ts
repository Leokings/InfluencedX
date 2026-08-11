import { loadConfig } from "./config";
import { repositoryFor } from "./postgres-repository";
import { vercelQueuePublisher } from "./queue-publisher";
import { SubmissionIngressService } from "./submission-ingress";

export function createIngressRuntime() {
  const config = loadConfig();
  const repository = repositoryFor(config.databaseUrl);
  const ingress = new SubmissionIngressService(repository, vercelQueuePublisher);
  return Object.freeze({ config, repository, ingress });
}

export function createStatusRuntime() {
  const config = loadConfig();
  const repository = repositoryFor(config.databaseUrl);
  return Object.freeze({ config, repository });
}
