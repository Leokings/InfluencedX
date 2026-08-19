import assert from "node:assert/strict";
import test from "node:test";

import { ApiProblem } from "../lib/verification-api.ts";
import {
  buildMarketplaceWalletSignInMessage,
  verifyMarketplaceWalletSignIn,
} from "../lib/marketplace-wallet-auth.ts";
import type { PendingWalletSession } from "../lib/wallet-session.ts";

const session: PendingWalletSession = {
  version: 1,
  subject: "A".repeat(43),
  stage: "pending",
  wallet: null,
  issuedAt: 1_800_000_000,
  expiresAt: 1_800_000_900,
};
const wallet = "0x63038a310a46AC61A59c1bC5eAD5fe41040eF38e";

test("marketplace sign-in binds the exact origin, wallet, session nonce, chain, and expiry", () => {
  const message = buildMarketplaceWalletSignInMessage({
    origin: "https://influencedx.example",
    wallet,
    session,
  });
  assert.match(message, /^InfluencedX wallet sign-in/);
  assert.match(message, /Domain: influencedx\.example/);
  assert.match(message, /URI: https:\/\/influencedx\.example/);
  assert.match(message, /Chain ID: 61999/);
  assert.match(message, new RegExp(`Wallet: ${wallet}`));
  assert.match(message, new RegExp(`Nonce: ${session.subject}`));
  assert.match(message, /does not approve a payment or blockchain transaction/);
});

test("marketplace sign-in accepts only a signature verified for the exact message", async () => {
  let observed: Record<string, unknown> | undefined;
  const result = await verifyMarketplaceWalletSignIn({
    origin: "https://influencedx.example",
    wallet,
    signature: `0x${"11".repeat(65)}`,
    session,
    verifier: {
      async verifyMessage(input) {
        observed = input;
        return true;
      },
    },
  });
  assert.equal(result, wallet.toLowerCase());
  assert.equal(observed?.address, wallet);
  assert.match(String(observed?.message), new RegExp(session.subject));
});

test("invalid or mismatched marketplace signatures fail closed", async () => {
  await assert.rejects(
    verifyMarketplaceWalletSignIn({
      origin: "https://influencedx.example",
      wallet,
      signature: "not-hex",
      session,
      verifier: { async verifyMessage() { return true; } },
    }),
    (error: unknown) => error instanceof ApiProblem && error.code === "INVALID_WALLET_SIGNATURE",
  );
  await assert.rejects(
    verifyMarketplaceWalletSignIn({
      origin: "https://influencedx.example",
      wallet,
      signature: `0x${"22".repeat(65)}`,
      session,
      verifier: { async verifyMessage() { return false; } },
    }),
    (error: unknown) => error instanceof ApiProblem && error.status === 422,
  );
});
