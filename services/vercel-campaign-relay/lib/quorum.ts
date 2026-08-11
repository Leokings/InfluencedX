import {
  getAddress,
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import type { RelayConfig } from "./config";
import { BASE_SEPOLIA_CHAIN_ID, campaignResolutionTypes } from "./constants";
import { RelayProblem } from "./problem";
import type {
  ResolutionContext,
  SerializedResolutionMessage,
  WatcherSignature,
} from "./types";

export type VerifiedQuorum = Readonly<{
  digest: Hex;
  message: SerializedResolutionMessage;
  signers: readonly Address[];
  signatures: readonly Hex[];
}>;

export async function verifyWatcherQuorum(input: {
  responses: readonly WatcherSignature[];
  context: ResolutionContext;
  independentMessage: SerializedResolutionMessage;
  enabledWatchers: ReadonlySet<string>;
  threshold: number;
  config: RelayConfig;
  nowEpoch?: number;
}): Promise<VerifiedQuorum> {
  if (!Number.isSafeInteger(input.threshold) || input.threshold < 2 || input.threshold > input.config.watchers.length) reject("Receiver threshold is invalid.");
  const expectedAddresses = new Set(input.config.watchers.map((watcher) => watcher.address.toLowerCase()));
  const unique = new Map<string, { signer: Address; signature: Hex }>();
  const independentKey = canonicalMessage(input.independentMessage);
  const typedData = typed(input.independentMessage, input.config.receiver);
  const expectedDigest = hashTypedData(typedData);
  const nowEpoch = input.nowEpoch ?? Math.floor(Date.now() / 1_000);
  if (BigInt(input.independentMessage.relayDeadline) < BigInt(nowEpoch)) reject("Relay deadline expired before quorum validation.");
  if (input.independentMessage.requestId !== input.context.requestId || input.independentMessage.assignmentId !== input.context.assignmentId || input.independentMessage.genlayerTxHash !== input.context.genlayerTxHash) reject("Independent resolution does not match the persisted request.");
  const expectedOutcome = { PASS: 1, FAIL: 2, UNDETERMINED: 3 }[input.context.expectedOutcome];
  if (input.independentMessage.outcome !== expectedOutcome) reject("Independent outcome does not match finalized marketplace state.");

  for (const response of input.responses) {
    const signer = getAddress(response.signer);
    const key = signer.toLowerCase();
    if (response.requestId !== input.context.requestId || response.message.requestId !== input.context.requestId) reject("Watcher signed another request.");
    if (!expectedAddresses.has(key) || !input.enabledWatchers.has(key)) reject("Watcher signer is not enabled and configured.");
    if (unique.has(key)) reject("Watcher quorum contains a duplicate signer.");
    if (response.digest !== expectedDigest || canonicalMessage(response.message) !== independentKey) reject("Watchers did not sign the independently derived resolution.");
    const recovered = await recoverTypedDataAddress({ ...typedData, signature: response.signature });
    if (getAddress(recovered) !== signer) reject("Watcher signature recovery mismatch.");
    unique.set(key, { signer, signature: response.signature });
  }
  if (unique.size < input.threshold) throw new RelayProblem(503, "WATCHER_QUORUM_UNAVAILABLE", "Not enough independent watchers signed this resolution.", true);
  const sorted = [...unique.values()].sort((left, right) => left.signer.toLowerCase().localeCompare(right.signer.toLowerCase()));
  return Object.freeze({
    digest: expectedDigest,
    message: input.independentMessage,
    signers: Object.freeze(sorted.map((entry) => entry.signer)),
    signatures: Object.freeze(sorted.map((entry) => entry.signature)),
  });
}

export function typed(message: SerializedResolutionMessage, receiver: Address) {
  return {
    domain: {
      name: "XProofAttestationReceiver",
      version: "2",
      chainId: BASE_SEPOLIA_CHAIN_ID,
      verifyingContract: getAddress(receiver),
    },
    types: campaignResolutionTypes,
    primaryType: "CampaignResolution" as const,
    message: {
      requestId: message.requestId,
      assignmentId: BigInt(message.assignmentId),
      outcome: message.outcome,
      evidenceHash: message.evidenceHash,
      genlayerContract: message.genlayerContract,
      genlayerTxHash: message.genlayerTxHash,
      resolvedAt: BigInt(message.resolvedAt),
      relayDeadline: BigInt(message.relayDeadline),
    },
  } as const;
}

function canonicalMessage(message: SerializedResolutionMessage): string {
  return JSON.stringify({
    requestId: message.requestId,
    assignmentId: message.assignmentId,
    outcome: message.outcome,
    evidenceHash: message.evidenceHash,
    genlayerContract: message.genlayerContract,
    genlayerTxHash: message.genlayerTxHash,
    resolvedAt: message.resolvedAt,
    relayDeadline: message.relayDeadline,
  });
}

function reject(message: string): never {
  throw new RelayProblem(409, "WATCHER_QUORUM_REJECTED", message);
}
