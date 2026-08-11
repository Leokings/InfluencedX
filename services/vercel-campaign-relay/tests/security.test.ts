import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import { loadConfig } from "../lib/config";
import { verifyCallerToken } from "../lib/auth";
import {
  BASE_SEPOLIA_ESCROW,
  BASE_SEPOLIA_RECEIVER,
  BRADBURY_RESOLVER,
} from "../lib/constants";
import {
  configFixture,
  relayerAddress,
  relayerKey,
  watcherAccounts,
  watcherKeys,
} from "./helpers";

function envFixture(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://user:password@db.example.test/db?sslmode=require",
    XPROOF_CAMPAIGN_RELAY_ENABLED: "true",
    XPROOF_CAMPAIGN_RELAY_STAGE: "testnet",
    XPROOF_CAMPAIGN_RELAY_BROADCAST_ENABLED: "true",
    XPROOF_BASE_CHAIN_ID: "84532",
    XPROOF_BASE_SEPOLIA_RPC_URL: "https://base.example.test",
    XPROOF_GENLAYER_RPC_URL: "https://genlayer.example.test",
    XPROOF_BASE_ESCROW: BASE_SEPOLIA_ESCROW,
    XPROOF_BASE_RECEIVER: BASE_SEPOLIA_RECEIVER,
    XPROOF_GENLAYER_RESOLVER: BRADBURY_RESOLVER,
    XPROOF_BASE_RELAYER_PRIVATE_KEY: relayerKey,
    XPROOF_BASE_RELAYER_ADDRESS: relayerAddress,
    XPROOF_RELAYER_MAX_BALANCE_WEI: "10000000000000000",
    XPROOF_RELAY_SERVICE_TOKEN: "r".repeat(40),
    XPROOF_WATCHER_1_URL: "https://watcher-1.example.test",
    XPROOF_WATCHER_1_ADDRESS: watcherAccounts[0]!.address,
    XPROOF_WATCHER_1_SERVICE_TOKEN: "1".repeat(40),
    XPROOF_WATCHER_2_URL: "https://watcher-2.example.test",
    XPROOF_WATCHER_2_ADDRESS: watcherAccounts[1]!.address,
    XPROOF_WATCHER_2_SERVICE_TOKEN: "2".repeat(40),
    XPROOF_WATCHER_3_URL: "https://watcher-3.example.test",
    XPROOF_WATCHER_3_ADDRESS: watcherAccounts[2]!.address,
    XPROOF_WATCHER_3_SERVICE_TOKEN: "3".repeat(40),
    XPROOF_CALLER_TEAM_SLUG: "influencedx",
    XPROOF_CALLER_TEAM_ID: "team_123",
    XPROOF_CALLER_PROJECT_NAME: "influencedx-web",
    XPROOF_CALLER_PROJECT_ID: "prj_123",
    XPROOF_CALLER_ENVIRONMENT: "preview",
    VERCEL_ENV: "preview",
    ...overrides,
  };
}

test("relay configuration isolates one low-balance Base key from all watcher and GenLayer keys", () => {
  const config = loadConfig(envFixture());
  assert.equal(config.relayerAddress, relayerAddress);
  assert.equal(config.watchers.length, 3);
  const cases: NodeJS.ProcessEnv[] = [
    { XPROOF_CAMPAIGN_RELAY_ENABLED: "false" },
    { XPROOF_BASE_CHAIN_ID: "1" },
    { XPROOF_BASE_RECEIVER: "0x5555555555555555555555555555555555555555" },
    { XPROOF_BASE_RELAYER_PRIVATE_KEY: watcherKeys[0], XPROOF_BASE_RELAYER_ADDRESS: watcherAccounts[0]!.address },
    { XPROOF_WATCHER_PRIVATE_KEY: watcherKeys[0] },
    { XPROOF_WATCHER_2_URL: "https://watcher-1.example.test" },
    { XPROOF_WATCHER_2_ADDRESS: watcherAccounts[0]!.address },
    { XPROOF_RELAY_SERVICE_TOKEN: "short" },
    { XPROOF_RELAYER_MAX_BALANCE_WEI: "0" },
    { VERCEL_ENV: "production" },
  ];
  for (const mutation of cases) {
    assert.throws(() => loadConfig(envFixture(mutation)), (error: unknown) => (
      (error as { code?: string }).code === "RELAY_CONFIGURATION_INVALID"
    ));
  }
});

test("broadcast cannot be enabled without the dedicated relayer key", () => {
  assert.throws(() => loadConfig(envFixture({
    XPROOF_BASE_RELAYER_PRIVATE_KEY: undefined,
    XPROOF_BASE_RELAYER_ADDRESS: undefined,
  })), /RELAYER_PRIVATE_KEY/);
  const simulationOnly = loadConfig(envFixture({
    XPROOF_CAMPAIGN_RELAY_BROADCAST_ENABLED: "false",
    XPROOF_BASE_RELAYER_PRIVATE_KEY: undefined,
    XPROOF_BASE_RELAYER_ADDRESS: undefined,
  }));
  assert.equal(simulationOnly.broadcastEnabled, false);
  assert.equal(simulationOnly.relayerPrivateKey, null);
});

test("relay OIDC binds the exact web caller deployment", async () => {
  const config = configFixture();
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const token = async (overrides: Record<string, unknown> = {}) => {
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
  await verifyCallerToken(await token(), config, publicKey);
  for (const mutation of [{ project_id: "prj_attacker" }, { owner_id: "team_attacker" }, { environment: "production" }]) {
    await assert.rejects(verifyCallerToken(await token(mutation), config, publicKey), (error: unknown) => (
      (error as { code?: string }).code === "CALLER_OIDC_INVALID"
    ));
  }
});
