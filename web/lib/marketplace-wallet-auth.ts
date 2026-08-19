import { getAddress, isAddress, verifyMessage } from "viem";

import { ApiProblem } from "./verification-api.ts";
import type { WalletSession } from "./wallet-session.ts";

const STUDIONET_CHAIN_ID = 61_999;
const SIGNATURE_PATTERN = /^0x(?:[0-9a-fA-F]{2})+$/;

type MessageVerifier = {
  verifyMessage(input: {
    address: `0x${string}`;
    message: string;
    signature: `0x${string}`;
  }): Promise<boolean>;
};

export function buildMarketplaceWalletSignInMessage(input: {
  origin: string;
  wallet: string;
  session: WalletSession;
}): string {
  const origin = normalizeOrigin(input.origin);
  const wallet = normalizeWallet(input.wallet);
  return [
    "InfluencedX wallet sign-in",
    "",
    "Sign in to create or manage campaigns and creator applications.",
    "This signature does not approve a payment or blockchain transaction.",
    "",
    `Domain: ${new URL(origin).host}`,
    `URI: ${origin}`,
    `Chain ID: ${STUDIONET_CHAIN_ID}`,
    `Wallet: ${wallet}`,
    `Nonce: ${input.session.subject}`,
    `Issued At: ${new Date(input.session.issuedAt * 1_000).toISOString()}`,
    `Expiration Time: ${new Date(input.session.expiresAt * 1_000).toISOString()}`,
  ].join("\n");
}

export async function verifyMarketplaceWalletSignIn(input: {
  origin: string;
  wallet: string;
  signature: unknown;
  session: WalletSession;
  verifier?: MessageVerifier;
}): Promise<string> {
  const wallet = normalizeWallet(input.wallet);
  if (
    typeof input.signature !== "string" ||
    input.signature.length > 4_096 ||
    !SIGNATURE_PATTERN.test(input.signature)
  ) {
    throw new ApiProblem(
      400,
      "INVALID_WALLET_SIGNATURE",
      "A valid wallet signature is required.",
    );
  }

  let valid: boolean;
  try {
    valid = await (input.verifier ?? marketplaceSignatureVerifier()).verifyMessage({
      address: wallet,
      message: buildMarketplaceWalletSignInMessage({
        origin: input.origin,
        wallet,
        session: input.session,
      }),
      signature: input.signature as `0x${string}`,
    });
  } catch {
    throw new ApiProblem(
      503,
      "SIGNATURE_VERIFIER_UNAVAILABLE",
      "The StudioNet wallet signature verifier is temporarily unavailable.",
    );
  }
  if (!valid) {
    throw new ApiProblem(
      422,
      "INVALID_WALLET_SIGNATURE",
      "The wallet signature does not match this sign-in request.",
    );
  }
  return wallet.toLowerCase();
}

function normalizeWallet(value: string): `0x${string}` {
  const wallet = value.trim();
  if (!isAddress(wallet, { strict: false })) {
    throw new ApiProblem(400, "INVALID_WALLET", "A valid EVM wallet address is required.");
  }
  return getAddress(wallet);
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiProblem(500, "INVALID_APPLICATION_ORIGIN", "The application origin is invalid.");
  }
  if (parsed.origin !== value || parsed.username || parsed.password) {
    throw new ApiProblem(500, "INVALID_APPLICATION_ORIGIN", "The application origin is invalid.");
  }
  return parsed.origin;
}

function marketplaceSignatureVerifier(): MessageVerifier {
  // StudioNet users sign with ordinary secp256k1 EOAs. EIP-191 recovery is
  // deterministic and local; authentication must not depend on an unrelated
  // EVM chain RPC being available.
  return { verifyMessage };
}
