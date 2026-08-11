import assert from "node:assert/strict";
import test from "node:test";
import { hashTypedData, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createOwnershipIntent } from "../lib/verification-core.ts";
import { selectVerificationWallet } from "../lib/verification-wallet.ts";
import { typedDataForWalletRpc } from "../lib/wallet-typed-data.ts";

test("a saved verification wallet cannot be replaced by a newly connected account", () => {
  const saved = "0x1111111111111111111111111111111111111111";
  const newlyConnected = "0x2222222222222222222222222222222222222222";

  assert.equal(selectVerificationWallet(saved, newlyConnected), saved);
});

test("a connected account is used only before a verification request exists", () => {
  const connected = "0x2222222222222222222222222222222222222222";

  assert.equal(selectVerificationWallet(null, connected), connected);
  assert.equal(selectVerificationWallet(undefined, undefined), null);
});

test("wallet RPC typed data includes the canonical domain schema and preserves the signed hash", async () => {
  const account = privateKeyToAccount(
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  const intent = createOwnershipIntent({
    wallet: account.address,
    handle: "xdevelopers",
    postId: "1900000000000000000",
    challenge: "APV2-abcdefghijklmnopqrstuvwx",
    challengeIssuedAtMs: 1_800_000_000_000,
    challengeExpiresAtMs: 1_800_000_900_000,
    credentialExpiresAtMs: 1_802_592_000_000,
    receiverContract: "0x2222222222222222222222222222222222222222",
    genlayerContract: "0x3333333333333333333333333333333333333333",
  });
  const storedPayload = {
    ...intent.typedData,
    domain: {
      ...intent.typedData.domain,
      chainId: BigInt(intent.typedData.domain.chainId),
    },
    message: {
      ...intent.typedData.message,
      credentialExpiresAt: BigInt(intent.typedData.message.credentialExpiresAt),
    },
  } as const;
  const walletPayload = typedDataForWalletRpc(storedPayload);

  assert.deepEqual(walletPayload.types.EIP712Domain, [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ]);
  assert.equal("EIP712Domain" in intent.typedData.types, false);
  assert.equal(hashTypedData(walletPayload), hashTypedData(storedPayload));

  const signature = await account.signTypedData(walletPayload);
  assert.equal(
    await verifyTypedData({
      address: account.address,
      ...storedPayload,
      signature,
    }),
    true,
  );
});
