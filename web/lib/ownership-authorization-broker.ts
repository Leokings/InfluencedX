import { createHash } from "node:crypto";

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  getAddress,
  hexToBytes,
  isAddress,
  isHash,
  isHex,
  keccak256,
  padHex,
  sha256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

import { getDb } from "../db/index.ts";
import {
  ownershipAuthorizationGrants,
  verificationRequests,
} from "../db/schema.ts";
import {
  BASE_SEPOLIA_CHAIN_ID,
  OWNERSHIP_INTENT_TYPES,
  type OwnershipIntentTypedData,
} from "./verification-core.ts";
import {
  BRADBURY_METHOD,
  BRADBURY_NETWORK,
  PINNED_BRADBURY_RESOLVER,
} from "./ownership-submission.ts";
import {
  openSubmissionEvidence,
  submissionEvidenceDigest,
  type SubmissionEvidence,
} from "./submission-evidence.ts";

export const OWNERSHIP_AUTHORIZATION_GRANT_TTL_MS = 15 * 60 * 1_000;
export const OWNERSHIP_AUTHORIZATION_TOKEN_BYTES = 32;
export const OWNERSHIP_AUTHORIZATION_RSA_ALGORITHM = "RSA-OAEP-256" as const;

export const ownershipAuthorizationGrantInsertFields = [
  "token_hash",
  "request_id",
  "genlayer_tx_hash",
  "resolver_address",
  "base_receiver_address",
  "base_registry_address",
  "expected_wallet",
  "expires_at",
  "consumed_at",
  "consumer_key_fingerprint",
  "created_at",
] as const;

export type OwnershipAuthorizationBinding = {
  requestId: Hex;
  genlayerTxHash: Hex;
  resolver: Address;
  baseReceiver: Address;
  baseRegistry: Address;
  expectedWallet: Address;
};

export type OwnershipAuthorizationGrantInsert = {
  tokenHash: string;
  requestId: Hex;
  genlayerTxHash: Hex;
  resolverAddress: Address;
  baseReceiverAddress: Address;
  baseRegistryAddress: Address;
  expectedWallet: Address;
  expiresAt: number;
  consumedAt: null;
  consumerKeyFingerprint: null;
  createdAt: number;
};

export type OwnershipAuthorizationBrokerRequest = OwnershipAuthorizationBinding & {
  token: string;
  ephemeralPublicKey: JsonWebKey;
};

type NormalizedRsaPublicJwk = JsonWebKey & {
  alg: typeof OWNERSHIP_AUTHORIZATION_RSA_ALGORITHM;
  e: "AQAB";
  ext: true;
  key_ops: ["encrypt"];
  kty: "RSA";
  n: string;
};

export class OwnershipAuthorizationBrokerProblem extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "OwnershipAuthorizationBrokerProblem";
    this.status = status;
    this.code = code;
  }
}

export type OwnershipAuthorizationBrokerDependencies = {
  consumeGrant?: typeof consumeOwnershipAuthorizationGrant;
  loadSignature?: typeof loadVerifiedOwnershipSignature;
  nowMs?: number;
  environment?: NodeJS.ProcessEnv;
};

/**
 * Builds the exact public row an operator inserts into Preview Neon. The raw
 * token is reduced to a SHA-256 digest and is never returned.
 */
export function buildOwnershipAuthorizationGrant(input: {
  token: unknown;
  binding: OwnershipAuthorizationBinding;
  createdAtMs?: number;
  expiresAtMs: number;
}): OwnershipAuthorizationGrantInsert {
  const token = normalizeGrantToken(input.token);
  const binding = normalizeBinding(input.binding);
  const createdAt = input.createdAtMs ?? Date.now();
  const expiresAt = normalizeEpochMs(input.expiresAtMs);
  if (
    expiresAt <= createdAt ||
    expiresAt > createdAt + OWNERSHIP_AUTHORIZATION_GRANT_TTL_MS
  ) {
    throw new Error("The ownership authorization grant must expire within 15 minutes.");
  }
  return Object.freeze({
    tokenHash: ownershipAuthorizationTokenHash(token),
    requestId: binding.requestId,
    genlayerTxHash: binding.genlayerTxHash,
    resolverAddress: binding.resolver,
    baseReceiverAddress: binding.baseReceiver,
    baseRegistryAddress: binding.baseRegistry,
    expectedWallet: binding.expectedWallet,
    expiresAt,
    consumedAt: null,
    consumerKeyFingerprint: null,
    createdAt,
  });
}

export function ownershipAuthorizationTokenHash(token: unknown): string {
  return sha256Hex(normalizeGrantToken(token));
}

export function ownershipAuthorizationPublicKeyFingerprint(
  value: unknown,
): string {
  const jwk = normalizeRsaPublicJwk(value);
  return sha256Hex(
    ["xproof:ownership-authorization-key:v1", jwk.n, jwk.e].join("|"),
  );
}

export function ownershipAuthorizationOaepLabel(
  bindingValue: OwnershipAuthorizationBinding,
  publicKeyFingerprint: string,
): Uint8Array {
  const binding = normalizeBinding(bindingValue);
  if (!/^[0-9a-f]{64}$/.test(publicKeyFingerprint)) {
    throw new Error("The ownership authorization key fingerprint is invalid.");
  }
  return new TextEncoder().encode(
    [
      "xproof:ownership-authorization:v1",
      binding.requestId,
      binding.genlayerTxHash,
      binding.resolver.toLowerCase(),
      binding.baseReceiver.toLowerCase(),
      binding.baseRegistry.toLowerCase(),
      binding.expectedWallet.toLowerCase(),
      publicKeyFingerprint,
    ].join("|"),
  );
}

/**
 * Consumes a one-time grant before sealed evidence is opened, then returns a
 * single RSA-OAEP ciphertext. A downstream failure intentionally burns the
 * grant rather than making secret recovery replayable.
 */
export async function issueOwnershipAuthorizationCiphertext(
  body: unknown,
  dependencies: OwnershipAuthorizationBrokerDependencies = {},
): Promise<{ ciphertext: string }> {
  const environment = dependencies.environment ?? process.env;
  assertPreviewBrokerEnabled(environment);
  const request = normalizeBrokerRequest(body);
  assertConfiguredDeployment(request, environment);

  const publicJwk = normalizeRsaPublicJwk(request.ephemeralPublicKey);
  const keyFingerprint = ownershipAuthorizationPublicKeyFingerprint(publicJwk);
  const tokenHash = ownershipAuthorizationTokenHash(request.token);
  const nowMs = dependencies.nowMs ?? Date.now();
  const binding = bindingFromRequest(request);
  const consumeGrant = dependencies.consumeGrant ?? consumeOwnershipAuthorizationGrant;
  const consumed = await consumeGrant({
    tokenHash,
    binding,
    keyFingerprint,
    nowMs,
  });
  if (!consumed) {
    throw new OwnershipAuthorizationBrokerProblem(
      401,
      "INVALID_OR_USED_GRANT",
      "The ownership authorization grant is invalid, expired, or already used.",
    );
  }

  const loadSignature = dependencies.loadSignature ?? loadVerifiedOwnershipSignature;
  const signature = await loadSignature(binding, nowMs);
  const ciphertext = await encryptOwnershipSignature({
    signature,
    binding,
    publicJwk,
    keyFingerprint,
  });
  return Object.freeze({ ciphertext });
}

export async function consumeOwnershipAuthorizationGrant(input: {
  tokenHash: string;
  binding: OwnershipAuthorizationBinding;
  keyFingerprint: string;
  nowMs: number;
}): Promise<boolean> {
  const binding = normalizeBinding(input.binding);
  if (!/^[0-9a-f]{64}$/.test(input.tokenHash)) return false;
  if (!/^[0-9a-f]{64}$/.test(input.keyFingerprint)) return false;
  const nowMs = normalizeEpochMs(input.nowMs);
  const [consumed] = await getDb()
    .update(ownershipAuthorizationGrants)
    .set({
      consumedAt: nowMs,
      consumerKeyFingerprint: input.keyFingerprint,
    })
    .where(
      and(
        eq(ownershipAuthorizationGrants.tokenHash, input.tokenHash),
        eq(ownershipAuthorizationGrants.requestId, binding.requestId),
        eq(
          ownershipAuthorizationGrants.genlayerTxHash,
          binding.genlayerTxHash,
        ),
        eq(ownershipAuthorizationGrants.resolverAddress, binding.resolver),
        eq(
          ownershipAuthorizationGrants.baseReceiverAddress,
          binding.baseReceiver,
        ),
        eq(
          ownershipAuthorizationGrants.baseRegistryAddress,
          binding.baseRegistry,
        ),
        eq(
          ownershipAuthorizationGrants.expectedWallet,
          binding.expectedWallet,
        ),
        isNull(ownershipAuthorizationGrants.consumedAt),
        gt(ownershipAuthorizationGrants.expiresAt, nowMs),
      ),
    )
    .returning({ tokenHash: ownershipAuthorizationGrants.tokenHash });
  return Boolean(consumed);
}

export async function loadVerifiedOwnershipSignature(
  bindingValue: OwnershipAuthorizationBinding,
  nowMsValue: number,
): Promise<Hex> {
  const binding = normalizeBinding(bindingValue);
  const nowMs = normalizeEpochMs(nowMsValue);
  const [row] = await getDb()
    .select()
    .from(verificationRequests)
    .where(eq(verificationRequests.finalizedRequestId, binding.requestId))
    .limit(1);
  if (!row) throw notRelayable();

  const relayStateAllowsAuthorization =
    row.baseRelayStatus === "NOT_STARTED" ||
    row.baseRelayStatus === "QUORUM_PENDING" ||
    row.baseRelayStatus === "FAILED";
  const rowIsFinalVerified =
    row.status === "READY_FOR_GENLAYER" &&
    row.submissionStatus === "FINALIZED" &&
    row.genlayerOutcome === "VERIFIED" &&
    row.genlayerErrorCode === null &&
    row.genlayerTxHash?.toLowerCase() === binding.genlayerTxHash &&
    row.genlayerFinalizedAt !== null &&
    row.intentSignatureStatus === "VERIFIED" &&
    row.receiverContract?.toLowerCase() === binding.baseReceiver.toLowerCase() &&
    row.genlayerContract?.toLowerCase() === binding.resolver.toLowerCase() &&
    row.wallet.toLowerCase() === binding.expectedWallet.toLowerCase() &&
    row.requestExpiresAt > nowMs &&
    (row.credentialExpiresAt ?? 0) > nowMs &&
    relayStateAllowsAuthorization &&
    row.baseRelayTxHash === null &&
    row.baseConfirmedAt === null &&
    row.baseProfileVerified === false;
  if (!rowIsFinalVerified) throw notRelayable();

  const statusResult = await getDb().execute(sql`
    select
      request_id,
      status,
      network,
      resolver,
      function_name,
      lifecycle_status,
      execution_result,
      result_outcome,
      tx_hash,
      error_code,
      finalized_at
    from xproof_bradbury_submission_status
    where request_id = ${binding.requestId}
    limit 1
  `);
  const statusRow = (
    statusResult as unknown as { rows?: Array<Record<string, unknown>> }
  ).rows?.[0];
  const statusIsExact =
    statusRow?.request_id === binding.requestId &&
    statusRow.status === "FINALIZED" &&
    statusRow.network === BRADBURY_NETWORK &&
    typeof statusRow.resolver === "string" &&
    statusRow.resolver.toLowerCase() === binding.resolver.toLowerCase() &&
    statusRow.resolver.toLowerCase() === PINNED_BRADBURY_RESOLVER.toLowerCase() &&
    statusRow.function_name === BRADBURY_METHOD &&
    statusRow.lifecycle_status === "FINALIZED" &&
    statusRow.execution_result === "FINISHED_WITH_RETURN" &&
    statusRow.result_outcome === "VERIFIED" &&
    statusRow.tx_hash === binding.genlayerTxHash &&
    statusRow.error_code === null &&
    statusRow.finalized_at !== null;
  // The submitter stores VERIFIED only after assertResolverResult confirms all
  // eleven APV2 proof flags. Requiring its immutable terminal projection here
  // therefore carries that exact-proof invariant across the broker boundary.
  if (!statusIsExact) throw notRelayable();

  if (
    !row.sealedEvidenceCiphertext ||
    !row.sealedEvidenceHash ||
    row.sealedEvidencePurgedAt !== null ||
    (row.sealedEvidenceExpiresAt ?? 0) <= nowMs ||
    submissionEvidenceDigest(row.sealedEvidenceCiphertext).toLowerCase() !==
      row.sealedEvidenceHash.toLowerCase()
  ) {
    throw notRelayable();
  }

  const evidence = await openSubmissionEvidence(row.sealedEvidenceCiphertext, {
    binding: {
      verificationRequestId: row.id,
      ownerUserId: row.ownerUserId,
      wallet: binding.expectedWallet,
      finalizedRequestId: binding.requestId,
    },
    nowMs,
  });
  assertEvidenceAndIntentBinding(evidence, row, binding);
  const signature = evidence.ownershipIntentSignature;
  if (
    !signature ||
    !isHex(signature) ||
    !row.intentSignatureHash ||
    keccak256(signature).toLowerCase() !== row.intentSignatureHash.toLowerCase()
  ) {
    throw notRelayable();
  }
  return signature;
}

async function encryptOwnershipSignature(input: {
  signature: Hex;
  binding: OwnershipAuthorizationBinding;
  publicJwk: NormalizedRsaPublicJwk;
  keyFingerprint: string;
}): Promise<string> {
  const bytes = hexToBytes(input.signature);
  if (bytes.length < 64 || bytes.length > 512) throw notRelayable();
  const key = await crypto.subtle.importKey(
    "jwk",
    input.publicJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  let encrypted: ArrayBuffer;
  try {
    encrypted = await crypto.subtle.encrypt(
      {
        name: "RSA-OAEP",
        label: asArrayBuffer(
          ownershipAuthorizationOaepLabel(
            input.binding,
            input.keyFingerprint,
          ),
        ),
      },
      key,
      asArrayBuffer(bytes),
    );
  } catch {
    throw new OwnershipAuthorizationBrokerProblem(
      422,
      "UNSUPPORTED_OWNERSHIP_SIGNATURE",
      "The saved ownership signature cannot be encrypted to this ephemeral key.",
    );
  } finally {
    bytes.fill(0);
  }
  return toBase64Url(new Uint8Array(encrypted));
}

function assertEvidenceAndIntentBinding(
  evidence: SubmissionEvidence,
  row: typeof verificationRequests.$inferSelect,
  binding: OwnershipAuthorizationBinding,
): void {
  const envelope = evidence.envelope;
  const evidenceMatches =
    evidence.verificationRequestId === row.id &&
    evidence.ownerUserId === row.ownerUserId &&
    envelope.requestId === binding.requestId &&
    envelope.baseWallet.toLowerCase() === binding.expectedWallet.toLowerCase() &&
    envelope.expectedHandle === row.handle &&
    envelope.postId === row.verificationPostId &&
    sha256(stringToHex(envelope.challenge)) === row.challengeHash &&
    keccak256(stringToHex(`x-handle:${envelope.expectedHandle}`)) ===
      row.handleHash &&
    keccak256(stringToHex(`x-post:${envelope.postId}`)) ===
      row.verificationPostHash &&
    envelope.issuedAtEpoch === Math.floor((row.xChallengeIssuedAt ?? 0) / 1_000) &&
    envelope.expiresAtEpoch === Math.floor((row.xChallengeExpiresAt ?? 0) / 1_000) &&
    envelope.credentialExpiresAtEpoch ===
      Math.floor((row.credentialExpiresAt ?? 0) / 1_000);
  if (!evidenceMatches) throw notRelayable();

  if (
    !row.intentTypedDataJson ||
    !row.handleHash ||
    !row.verificationPostHash ||
    !row.challengeHash ||
    !row.credentialExpiresAt
  ) {
    throw notRelayable();
  }
  let typedData: OwnershipIntentTypedData;
  try {
    typedData = JSON.parse(row.intentTypedDataJson) as OwnershipIntentTypedData;
  } catch {
    throw notRelayable();
  }
  const typedDataMatches =
    typedData?.domain?.name === "XProofAttestationReceiver" &&
    typedData.domain.version === "2" &&
    typedData.domain.chainId === BASE_SEPOLIA_CHAIN_ID &&
    typedData.domain.verifyingContract.toLowerCase() ===
      binding.baseReceiver.toLowerCase() &&
    typedData.primaryType === "OwnershipIntent" &&
    JSON.stringify(typedData.types) === JSON.stringify(OWNERSHIP_INTENT_TYPES) &&
    typedData.message.attestationId === binding.requestId &&
    typedData.message.wallet.toLowerCase() === binding.expectedWallet.toLowerCase() &&
    typedData.message.handleHash === row.handleHash &&
    typedData.message.verificationPostHash === row.verificationPostHash &&
    typedData.message.challengeHash === row.challengeHash &&
    typedData.message.credentialExpiresAt ===
      Math.floor(row.credentialExpiresAt / 1_000) &&
    typedData.message.genlayerContract === padHex(binding.resolver, { size: 32 });
  if (!typedDataMatches) throw notRelayable();
}

function assertPreviewBrokerEnabled(environment: NodeJS.ProcessEnv): void {
  const target = environment.VERCEL_TARGET_ENV;
  if (
    environment.VERCEL_ENV !== "preview" ||
    (target !== undefined && target !== "preview") ||
    environment.XPROOF_AUTHORIZATION_BROKER_ENABLED !== "true"
  ) {
    throw new OwnershipAuthorizationBrokerProblem(
      404,
      "NOT_FOUND",
      "This endpoint is unavailable.",
    );
  }
}

function assertConfiguredDeployment(
  request: OwnershipAuthorizationBrokerRequest,
  environment: NodeJS.ProcessEnv,
): void {
  const configuredResolver = configuredAddress(
    environment.XPROOF_GENLAYER_CONTRACT,
  );
  const configuredReceiver = configuredAddress(
    environment.XPROOF_ATTESTATION_RECEIVER,
  );
  const configuredRegistry = configuredAddress(
    environment.XPROOF_CREATOR_REGISTRY,
  );
  if (
    request.resolver.toLowerCase() !== configuredResolver.toLowerCase() ||
    request.baseReceiver.toLowerCase() !== configuredReceiver.toLowerCase() ||
    request.baseRegistry.toLowerCase() !== configuredRegistry.toLowerCase()
  ) {
    throw new OwnershipAuthorizationBrokerProblem(
      409,
      "DEPLOYMENT_BINDING_MISMATCH",
      "The grant is not bound to this Preview deployment.",
    );
  }
}

function configuredAddress(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new OwnershipAuthorizationBrokerProblem(
      503,
      "BROKER_CONFIGURATION_REQUIRED",
      "The Preview authorization broker deployment is incomplete.",
    );
  }
  return getAddress(value);
}

function normalizeBrokerRequest(value: unknown): OwnershipAuthorizationBrokerRequest {
  if (!isPlainObject(value)) throw invalidRequest();
  const expectedKeys = [
    "baseReceiver",
    "baseRegistry",
    "ephemeralPublicKey",
    "expectedWallet",
    "genlayerTxHash",
    "requestId",
    "resolver",
    "token",
  ];
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw invalidRequest();
  }
  const binding = normalizeBinding(value as unknown as OwnershipAuthorizationBinding);
  return {
    ...binding,
    token: normalizeGrantToken(value.token),
    ephemeralPublicKey: normalizeRsaPublicJwk(value.ephemeralPublicKey),
  };
}

function normalizeBinding(value: OwnershipAuthorizationBinding): OwnershipAuthorizationBinding {
  if (
    !value ||
    typeof value.requestId !== "string" ||
    !isHash(value.requestId) ||
    typeof value.genlayerTxHash !== "string" ||
    !isHash(value.genlayerTxHash)
  ) {
    throw invalidRequest();
  }
  return Object.freeze({
    requestId: value.requestId.toLowerCase() as Hex,
    genlayerTxHash: value.genlayerTxHash.toLowerCase() as Hex,
    resolver: normalizeAddress(value.resolver),
    baseReceiver: normalizeAddress(value.baseReceiver),
    baseRegistry: normalizeAddress(value.baseRegistry),
    expectedWallet: normalizeAddress(value.expectedWallet),
  });
}

function bindingFromRequest(
  request: OwnershipAuthorizationBrokerRequest,
): OwnershipAuthorizationBinding {
  return {
    requestId: request.requestId,
    genlayerTxHash: request.genlayerTxHash,
    resolver: request.resolver,
    baseReceiver: request.baseReceiver,
    baseRegistry: request.baseRegistry,
    expectedWallet: request.expectedWallet,
  };
}

function normalizeAddress(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw invalidRequest();
  }
  return getAddress(value);
}

function normalizeGrantToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 43 ||
    !/^[A-Za-z0-9_-]{43}$/.test(value)
  ) {
    throw invalidRequest();
  }
  const decoded = fromBase64Url(value);
  if (decoded.length !== OWNERSHIP_AUTHORIZATION_TOKEN_BYTES) {
    throw invalidRequest();
  }
  return value;
}

function normalizeRsaPublicJwk(value: unknown): NormalizedRsaPublicJwk {
  if (!isPlainObject(value)) throw invalidRequest();
  const expectedKeys = ["alg", "e", "ext", "key_ops", "kty", "n"];
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    value.kty !== "RSA" ||
    value.alg !== OWNERSHIP_AUTHORIZATION_RSA_ALGORITHM ||
    value.e !== "AQAB" ||
    value.ext !== true ||
    !Array.isArray(value.key_ops) ||
    value.key_ops.length !== 1 ||
    value.key_ops[0] !== "encrypt" ||
    typeof value.n !== "string" ||
    !/^[A-Za-z0-9_-]{342,683}$/.test(value.n)
  ) {
    throw invalidRequest();
  }
  const modulus = fromBase64Url(value.n);
  const bitLength = unsignedBitLength(modulus);
  modulus.fill(0);
  if (bitLength < 2_048 || bitLength > 4_096) throw invalidRequest();
  return {
    alg: OWNERSHIP_AUTHORIZATION_RSA_ALGORITHM,
    e: "AQAB",
    ext: true,
    key_ops: ["encrypt"],
    kty: "RSA",
    n: value.n,
  };
}

function normalizeEpochMs(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw invalidRequest();
  return Number(value);
}

function unsignedBitLength(bytes: Uint8Array): number {
  let first = 0;
  while (first < bytes.length && bytes[first] === 0) first += 1;
  if (first === bytes.length) return 0;
  return (bytes.length - first - 1) * 8 + Math.floor(Math.log2(bytes[first])) + 1;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidRequest();
  try {
    return new Uint8Array(Buffer.from(value, "base64url"));
  } catch {
    throw invalidRequest();
  }
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidRequest(): OwnershipAuthorizationBrokerProblem {
  return new OwnershipAuthorizationBrokerProblem(
    400,
    "INVALID_REQUEST",
    "The ownership authorization request is invalid.",
  );
}

function notRelayable(): OwnershipAuthorizationBrokerProblem {
  return new OwnershipAuthorizationBrokerProblem(
    409,
    "VERIFICATION_NOT_RELAYABLE",
    "The exact finalized ownership proof is not eligible for this Base relay.",
  );
}
