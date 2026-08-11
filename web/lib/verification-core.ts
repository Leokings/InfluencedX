import {
  getAddress,
  isAddress,
  keccak256,
  padHex,
  sha256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

export const BASE_SEPOLIA_CHAIN_ID = 84_532;
export const WALLET_CHALLENGE_TTL_MS = 5 * 60 * 1_000;
export const X_CHALLENGE_TTL_MS = 15 * 60 * 1_000;
export const CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const POST_TIMESTAMP_SKEW_MS = 60 * 1_000;

export function shouldExpireVerificationRequest(
  status: string,
  requestExpiresAtMs: number,
  nowMs: number,
): boolean {
  return status !== "EXPIRED" && requestExpiresAtMs <= nowMs;
}

export const OWNERSHIP_INTENT_TYPES = {
  OwnershipIntent: [
    { name: "attestationId", type: "bytes32" },
    { name: "wallet", type: "address" },
    { name: "handleHash", type: "bytes32" },
    { name: "verificationPostHash", type: "bytes32" },
    { name: "challengeHash", type: "bytes32" },
    { name: "credentialExpiresAt", type: "uint64" },
    { name: "genlayerContract", type: "bytes32" },
  ],
} as const;

export type OwnershipIntentTypedData = {
  domain: {
    name: "XProofAttestationReceiver";
    version: "2";
    chainId: typeof BASE_SEPOLIA_CHAIN_ID;
    verifyingContract: Address;
  };
  types: typeof OWNERSHIP_INTENT_TYPES;
  primaryType: "OwnershipIntent";
  message: {
    attestationId: Hex;
    wallet: Address;
    handleHash: Hex;
    verificationPostHash: Hex;
    challengeHash: Hex;
    credentialExpiresAt: number;
    genlayerContract: Hex;
  };
};

export type ParsedVerificationPost = {
  handle: string;
  postId: string;
  normalizedUrl: string;
  createdAtMs: number;
};

export function normalizeWallet(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new Error("Enter a valid EVM wallet address.");
  }

  return getAddress(value);
}

export function normalizeXHandle(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Enter an X handle.");
  }

  const normalized = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(normalized)) {
    throw new Error(
      "X handles must contain 1–15 letters, numbers, or underscores.",
    );
  }
  return normalized;
}

export function makeRandomToken(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function makeRandomBase64Url(byteLength = 18): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function normalizeOwnershipChallenge(value: unknown): string {
  if (typeof value !== "string" || !/^APV2-[A-Za-z0-9_-]{24}$/.test(value)) {
    throw new Error("The APV2 ownership challenge is invalid.");
  }
  return value;
}

export function buildWalletAuthorizationMessage(input: {
  origin: string;
  requestId: string;
  wallet: Address;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
}): string {
  const origin = normalizeOrigin(input.origin);
  const issuedAt = new Date(input.issuedAtMs).toISOString();
  const expiresAt = new Date(input.expiresAtMs).toISOString();

  return [
    "InfluencedX wallet authorization",
    "",
    "Authorize this wallet to create one X ownership verification request.",
    "This signature does not approve a payment or blockchain transaction.",
    "",
    `Domain: ${new URL(origin).host}`,
    `URI: ${origin}/verify`,
    `Chain ID: ${BASE_SEPOLIA_CHAIN_ID}`,
    `Request ID: ${input.requestId}`,
    `Wallet: ${input.wallet}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
  ].join("\n");
}

export function buildOwnershipTweet(input: {
  wallet: Address;
  challenge: string;
  issuedAtMs: number;
  challengeExpiresAtMs: number;
  credentialExpiresAtMs: number;
}): string {
  const challenge = normalizeOwnershipChallenge(input.challenge);
  const text =
    `XProof v2 w=${normalizeWallet(input.wallet)} n=${challenge} ` +
    `i=${toEpochSeconds(input.issuedAtMs)} ` +
    `e=${toEpochSeconds(input.challengeExpiresAtMs)} ` +
    `c=${toEpochSeconds(input.credentialExpiresAtMs)}`;

  if (text.length > 280) {
    throw new Error("The ownership challenge exceeds X's 280-character limit.");
  }
  return text;
}

export function parseVerificationPostUrl(value: unknown): ParsedVerificationPost {
  if (typeof value !== "string" || value.length > 512) {
    throw new Error("Enter a valid public X post URL.");
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid public X post URL.");
  }

  const hostname = url.hostname.toLowerCase();
  const allowedHosts = new Set([
    "x.com",
    "www.x.com",
    "twitter.com",
    "www.twitter.com",
  ]);
  if (
    url.protocol !== "https:" ||
    !allowedHosts.has(hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Use the canonical HTTPS x.com or twitter.com post URL without query parameters.",
    );
  }

  const match = url.pathname.match(
    /^\/([A-Za-z0-9_]{1,15})\/status\/([1-9][0-9]{5,24})\/?$/,
  );
  if (!match) {
    throw new Error("Use a direct X post URL in /handle/status/post-id format.");
  }

  const handle = normalizeXHandle(match[1]);
  const postId = match[2];
  return {
    handle,
    postId,
    normalizedUrl: `https://x.com/${handle}/status/${postId}`,
    createdAtMs: xSnowflakeTimestampMs(postId),
  };
}

export function xSnowflakeTimestampMs(postId: string): number {
  if (!/^[1-9][0-9]{5,24}$/.test(postId)) {
    throw new Error("The X post ID is invalid.");
  }

  const snowflake = BigInt(postId);
  if (snowflake > 18_446_744_073_709_551_615n) {
    throw new Error("The X post ID is outside the supported range.");
  }

  const timestamp = Number((snowflake >> 22n) + 1_288_834_974_657n);
  if (!Number.isSafeInteger(timestamp)) {
    throw new Error("The X post timestamp is invalid.");
  }
  return timestamp;
}

export function validateVerificationPostTiming(input: {
  postCreatedAtMs: number;
  challengeIssuedAtMs: number;
  challengeExpiresAtMs: number;
  credentialExpiresAtMs: number;
  nowMs: number;
}): void {
  if (input.nowMs > input.challengeExpiresAtMs) {
    throw new Error("The X ownership challenge has expired.");
  }
  if (input.nowMs >= input.credentialExpiresAtMs) {
    throw new Error("The requested ownership credential has expired.");
  }
  if (
    input.postCreatedAtMs <
    input.challengeIssuedAtMs - POST_TIMESTAMP_SKEW_MS
  ) {
    throw new Error("The X post predates this ownership challenge.");
  }
  if (
    input.postCreatedAtMs >
    Math.min(
      input.challengeExpiresAtMs,
      input.nowMs + POST_TIMESTAMP_SKEW_MS,
    )
  ) {
    throw new Error("The X post timestamp is outside the challenge window.");
  }
}

export function createOwnershipIntent(input: {
  wallet: Address;
  handle: string;
  postId: string;
  challenge: string;
  challengeIssuedAtMs: number;
  challengeExpiresAtMs: number;
  credentialExpiresAtMs: number;
  receiverContract: Address;
  genlayerContract: Address;
}): {
  finalizedRequestId: Hex;
  handleHash: Hex;
  verificationPostHash: Hex;
  challengeHash: Hex;
  typedData: OwnershipIntentTypedData;
} {
  const wallet = normalizeWallet(input.wallet);
  const handle = normalizeXHandle(input.handle);
  const challenge = normalizeOwnershipChallenge(input.challenge);
  const receiverContract = normalizeWallet(input.receiverContract);
  const genlayerContract = normalizeWallet(input.genlayerContract);
  const issuedAt = toEpochSeconds(input.challengeIssuedAtMs);
  const challengeExpiresAt = toEpochSeconds(input.challengeExpiresAtMs);
  const credentialExpiresAt = toEpochSeconds(input.credentialExpiresAtMs);
  const handleHash = keccak256(stringToHex(`x-handle:${handle}`));
  const verificationPostHash = keccak256(
    stringToHex(`x-post:${input.postId}`),
  );
  const challengeHash = sha256(stringToHex(challenge));
  const canonicalRequest = [
    "xproof-x-ownership-v2",
    wallet.toLowerCase(),
    handle,
    input.postId,
    challenge,
    String(issuedAt),
    String(challengeExpiresAt),
    String(credentialExpiresAt),
  ].join("|");
  const finalizedRequestId = sha256(stringToHex(canonicalRequest));
  const paddedGenlayerContract = padHex(genlayerContract, { size: 32 });

  const typedData: OwnershipIntentTypedData = {
    domain: {
      name: "XProofAttestationReceiver",
      version: "2",
      chainId: BASE_SEPOLIA_CHAIN_ID,
      verifyingContract: receiverContract,
    },
    types: OWNERSHIP_INTENT_TYPES,
    primaryType: "OwnershipIntent",
    message: {
      attestationId: finalizedRequestId,
      wallet,
      handleHash,
      verificationPostHash,
      challengeHash,
      credentialExpiresAt,
      genlayerContract: paddedGenlayerContract,
    },
  };

  return {
    finalizedRequestId,
    handleHash,
    verificationPostHash,
    challengeHash,
    typedData,
  };
}

function toEpochSeconds(valueMs: number): number {
  return Math.floor(valueMs / 1_000);
}

function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The application origin is invalid.");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("The application origin is invalid.");
  }
  return url.origin;
}
