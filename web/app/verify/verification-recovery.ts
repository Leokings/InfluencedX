export type IdentityBundleRecovery = Readonly<{
  requestId: string;
}>;

export type BoundIdentityBundleRecovery = Readonly<{
  requestId: string;
  preparedId: string;
  txHash: string;
}>;

export type IdentityBundleRecoveryRequest = Readonly<{
  id: string;
  status: string;
  identityBundleReady?: boolean;
  tweetText?: string | null;
  farcasterCastText?: string | null;
  genlayerOutcome?: "VERIFIED" | "REJECTED" | "UNDETERMINED" | null;
  genlayerRetryable?: boolean | null;
}>;

export function recoveryMatchesActiveBundle(
  recovery: IdentityBundleRecovery | null,
  request: IdentityBundleRecoveryRequest | null,
): boolean {
  if (!recovery || !request || recovery.requestId !== request.id || request.status === "EXPIRED") return false;
  if (!request.identityBundleReady && !(request.tweetText && request.farcasterCastText)) return false;
  if (request.genlayerOutcome === "VERIFIED" || request.genlayerOutcome === "REJECTED") return false;
  if (request.genlayerOutcome === "UNDETERMINED" && !request.genlayerRetryable) return false;
  return true;
}

export function parseBoundIdentityBundleRecovery(
  value: unknown,
  expectedRequestId?: string,
): BoundIdentityBundleRecovery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "preparedId,requestId,txHash") return null;
  if (
    typeof record.requestId !== "string"
    || typeof record.preparedId !== "string"
    || typeof record.txHash !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.requestId)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.preparedId)
    || !/^0x[0-9a-f]{64}$/i.test(record.txHash)
    || (expectedRequestId !== undefined && record.requestId !== expectedRequestId)
  ) return null;
  return Object.freeze({
    requestId: record.requestId,
    preparedId: record.preparedId,
    txHash: record.txHash.toLowerCase(),
  });
}
