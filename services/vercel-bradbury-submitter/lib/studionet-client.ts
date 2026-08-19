import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionHashVariant, type CalldataEncodable, type TransactionHash } from "genlayer-js/types";

import {
  CAMPAIGN_SUBMITTER_METHOD,
  METRICS_SUBMITTER_METHOD,
  STUDIONET_CHAIN_ID,
  SUBMITTER_METHOD,
} from "./constants";
import type { SubmitterConfig } from "./config";
import {
  campaignSubmissionArgs,
  metricsSubmissionArgs,
  submissionArgs,
} from "./envelope";
import type {
  CampaignEnvelope,
  MetricsEnvelope,
  OwnershipEnvelope,
  Receipt,
  StudioNetClient,
} from "./types";

export function createPinnedStudioNetClient(config: SubmitterConfig): StudioNetClient {
  if (studionet.id !== STUDIONET_CHAIN_ID || config.chainId !== STUDIONET_CHAIN_ID) {
    throw new Error("The genlayer-js StudioNet chain ID does not match the pinned submitter chain ID.");
  }
  const account = createAccount(config.privateKey);
  const client = createClient({ chain: studionet, endpoint: config.rpcUrl, account });

  return Object.freeze({
    signerAddress: account.address.toLowerCase(),
    async submitOwnership(envelope: OwnershipEnvelope) {
      return client.writeContract({
        account,
        address: config.resolver,
        functionName: SUBMITTER_METHOD,
        args: [...submissionArgs(envelope)] as CalldataEncodable[],
        value: 0n,
      });
    },
    async submitCampaign(envelope: CampaignEnvelope) {
      return client.writeContract({
        account,
        address: config.resolver,
        functionName: CAMPAIGN_SUBMITTER_METHOD,
        args: [...campaignSubmissionArgs(envelope)] as CalldataEncodable[],
        value: 0n,
      });
    },
    async submitMetrics(envelope: MetricsEnvelope) {
      return client.writeContract({
        account,
        address: config.resolver,
        functionName: METRICS_SUBMITTER_METHOD,
        args: [...metricsSubmissionArgs(envelope)] as CalldataEncodable[],
        value: 0n,
      });
    },
    async getTransaction(txHash: string) {
      return await client.getTransaction({ hash: txHash as TransactionHash }) as Receipt;
    },
    readExistingResult(requestId: string) {
      return readResult(client, config.resolver, requestId, TransactionHashVariant.LATEST_NONFINAL);
    },
    readFinalResult(requestId: string) {
      return readResult(client, config.resolver, requestId, TransactionHashVariant.LATEST_FINAL);
    },
  });
}

async function readResult(
  client: ReturnType<typeof createClient>,
  resolver: string,
  requestId: string,
  transactionHashVariant: TransactionHashVariant,
): Promise<unknown> {
  const raw = await client.readContract({
    address: resolver as `0x${string}`,
    functionName: "get_result",
    args: [requestId],
    transactionHashVariant,
  });
  if (raw === "") return null;
  if (typeof raw !== "string") throw new Error("Resolver result is not a string.");
  return JSON.parse(raw) as unknown;
}
