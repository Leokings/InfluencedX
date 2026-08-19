import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import { loadConfig } from "../lib/config";
import { requireServiceToken } from "../lib/http";
import { verifyCallerToken } from "../lib/oidc";
import {
  BASE_SEPOLIA_ESCROW,
  BASE_SEPOLIA_RECEIVER,
  STUDIONET_RESOLVER,
  STUDIONET_RPC_URL,
} from "../lib/constants";
import { configFixture, watcherAddress, watcherPrivateKey } from "./helpers";

function envFixture(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    XPROOF_CAMPAIGN_WATCHER_ENABLED: "true",
    XPROOF_CAMPAIGN_WATCHER_STAGE: "testnet",
    XPROOF_BASE_CHAIN_ID: "84532",
    XPROOF_BASE_SEPOLIA_RPC_URL: "https://base.example.test",
    XPROOF_GENLAYER_NETWORK: "studionet",
    XPROOF_GENLAYER_CHAIN_ID: "61999",
    XPROOF_GENLAYER_RPC_URL: STUDIONET_RPC_URL,
    XPROOF_BASE_ESCROW: BASE_SEPOLIA_ESCROW,
    XPROOF_BASE_RECEIVER: BASE_SEPOLIA_RECEIVER,
    XPROOF_GENLAYER_RESOLVER: STUDIONET_RESOLVER,
    XPROOF_WATCHER_PRIVATE_KEY: watcherPrivateKey,
    XPROOF_WATCHER_ADDRESS: watcherAddress,
    XPROOF_WATCHER_SERVICE_TOKEN: "s".repeat(40),
    XPROOF_CALLER_TEAM_SLUG: "influencedx",
    XPROOF_CALLER_TEAM_ID: "team_123",
    XPROOF_CALLER_PROJECT_NAME: "influencedx-campaign-relay",
    XPROOF_CALLER_PROJECT_ID: "prj_123",
    XPROOF_CALLER_ENVIRONMENT: "preview",
    VERCEL_ENV: "preview",
    ...overrides,
  };
}

test("configuration permits exactly one pinned watcher key and fails closed", () => {
  const config = loadConfig(envFixture());
  assert.equal(config.watcherAddress, watcherAddress);
  assert.equal(config.genlayerNetwork, "studionet");
  assert.equal(config.genlayerChainId, 61_999);
  assert.equal(config.genlayerRpcUrl, STUDIONET_RPC_URL);
  assert.equal(config.resolver, STUDIONET_RESOLVER);
  for (const mutation of [
    { XPROOF_CAMPAIGN_WATCHER_ENABLED: "false" },
    { XPROOF_BASE_CHAIN_ID: "1" },
    { XPROOF_GENLAYER_NETWORK: "testnet-bradbury" },
    { XPROOF_GENLAYER_CHAIN_ID: "4221" },
    { XPROOF_GENLAYER_RPC_URL: "https://rpc-bradbury.genlayer.com" },
    { XPROOF_GENLAYER_RESOLVER: "0x017311b35dbB9802883bDaE7Fb0Efd7Bd77cB0b2" },
    { XPROOF_BASE_ESCROW: "0x3333333333333333333333333333333333333333" },
    { XPROOF_WATCHER_PRIVATE_KEY: `0x${"22".repeat(32)}` },
    { XPROOF_WATCHER_PRIVATE_KEYS: `${watcherPrivateKey},${watcherPrivateKey}` },
    { XPROOF_WATCHER_SERVICE_TOKEN: "short" },
    { VERCEL_ENV: "production" },
  ]) {
    assert.throws(() => loadConfig(envFixture(mutation)), (error: unknown) => (
      (error as { code?: string }).code === "WATCHER_CONFIGURATION_INVALID"
    ));
  }
});

test("service token comparison rejects missing, truncated, and wrong credentials", () => {
  const expected = "z".repeat(40);
  requireServiceToken(new Request("https://watcher.test", { headers: { "x-influencedx-service-token": expected } }), expected);
  for (const supplied of [undefined, "z".repeat(39), "x".repeat(40)]) {
    const headers = supplied ? { "x-influencedx-service-token": supplied } : undefined;
    assert.throws(() => requireServiceToken(new Request("https://watcher.test", { headers }), expected), (error: unknown) => (
      (error as { code?: string }).code === "SERVICE_AUTH_INVALID"
    ));
  }
});

test("OIDC auth binds issuer, audience, subject, team, project, and environment", async () => {
  const config = configFixture();
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const makeToken = async (overrides: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1_000);
    return new SignJWT({
      owner: config.caller.teamSlug,
      owner_id: config.caller.teamId,
      project: config.caller.projectName,
      project_id: config.caller.projectId,
      environment: config.caller.environment,
      ...overrides,
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(`https://oidc.vercel.com/${config.caller.teamSlug}`)
      .setAudience(`https://vercel.com/${config.caller.teamSlug}`)
      .setSubject(`owner:${config.caller.teamSlug}:project:${config.caller.projectName}:environment:${config.caller.environment}`)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
  };
  await verifyCallerToken(await makeToken(), config, publicKey);
  for (const mutation of [
    { owner_id: "team_attacker" },
    { project: "other" },
    { project_id: "prj_attacker" },
    { environment: "production" },
  ]) {
    await assert.rejects(verifyCallerToken(await makeToken(mutation), config, publicKey), (error: unknown) => (
      (error as { code?: string }).code === "CALLER_OIDC_INVALID"
    ));
  }
});
