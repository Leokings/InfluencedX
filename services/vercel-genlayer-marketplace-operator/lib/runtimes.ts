import { loadConfig } from "./config";
import { OperationIngressService } from "./operation-ingress";
import { OperationService } from "./operation-service";
import { vercelQueuePublisher } from "./queue-publisher";
import { repositoryFor } from "./repository";
import { createPinnedMarketplaceClient } from "./studionet-client";

export function createIngressRuntime() {
  const config = loadConfig();
  const repository = repositoryFor(config.databaseUrl);
  const ingress = new OperationIngressService(repository, vercelQueuePublisher);
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
  const service = new OperationService(
    repository,
    createPinnedMarketplaceClient(config),
    vercelQueuePublisher,
  );
  return Object.freeze({ repository, service });
}
