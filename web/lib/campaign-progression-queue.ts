import { DuplicateMessageError, send } from "@vercel/queue";
import { ApiProblem } from "./verification-api.ts";

export const CAMPAIGN_PROGRESSION_QUEUE_TOPIC =
  "influencedx-studionet-campaign-progression-v3";
export const CAMPAIGN_PROGRESSION_QUEUE_SCHEMA_VERSION = 2;
export const CAMPAIGN_PROGRESSION_QUEUE_RETENTION_SECONDS =
  7 * 24 * 60 * 60;

export type CampaignProgressionQueueMessage = Readonly<{
  schemaVersion: 2;
  assignmentId: string;
  requestId: string;
}>;

type QueueSend = typeof send;

/**
 * Publishes only the immutable identifiers projected from the finalized
 * GenLayer resolution request. Vercel OIDC authenticates the SDK; no signer
 * key or raw social evidence is included in the message.
 */
export async function enqueueCampaignProgression(
  input: Omit<CampaignProgressionQueueMessage, "schemaVersion"> & {
    delaySeconds?: number;
  },
  sendImplementation: QueueSend = send,
): Promise<Readonly<{ messageId: string | null }>> {
  const delaySeconds = input.delaySeconds ?? 0;
  if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > CAMPAIGN_PROGRESSION_QUEUE_RETENTION_SECONDS) {
    throw new Error("The campaign progression delay is invalid.");
  }
  const message = validateCampaignProgressionQueueMessage({
    schemaVersion: CAMPAIGN_PROGRESSION_QUEUE_SCHEMA_VERSION,
    assignmentId: input.assignmentId,
    requestId: input.requestId,
  });
  try {
    const result = await sendImplementation(
      CAMPAIGN_PROGRESSION_QUEUE_TOPIC,
      message,
      {
        idempotencyKey: `influencedx-campaign-progression-v3:${message.assignmentId}:${message.requestId}`,
        retentionSeconds: CAMPAIGN_PROGRESSION_QUEUE_RETENTION_SECONDS,
        delaySeconds,
      },
    );
    return Object.freeze({ messageId: result.messageId });
  } catch (error) {
    if (error instanceof DuplicateMessageError) {
      return Object.freeze({ messageId: null });
    }
    throw new ApiProblem(
      503,
      "CAMPAIGN_PROGRESSION_QUEUE_UNAVAILABLE",
      "The confirmed resolution is durable, but automatic progression could not be queued yet. Retrying this confirmation is safe.",
    );
  }
}

export function validateCampaignProgressionQueueMessage(
  value: unknown,
): CampaignProgressionQueueMessage {
  if (!plainObject(value)) throw invalidMessage();
  const expectedKeys = [
    "assignmentId",
    "requestId",
    "schemaVersion",
  ];
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    value.schemaVersion !== CAMPAIGN_PROGRESSION_QUEUE_SCHEMA_VERSION ||
    typeof value.assignmentId !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(value.assignmentId) ||
    typeof value.requestId !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(value.requestId)
  ) {
    throw invalidMessage();
  }
  return Object.freeze({
    schemaVersion: CAMPAIGN_PROGRESSION_QUEUE_SCHEMA_VERSION,
    assignmentId: value.assignmentId,
    requestId: value.requestId,
  });
}

function invalidMessage(): CampaignProgressionQueueMessageError {
  return new CampaignProgressionQueueMessageError();
}

export class CampaignProgressionQueueMessageError extends Error {
  constructor() {
    super("The campaign progression queue message is invalid.");
    this.name = "CampaignProgressionQueueMessageError";
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
