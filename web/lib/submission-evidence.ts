import {
  getAddress,
  isAddress,
  isHash,
  isHex,
  sha256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import {
  buildOwnershipSubmissionEnvelope,
  type OwnershipSubmissionEnvelope,
} from "./ownership-submission.ts";

const TOKEN_PREFIX = "xpe1";
const TOKEN_MAX_LENGTH = 4_096;

export type SubmissionEvidenceBinding = {
  verificationRequestId: string;
  ownerUserId: string;
  wallet: Address;
  finalizedRequestId: Hex;
};

export type SubmissionSealKeyring = {
  activeKeyId: string;
  keys: ReadonlyMap<string, string>;
};

export type SubmissionEvidence = {
  version: 1;
  verificationRequestId: string;
  ownerUserId: string;
  envelope: OwnershipSubmissionEnvelope;
  ownershipIntentSignature: Hex | null;
  sealedAtMs: number;
  expiresAtMs: number;
};

export class SubmissionEvidenceError extends Error {
  readonly code: "CONFIGURATION_REQUIRED" | "INVALID_EVIDENCE" | "EVIDENCE_EXPIRED";

  constructor(code: SubmissionEvidenceError["code"], message: string) {
    super(message);
    this.name = "SubmissionEvidenceError";
    this.code = code;
  }
}

export async function sealSubmissionEvidence(
  evidence: SubmissionEvidence,
  options: {
    binding: SubmissionEvidenceBinding;
    keyring?: SubmissionSealKeyring;
  },
): Promise<string> {
  const normalized = normalizeEvidence(evidence);
  const binding = normalizeBinding(options.binding);
  assertEvidenceBinding(normalized, binding);
  const keyring = options.keyring ?? submissionSealKeyringFromEnvironment();
  const keyId = normalizeKeyId(keyring.activeKeyId);
  const key = await importSealKey(keyring.keys.get(keyId));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(normalized));
  const additionalData = evidenceAdditionalData(binding, keyId);
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(nonce),
      additionalData: asArrayBuffer(additionalData),
      tagLength: 128,
    },
    key,
    asArrayBuffer(plaintext),
  );
  return `${TOKEN_PREFIX}.${keyId}.${toBase64Url(nonce)}.${toBase64Url(new Uint8Array(encrypted))}`;
}

export async function openSubmissionEvidence(
  token: unknown,
  options: {
    binding: SubmissionEvidenceBinding;
    keyring?: SubmissionSealKeyring;
    nowMs?: number;
  },
): Promise<SubmissionEvidence> {
  if (typeof token !== "string" || token.length > TOKEN_MAX_LENGTH) {
    throw invalidEvidence();
  }
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) throw invalidEvidence();
  const keyId = normalizeKeyId(parts[1]);
  let nonce: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    nonce = fromBase64Url(parts[2]);
    ciphertext = fromBase64Url(parts[3]);
  } catch {
    throw invalidEvidence();
  }
  if (nonce.length !== 12 || ciphertext.length < 17 || ciphertext.length > 3_072) {
    throw invalidEvidence();
  }
  const binding = normalizeBinding(options.binding);
  const keyring = options.keyring ?? submissionSealKeyringFromEnvironment();
  const key = await importSealKey(keyring.keys.get(keyId));
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asArrayBuffer(nonce),
        additionalData: asArrayBuffer(evidenceAdditionalData(binding, keyId)),
        tagLength: 128,
      },
      key,
      asArrayBuffer(ciphertext),
    );
  } catch {
    throw invalidEvidence();
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    throw invalidEvidence();
  }
  const evidence = normalizeEvidence(value);
  assertEvidenceBinding(evidence, binding);
  if (evidence.expiresAtMs <= (options.nowMs ?? Date.now())) {
    throw new SubmissionEvidenceError(
      "EVIDENCE_EXPIRED",
      "The sealed ownership evidence has expired.",
    );
  }
  return evidence;
}

export function submissionEvidenceDigest(token: string): Hex {
  return sha256(stringToHex(token));
}

export function submissionSealKeyringFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): SubmissionSealKeyring {
  const activeKeyId = normalizeKeyId(environment.XPROOF_SUBMISSION_ACTIVE_SEAL_KEY_ID);
  const serialized = environment.XPROOF_SUBMISSION_SEAL_KEYS;
  if (typeof serialized !== "string" || serialized.length > 8_192) {
    throw configurationRequired();
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw configurationRequired();
  }
  if (!isPlainObject(value) || Object.keys(value).length < 1 || Object.keys(value).length > 4) {
    throw configurationRequired();
  }
  const keys = new Map<string, string>();
  for (const [keyId, keyValue] of Object.entries(value)) {
    keys.set(normalizeKeyId(keyId), normalizeEncodedKey(keyValue));
  }
  if (!keys.has(activeKeyId)) throw configurationRequired();
  return Object.freeze({ activeKeyId, keys });
}

function normalizeEvidence(value: unknown): SubmissionEvidence {
  if (!isPlainObject(value)) throw invalidEvidence();
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "envelope",
    "expiresAtMs",
    "ownerUserId",
    "ownershipIntentSignature",
    "sealedAtMs",
    "verificationRequestId",
    "version",
  ];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw invalidEvidence();
  }
  if (value.version !== 1) throw invalidEvidence();
  const verificationRequestId = boundedString(value.verificationRequestId, 128);
  const ownerUserId = boundedString(value.ownerUserId, 256);
  const envelopeValue = value.envelope;
  if (!isPlainObject(envelopeValue)) throw invalidEvidence();
  const envelope = buildOwnershipSubmissionEnvelope({
    requestId: envelopeValue.requestId,
    baseWallet: envelopeValue.baseWallet,
    expectedHandle: envelopeValue.expectedHandle,
    postId: envelopeValue.postId,
    challenge: envelopeValue.challenge,
    issuedAtEpoch: envelopeValue.issuedAtEpoch,
    expiresAtEpoch: envelopeValue.expiresAtEpoch,
    credentialExpiresAtEpoch: envelopeValue.credentialExpiresAtEpoch,
  });
  const signature = value.ownershipIntentSignature;
  if (
    signature !== null &&
    (typeof signature !== "string" ||
      signature.length > 1_000 ||
      !isHex(signature) ||
      !/^0x[0-9a-fA-F]+$/.test(signature))
  ) {
    throw invalidEvidence();
  }
  const sealedAtMs = epochMs(value.sealedAtMs);
  const expiresAtMs = epochMs(value.expiresAtMs);
  if (expiresAtMs <= sealedAtMs) throw invalidEvidence();
  return Object.freeze({
    version: 1,
    verificationRequestId,
    ownerUserId,
    envelope,
    ownershipIntentSignature: signature as Hex | null,
    sealedAtMs,
    expiresAtMs,
  });
}

async function importSealKey(value: unknown): Promise<CryptoKey> {
  const normalized = normalizeEncodedKey(value);
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(normalized);
  } catch {
    throw configurationRequired();
  }
  if (bytes.length !== 32) {
    throw configurationRequired();
  }
  return crypto.subtle.importKey("raw", asArrayBuffer(bytes), "AES-GCM", false, ["encrypt", "decrypt"]);
}

function normalizeBinding(value: SubmissionEvidenceBinding): SubmissionEvidenceBinding {
  const verificationRequestId = boundedString(value?.verificationRequestId, 128);
  const ownerUserId = boundedString(value?.ownerUserId, 256);
  if (typeof value?.wallet !== "string" || !isAddress(value.wallet, { strict: false })) {
    throw invalidEvidence();
  }
  if (typeof value?.finalizedRequestId !== "string" || !isHash(value.finalizedRequestId)) {
    throw invalidEvidence();
  }
  return Object.freeze({
    verificationRequestId,
    ownerUserId,
    wallet: getAddress(value.wallet),
    finalizedRequestId: value.finalizedRequestId.toLowerCase() as Hex,
  });
}

function assertEvidenceBinding(
  evidence: SubmissionEvidence,
  binding: SubmissionEvidenceBinding,
): void {
  if (
    evidence.verificationRequestId !== binding.verificationRequestId ||
    evidence.ownerUserId !== binding.ownerUserId ||
    evidence.envelope.baseWallet.toLowerCase() !== binding.wallet.toLowerCase() ||
    evidence.envelope.requestId !== binding.finalizedRequestId
  ) {
    throw invalidEvidence();
  }
}

function evidenceAdditionalData(
  binding: SubmissionEvidenceBinding,
  keyId: string,
): Uint8Array {
  return new TextEncoder().encode(
    [
      "xproof:ownership-evidence:v1",
      keyId,
      binding.verificationRequestId,
      binding.ownerUserId,
      binding.wallet.toLowerCase(),
      binding.finalizedRequestId,
      "1",
    ].join("|"),
  );
}

function normalizeKeyId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(value)) {
    throw configurationRequired();
  }
  return value;
}

function normalizeEncodedKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw configurationRequired();
  }
  return value;
}

function configurationRequired(): SubmissionEvidenceError {
  return new SubmissionEvidenceError(
    "CONFIGURATION_REQUIRED",
    "The InfluencedX submission evidence keyring is not configured.",
  );
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw invalidEvidence();
  }
  return value;
}

function epochMs(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw invalidEvidence();
  return Number(value);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidEvidence();
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (toBase64Url(decoded) !== value) throw invalidEvidence();
  return decoded;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function invalidEvidence(): SubmissionEvidenceError {
  return new SubmissionEvidenceError(
    "INVALID_EVIDENCE",
    "The sealed ownership evidence is invalid.",
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
