import { DuplicateMessageError, send } from "@vercel/queue";
import { ApiProblem } from "./verification-api.ts";

export const CAMPAIGN_PROGRESSION_QUEUE_TOPIC =
  "influencedx-studionet-campaign-progression-v2";
export const CAMPAIGN_PROGRESSION_QUEUE_SCHEMA_VERSION = 1;
export const CAMPAIGN_PROGRESSION_QUEUE_RETENTION_SECONDS =
  7 * 24 * 60 * 60;

export type CampaignProgressionQueueMessage = Readonly<{
  schemaVersion: 1;
  requestId: string;
  campaignId: string;
  applicationId: string;
}>;

type QueueSend = typeof send;

/**
 * Publishes only the immutable identifiers persisted from the confirmed Base
 * resolution-request event. Vercel OIDC authenticates the SDK; no application
 * signer, watcher key, or raw X evidence is included in the message.
 */
export async function enqueueCampaignProgression(
  input: Omit<CampaignProgressionQueueMessage, "schemaVersion">,
  sendImplementation: QueueSend = send,
): Promise<Readonly<{ messageId: string | null }>> {
  const message = validateCampaignProgressionQueueMessage({
    schemaVersion: CAMPAIGN_PROGRESSION_QUEUE_SCHEMA_VERSION,
    ...input,
  });
  try {
    const result = await sendImplementation(
      CAMPAIGN_PROGRESSION_QUEUE_TOPIC,
      message,
      {
        idempotencyKey: `influencedx-campaign-progression:${message.requestId}`,
        retentionSeconds: CAMPAIGN_PROGRESSION_QUEUE_RETENTION_SECONDS,
        delaySeconds: 0,
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
    "applicationId",
    "campaignId",
    "requestId",
    "schemaVersion",
  ];
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    value.schemaVersion !== CAMPAIGN_PROGRESSION_QUEUE_SCHEMA_VERSION ||
    !uuid(value.campaignId) ||
    !uuid(value.applicationId) ||
    typeof value.requestId !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(value.requestId)
  ) {
    throw invalidMessage();
  }
  return Object.freeze({
    schemaVersion: CAMPAIGN_PROGRESSION_QUEUE_SCHEMA_VERSION,
    requestId: value.requestId,
    campaignId: value.campaignId,
    applicationId: value.applicationId,
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

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
