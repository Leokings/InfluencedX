import { loadConfig } from "./config";
import { ReconciliationIngressService } from "./operation-ingress";
import { ReconciliationService } from "./operation-service";
import { vercelQueuePublisher } from "./queue-publisher";
import { repositoryFor } from "./repository";
import { createPinnedWithdrawalClient } from "./studionet-client";

export function createIngressRuntime() {
  const config = loadConfig();
  const repository = repositoryFor(config.databaseUrl);
  const ingress = new ReconciliationIngressService(repository, vercelQueuePublisher, config);
  return Object.freeze({ config, repository, ingress });
}

export function createStatusRuntime() {
  const config = loadConfig();
  const repository = repositoryFor(config.databaseUrl);
  return Object.freeze({ config, repository });
}

export function createConsumerRuntime() {
  const config = loadConfig();
  const repository = repositoryFor(config.databaseUrl);
  const service = new ReconciliationService(
    repository,
    createPinnedWithdrawalClient(config),
    vercelQueuePublisher,
  );
  return Object.freeze({ repository, service });
}
