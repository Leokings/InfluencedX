import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiProblem } from "./verification-api.ts";

const PURPOSE = "influencedx:activation-receipt:v1\0";
const TTL_MS = 24 * 60 * 60 * 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Binding = Readonly<{
  preparedId: string;
  requestId: string;
  subject: string;
  wallet: string;
  contractAddress: string;
}>;
type Options = { secret?: string; nowMs?: number };

/** A receipt-only capability. It cannot sign in, prepare, cancel, or withdraw. */
export function issueActivationReceiptCapability(binding: Binding, options: Options = {}): string {
  const payload = {
    version: 1,
    ...binding,
    wallet: binding.wallet.toLowerCase(),
    contractAddress: binding.contractAddress.toLowerCase(),
    expiresAt: (options.nowMs ?? Date.now()) + TTL_MS,
  };
  if (!validPayload(payload)) throw new Error("Invalid activation receipt binding.");
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${mac(encoded, options.secret).toString("base64url")}`;
}

export function readActivationReceiptCapability(
  token: unknown,
  expected: Pick<Binding, "preparedId" | "contractAddress">,
  options: Options = {},
): Binding {
  if (typeof token !== "string" || token.length > 2_048) invalid();
  const parts = token.split(".");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) invalid();
  const [encoded, signature] = parts;
  const supplied = Buffer.from(signature, "base64url");
  const expectedMac = mac(encoded, options.secret);
  if (supplied.toString("base64url") !== signature || supplied.length !== expectedMac.length || !timingSafeEqual(supplied, expectedMac)) invalid();
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { invalid(); }
  if (!validPayload(payload)) invalid();
  if (
    payload.preparedId !== expected.preparedId
    || payload.contractAddress !== expected.contractAddress.toLowerCase()
    || payload.expiresAt <= (options.nowMs ?? Date.now())
    || payload.expiresAt > (options.nowMs ?? Date.now()) + TTL_MS
  ) invalid();
  return { preparedId: payload.preparedId, requestId: payload.requestId, subject: payload.subject, wallet: payload.wallet, contractAddress: payload.contractAddress };
}

function validPayload(value: unknown): value is Binding & { version: 1; expiresAt: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "contractAddress,expiresAt,preparedId,requestId,subject,version,wallet"
    && record.version === 1
    && typeof record.preparedId === "string" && UUID.test(record.preparedId)
    && typeof record.requestId === "string" && UUID.test(record.requestId)
    && typeof record.subject === "string" && /^[A-Za-z0-9_-]{43}$/.test(record.subject)
    && typeof record.wallet === "string" && /^0x[0-9a-f]{40}$/.test(record.wallet)
    && typeof record.contractAddress === "string" && /^0x[0-9a-f]{40}$/.test(record.contractAddress)
    && typeof record.expiresAt === "number" && Number.isSafeInteger(record.expiresAt);
}

function mac(encoded: string, override?: string): Buffer {
  const secret = override ?? process.env.AUTH_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error("AUTH_SECRET must contain at least 32 bytes.");
  return createHmac("sha256", secret).update(PURPOSE).update(encoded).digest();
}

function invalid(): never {
  throw new ApiProblem(401, "ACTIVATION_RECEIPT_UNAUTHORIZED", "Sign in again to recover this transaction.");
}
