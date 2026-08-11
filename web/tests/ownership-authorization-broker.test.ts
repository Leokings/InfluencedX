import assert from "node:assert/strict";
import test from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";
import { hexToBytes, type Address, type Hex } from "viem";

import { ownershipAuthorizationGrants, verificationRequests } from "../db/schema.ts";
import {
  OWNERSHIP_AUTHORIZATION_GRANT_TTL_MS,
  buildOwnershipAuthorizationGrant,
  issueOwnershipAuthorizationCiphertext,
  ownershipAuthorizationOaepLabel,
  ownershipAuthorizationPublicKeyFingerprint,
  ownershipAuthorizationTokenHash,
  type OwnershipAuthorizationBinding,
} from "../lib/ownership-authorization-broker.ts";

const TOKEN = Buffer.alloc(32, 0x19).toString("base64url");
const SIGNATURE = `0x${"ab".repeat(65)}` as Hex;
const NOW_MS = 1_786_270_000_000;
const BINDING = Object.freeze({
  requestId: `0x${"11".repeat(32)}` as Hex,
  genlayerTxHash: `0x${"22".repeat(32)}` as Hex,
  resolver: "0x017311b35dbB9802883bDaE7Fb0Efd7Bd77cB0b2" as Address,
  baseReceiver: "0x15dDbCd98F97065746a1c35f88BB670a7A942264" as Address,
  baseRegistry: "0x10079EF049D283BC3f212CCaC4291b3aC2719C48" as Address,
  expectedWallet: "0x63038a310a46AC61A59c1bC5eAD5fe41040eF38e" as Address,
}) satisfies OwnershipAuthorizationBinding;

function previewEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    VERCEL_ENV: "preview",
    VERCEL_TARGET_ENV: "preview",
    XPROOF_AUTHORIZATION_BROKER_ENABLED: "true",
    XPROOF_GENLAYER_CONTRACT: BINDING.resolver,
    XPROOF_ATTESTATION_RECEIVER: BINDING.baseReceiver,
    XPROOF_CREATOR_REGISTRY: BINDING.baseRegistry,
  };
}

async function ephemeralKey() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2_048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  return { pair, publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

test("grant values contain only a digest and an exact, short-lived relay binding", () => {
  const grant = buildOwnershipAuthorizationGrant({
    token: TOKEN,
    binding: BINDING,
    createdAtMs: NOW_MS,
    expiresAtMs: NOW_MS + OWNERSHIP_AUTHORIZATION_GRANT_TTL_MS,
  });
  assert.equal(grant.tokenHash, ownershipAuthorizationTokenHash(TOKEN));
  assert.equal(grant.requestId, BINDING.requestId);
  assert.equal(grant.expectedWallet, BINDING.expectedWallet);
  assert.equal("token" in grant, false);
  assert.doesNotMatch(JSON.stringify(grant), new RegExp(TOKEN));
  assert.throws(() =>
    buildOwnershipAuthorizationGrant({
      token: TOKEN,
      binding: BINDING,
      createdAtMs: NOW_MS,
      expiresAtMs: NOW_MS + OWNERSHIP_AUTHORIZATION_GRANT_TTL_MS + 1,
    }),
  );
});

test("Preview broker burns the grant before loading and returns only decryptable RSA-OAEP ciphertext", async () => {
  const { pair, publicJwk } = await ephemeralKey();
  const order: string[] = [];
  const response = await issueOwnershipAuthorizationCiphertext(
    { token: TOKEN, ...BINDING, ephemeralPublicKey: publicJwk },
    {
      environment: previewEnvironment(),
      nowMs: NOW_MS,
      async consumeGrant(input) {
        order.push("consume");
        assert.equal(input.tokenHash, ownershipAuthorizationTokenHash(TOKEN));
        assert.equal(input.binding.requestId, BINDING.requestId);
        return true;
      },
      async loadSignature(binding) {
        order.push("load");
        assert.equal(binding.genlayerTxHash, BINDING.genlayerTxHash);
        return SIGNATURE;
      },
    },
  );
  assert.deepEqual(order, ["consume", "load"]);
  assert.deepEqual(Object.keys(response), ["ciphertext"]);
  assert.doesNotMatch(JSON.stringify(response), /abababab/i);

  const fingerprint = ownershipAuthorizationPublicKeyFingerprint(publicJwk);
  const label = ownershipAuthorizationOaepLabel(BINDING, fingerprint);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "RSA-OAEP",
      label: label.buffer.slice(
        label.byteOffset,
        label.byteOffset + label.byteLength,
      ) as ArrayBuffer,
    },
    pair.privateKey,
    Buffer.from(response.ciphertext, "base64url"),
  );
  assert.deepEqual(new Uint8Array(decrypted), hexToBytes(SIGNATURE));
});

test("Production always fails closed before a grant or sealed evidence is touched", async () => {
  const { publicJwk } = await ephemeralKey();
  let touched = false;
  await assert.rejects(
    issueOwnershipAuthorizationCiphertext(
      { token: TOKEN, ...BINDING, ephemeralPublicKey: publicJwk },
      {
        environment: { ...previewEnvironment(), VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production" },
        async consumeGrant() { touched = true; return true; },
        async loadSignature() { touched = true; return SIGNATURE; },
      },
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "NOT_FOUND",
  );
  assert.equal(touched, false);
});

test("An invalid, expired, or replayed grant cannot reach sealed evidence", async () => {
  const { publicJwk } = await ephemeralKey();
  let loaded = false;
  await assert.rejects(
    issueOwnershipAuthorizationCiphertext(
      { token: TOKEN, ...BINDING, ephemeralPublicKey: publicJwk },
      {
        environment: previewEnvironment(),
        async consumeGrant() { return false; },
        async loadSignature() { loaded = true; return SIGNATURE; },
      },
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_OR_USED_GRANT",
  );
  assert.equal(loaded, false);
});

test("The broker rejects a deployment-binding mismatch before consuming a grant", async () => {
  const { publicJwk } = await ephemeralKey();
  let consumed = false;
  await assert.rejects(
    issueOwnershipAuthorizationCiphertext(
      { token: TOKEN, ...BINDING, ephemeralPublicKey: publicJwk },
      {
        environment: { ...previewEnvironment(), XPROOF_CREATOR_REGISTRY: "0x1111111111111111111111111111111111111111" },
        async consumeGrant() { consumed = true; return true; },
      },
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "DEPLOYMENT_BINDING_MISMATCH",
  );
  assert.equal(consumed, false);
});

test("Postgres schema persists relay status and one-time grant replay protection", () => {
  const requests = getTableConfig(verificationRequests);
  const requestColumns = new Set(requests.columns.map((column) => column.name));
  const requestChecks = new Set(requests.checks.map((check) => check.name));
  const requestIndexes = new Set(requests.indexes.map((index) => index.config.name));
  for (const column of ["base_relay_status", "base_relay_tx_hash", "base_registry_address", "base_profile_verified"]) {
    assert.ok(requestColumns.has(column), `missing ${column}`);
  }
  assert.ok(requestChecks.has("verification_requests_base_confirmation_state"));
  assert.ok(requestIndexes.has("verification_requests_base_relay_tx_idx"));

  const grants = getTableConfig(ownershipAuthorizationGrants);
  const grantChecks = new Set(grants.checks.map((check) => check.name));
  assert.ok(grantChecks.has("ownership_authorization_grants_short_lived"));
  assert.ok(grantChecks.has("ownership_authorization_grants_consumption_pair"));
  assert.ok(grantChecks.has("ownership_authorization_grants_token_hash_format"));
});
