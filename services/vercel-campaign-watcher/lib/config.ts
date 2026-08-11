import { getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_ESCROW,
  BASE_SEPOLIA_RECEIVER,
  BRADBURY_RESOLVER,
} from "./constants";
import { WatcherProblem } from "./problem";

export type WatcherConfig = Readonly<{
  baseRpcUrl: string;
  genlayerRpcUrl: string;
  escrow: typeof BASE_SEPOLIA_ESCROW;
  receiver: typeof BASE_SEPOLIA_RECEIVER;
  resolver: typeof BRADBURY_RESOLVER;
  watcherPrivateKey: `0x${string}`;
  watcherAddress: `0x${string}`;
  serviceToken: string;
  caller: Readonly<{
    teamSlug: string;
    teamId: string;
    projectName: string;
    projectId: string;
    environment: "preview" | "production";
  }>;
}>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WatcherConfig {
  if (required(env, "XPROOF_CAMPAIGN_WATCHER_ENABLED") !== "true") fail("XPROOF_CAMPAIGN_WATCHER_ENABLED must be exactly true.");
  if (required(env, "XPROOF_CAMPAIGN_WATCHER_STAGE") !== "testnet") fail("XPROOF_CAMPAIGN_WATCHER_STAGE must be testnet.");
  if (required(env, "XPROOF_BASE_CHAIN_ID") !== String(BASE_SEPOLIA_CHAIN_ID)) fail("XPROOF_BASE_CHAIN_ID must be 84532.");
  const baseRpcUrl = httpsUrl(required(env, "XPROOF_BASE_SEPOLIA_RPC_URL"), "XPROOF_BASE_SEPOLIA_RPC_URL");
  const genlayerRpcUrl = httpsUrl(required(env, "XPROOF_GENLAYER_RPC_URL"), "XPROOF_GENLAYER_RPC_URL");
  pinnedAddress(required(env, "XPROOF_BASE_ESCROW"), BASE_SEPOLIA_ESCROW, "XPROOF_BASE_ESCROW");
  pinnedAddress(required(env, "XPROOF_BASE_RECEIVER"), BASE_SEPOLIA_RECEIVER, "XPROOF_BASE_RECEIVER");
  pinnedAddress(required(env, "XPROOF_GENLAYER_RESOLVER"), BRADBURY_RESOLVER, "XPROOF_GENLAYER_RESOLVER");

  if (env.XPROOF_WATCHER_PRIVATE_KEYS || env.XPROOF_WATCHER_KEYSTORE || env.XPROOF_WATCHER_KEYSTORES) {
    fail("This deployment may be configured with exactly one watcher key.");
  }
  const watcherPrivateKey = required(env, "XPROOF_WATCHER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(watcherPrivateKey) || /^0x0{64}$/i.test(watcherPrivateKey)) {
    fail("XPROOF_WATCHER_PRIVATE_KEY must be one non-zero private key.");
  }
  const watcherAddress = required(env, "XPROOF_WATCHER_ADDRESS");
  if (!isAddress(watcherAddress, { strict: false })) fail("XPROOF_WATCHER_ADDRESS is invalid.");
  const derived = privateKeyToAccount(watcherPrivateKey as `0x${string}`).address;
  if (getAddress(derived) !== getAddress(watcherAddress)) fail("The watcher key does not match XPROOF_WATCHER_ADDRESS.");

  const serviceToken = required(env, "XPROOF_WATCHER_SERVICE_TOKEN");
  if (Buffer.byteLength(serviceToken, "utf8") < 32 || Buffer.byteLength(serviceToken, "utf8") > 256) {
    fail("XPROOF_WATCHER_SERVICE_TOKEN must contain 32-256 bytes.");
  }
  const teamSlug = slug(required(env, "XPROOF_CALLER_TEAM_SLUG"), "XPROOF_CALLER_TEAM_SLUG");
  const teamId = prefixed(required(env, "XPROOF_CALLER_TEAM_ID"), "team_", "XPROOF_CALLER_TEAM_ID");
  const projectName = project(required(env, "XPROOF_CALLER_PROJECT_NAME"));
  const projectId = prefixed(required(env, "XPROOF_CALLER_PROJECT_ID"), "prj_", "XPROOF_CALLER_PROJECT_ID");
  const environment = required(env, "XPROOF_CALLER_ENVIRONMENT");
  if (environment !== "preview" && environment !== "production") fail("XPROOF_CALLER_ENVIRONMENT must be preview or production.");
  if (env.VERCEL_ENV && env.VERCEL_ENV !== environment) fail("XPROOF_CALLER_ENVIRONMENT must match VERCEL_ENV.");

  return Object.freeze({
    baseRpcUrl,
    genlayerRpcUrl,
    escrow: BASE_SEPOLIA_ESCROW,
    receiver: BASE_SEPOLIA_RECEIVER,
    resolver: BRADBURY_RESOLVER,
    watcherPrivateKey: watcherPrivateKey as `0x${string}`,
    watcherAddress: getAddress(watcherAddress),
    serviceToken,
    caller: Object.freeze({ teamSlug, teamId, projectName, projectId, environment }),
  });
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required.`);
  return value as string;
}

function httpsUrl(value: string, name: string): string {
  let url: URL;
  try { url = new URL(value); } catch { fail(`${name} must be an HTTPS URL.`); }
  if (url!.protocol !== "https:" || url!.username || url!.password || url!.hash) fail(`${name} must be an HTTPS URL without credentials or a fragment.`);
  return url!.toString();
}

function pinnedAddress(value: string, expected: string, name: string): void {
  if (!isAddress(value, { strict: false }) || getAddress(value) !== getAddress(expected)) fail(`${name} must be the pinned Base Sepolia deployment address.`);
}

function slug(value: string, name: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(value)) fail(`${name} is invalid.`);
  return value;
}

function prefixed(value: string, prefix: string, name: string): string {
  if (!new RegExp(`^${prefix}[A-Za-z0-9]+$`).test(value)) fail(`${name} is invalid.`);
  return value;
}

function project(value: string): string {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(value)) fail("XPROOF_CALLER_PROJECT_NAME is invalid.");
  return value;
}

function fail(message: string): never {
  throw new WatcherProblem(503, "WATCHER_CONFIGURATION_INVALID", message);
}
