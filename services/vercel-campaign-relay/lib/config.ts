import { getAddress, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_ESCROW,
  BASE_SEPOLIA_RECEIVER,
  GENLAYER_NETWORK,
  STUDIONET_CHAIN_ID,
  STUDIONET_RESOLVER,
  STUDIONET_RPC_URL,
} from "./constants.js";
import { RelayProblem } from "./problem.js";

export type WatcherTarget = Readonly<{
  origin: string;
  address: Address;
  serviceToken: string;
}>;

export type RelayConfig = Readonly<{
  databaseUrl: string;
  baseRpcUrl: string;
  genlayerNetwork: typeof GENLAYER_NETWORK;
  genlayerChainId: typeof STUDIONET_CHAIN_ID;
  genlayerRpcUrl: typeof STUDIONET_RPC_URL;
  escrow: typeof BASE_SEPOLIA_ESCROW;
  receiver: typeof BASE_SEPOLIA_RECEIVER;
  resolver: typeof STUDIONET_RESOLVER;
  broadcastEnabled: boolean;
  relayerPrivateKey: Hex | null;
  relayerAddress: Address | null;
  relayerMaxBalanceWei: bigint;
  serviceToken: string;
  watchers: readonly [WatcherTarget, WatcherTarget, WatcherTarget];
  caller: Readonly<{
    teamSlug: string;
    teamId: string;
    projectName: string;
    projectId: string;
    environment: "preview" | "production";
  }>;
}>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  if (required(env, "XPROOF_CAMPAIGN_RELAY_ENABLED") !== "true") fail("XPROOF_CAMPAIGN_RELAY_ENABLED must be exactly true.");
  if (required(env, "XPROOF_CAMPAIGN_RELAY_STAGE") !== "testnet") fail("XPROOF_CAMPAIGN_RELAY_STAGE must be testnet.");
  if (required(env, "XPROOF_BASE_CHAIN_ID") !== String(BASE_SEPOLIA_CHAIN_ID)) fail("XPROOF_BASE_CHAIN_ID must be 84532.");
  const databaseUrl = postgresUrl(required(env, "DATABASE_URL"));
  const baseRpcUrl = httpsUrl(required(env, "XPROOF_BASE_SEPOLIA_RPC_URL"), "XPROOF_BASE_SEPOLIA_RPC_URL", true);
  if (required(env, "XPROOF_GENLAYER_NETWORK") !== GENLAYER_NETWORK) fail("XPROOF_GENLAYER_NETWORK must be studionet.");
  if (required(env, "XPROOF_GENLAYER_CHAIN_ID") !== String(STUDIONET_CHAIN_ID)) fail("XPROOF_GENLAYER_CHAIN_ID must be 61999.");
  const genlayerRpcUrl = httpsUrl(required(env, "XPROOF_GENLAYER_RPC_URL"), "XPROOF_GENLAYER_RPC_URL", true);
  if (genlayerRpcUrl !== STUDIONET_RPC_URL) fail("XPROOF_GENLAYER_RPC_URL must be the pinned StudioNet RPC URL.");
  pinnedAddress(required(env, "XPROOF_BASE_ESCROW"), BASE_SEPOLIA_ESCROW, "XPROOF_BASE_ESCROW");
  pinnedAddress(required(env, "XPROOF_BASE_RECEIVER"), BASE_SEPOLIA_RECEIVER, "XPROOF_BASE_RECEIVER");
  pinnedAddress(required(env, "XPROOF_GENLAYER_RESOLVER"), STUDIONET_RESOLVER, "XPROOF_GENLAYER_RESOLVER");
  const broadcastRaw = required(env, "XPROOF_CAMPAIGN_RELAY_BROADCAST_ENABLED");
  if (broadcastRaw !== "true" && broadcastRaw !== "false") fail("XPROOF_CAMPAIGN_RELAY_BROADCAST_ENABLED must be true or false.");
  const broadcastEnabled = broadcastRaw === "true";
  if (env.XPROOF_BASE_RELAYER_PRIVATE_KEYS || env.XPROOF_WATCHER_PRIVATE_KEY || env.GENLAYER_SUBMITTER_PRIVATE_KEY) {
    fail("The relay deployment may contain only one dedicated Base relayer key and no watcher or GenLayer signer key.");
  }
  const relayerPrivateKeyRaw = env.XPROOF_BASE_RELAYER_PRIVATE_KEY;
  const relayerAddressRaw = env.XPROOF_BASE_RELAYER_ADDRESS;
  let relayerPrivateKey: Hex | null = null;
  let relayerAddress: Address | null = null;
  if (broadcastEnabled || relayerPrivateKeyRaw || relayerAddressRaw) {
    if (!relayerPrivateKeyRaw || !/^0x[0-9a-fA-F]{64}$/.test(relayerPrivateKeyRaw) || /^0x0{64}$/i.test(relayerPrivateKeyRaw)) fail("XPROOF_BASE_RELAYER_PRIVATE_KEY must be one non-zero key.");
    if (!relayerAddressRaw || !isAddress(relayerAddressRaw, { strict: false })) fail("XPROOF_BASE_RELAYER_ADDRESS is invalid.");
    const derived = privateKeyToAccount(relayerPrivateKeyRaw as Hex).address;
    if (getAddress(derived) !== getAddress(relayerAddressRaw)) fail("The Base relayer key and address do not match.");
    relayerPrivateKey = relayerPrivateKeyRaw as Hex;
    relayerAddress = getAddress(relayerAddressRaw);
  }
  const relayerMaxBalanceWei = positiveUint(required(env, "XPROOF_RELAYER_MAX_BALANCE_WEI"), "XPROOF_RELAYER_MAX_BALANCE_WEI");
  const serviceToken = token(required(env, "XPROOF_RELAY_SERVICE_TOKEN"), "XPROOF_RELAY_SERVICE_TOKEN");
  const watchers = [1, 2, 3].map((index) => Object.freeze({
    origin: httpsUrl(required(env, `XPROOF_WATCHER_${index}_URL`), `XPROOF_WATCHER_${index}_URL`, false),
    address: checkedAddress(required(env, `XPROOF_WATCHER_${index}_ADDRESS`), `XPROOF_WATCHER_${index}_ADDRESS`),
    serviceToken: token(required(env, `XPROOF_WATCHER_${index}_SERVICE_TOKEN`), `XPROOF_WATCHER_${index}_SERVICE_TOKEN`),
  })) as unknown as [WatcherTarget, WatcherTarget, WatcherTarget];
  if (new Set(watchers.map((watcher) => watcher.origin)).size !== 3) fail("Watcher deployments must use three distinct origins.");
  if (new Set(watchers.map((watcher) => watcher.address.toLowerCase())).size !== 3) fail("Watcher addresses must be distinct.");
  if (relayerAddress && watchers.some((watcher) => watcher.address === relayerAddress)) fail("The Base relayer must not reuse a watcher key.");

  const teamSlug = slug(required(env, "XPROOF_CALLER_TEAM_SLUG"));
  const teamId = prefixed(required(env, "XPROOF_CALLER_TEAM_ID"), "team_", "XPROOF_CALLER_TEAM_ID");
  const projectName = project(required(env, "XPROOF_CALLER_PROJECT_NAME"));
  const projectId = prefixed(required(env, "XPROOF_CALLER_PROJECT_ID"), "prj_", "XPROOF_CALLER_PROJECT_ID");
  const environment = required(env, "XPROOF_CALLER_ENVIRONMENT");
  if (environment !== "preview" && environment !== "production") fail("XPROOF_CALLER_ENVIRONMENT must be preview or production.");
  if (env.VERCEL_ENV && env.VERCEL_ENV !== environment) fail("XPROOF_CALLER_ENVIRONMENT must match VERCEL_ENV.");

  return Object.freeze({
    databaseUrl,
    baseRpcUrl,
    genlayerNetwork: GENLAYER_NETWORK,
    genlayerChainId: STUDIONET_CHAIN_ID,
    genlayerRpcUrl: STUDIONET_RPC_URL,
    escrow: BASE_SEPOLIA_ESCROW,
    receiver: BASE_SEPOLIA_RECEIVER,
    resolver: STUDIONET_RESOLVER,
    broadcastEnabled,
    relayerPrivateKey,
    relayerAddress,
    relayerMaxBalanceWei,
    serviceToken,
    watchers: Object.freeze(watchers),
    caller: Object.freeze({ teamSlug, teamId, projectName, projectId, environment }),
  });
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required.`);
  return value as string;
}
function postgresUrl(value: string): string {
  let url: URL; try { url = new URL(value); } catch { fail("DATABASE_URL must be a PostgreSQL URL."); }
  if (!/^postgres(?:ql)?:$/.test(url!.protocol)) fail("DATABASE_URL must be a PostgreSQL URL.");
  return value;
}
function httpsUrl(value: string, name: string, allowPath: boolean): string {
  let url: URL; try { url = new URL(value); } catch { fail(`${name} must be an HTTPS URL.`); }
  if (url!.protocol !== "https:" || url!.username || url!.password || url!.hash || (!allowPath && (url!.pathname !== "/" || url!.search))) fail(`${name} must be a credential-free HTTPS ${allowPath ? "URL" : "origin"}.`);
  return allowPath ? url!.toString() : url!.origin;
}
function pinnedAddress(value: string, expected: string, name: string): void {
  if (!isAddress(value, { strict: false }) || getAddress(value) !== getAddress(expected)) fail(`${name} must be the pinned deployment address.`);
}
function checkedAddress(value: string, name: string): Address {
  if (!isAddress(value, { strict: false })) fail(`${name} is invalid.`);
  return getAddress(value);
}
function token(value: string, name: string): string {
  const length = Buffer.byteLength(value, "utf8");
  if (length < 32 || length > 256) fail(`${name} must contain 32-256 bytes.`);
  return value;
}
function positiveUint(value: string, name: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) fail(`${name} must be a positive integer.`);
  return BigInt(value);
}
function slug(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(value)) fail("XPROOF_CALLER_TEAM_SLUG is invalid.");
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
function fail(message: string): never { throw new RelayProblem(503, "RELAY_CONFIGURATION_INVALID", message); }
