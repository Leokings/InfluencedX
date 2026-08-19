import { createAccount } from "genlayer-js";

import {
  MARKETPLACE_ADDRESS,
  MARKETPLACE_PROTOCOL,
  MARKETPLACE_RPC_ADDRESS,
  MARKETPLACE_SCHEMA_VERSION,
  MARKETPLACE_WITHDRAWAL_CONFIRMER,
  RECONCILER_NETWORK,
  RECONCILER_STAGE,
  STUDIONET_CHAIN_ID,
  STUDIONET_RPC_URL,
} from "./constants";
import { ReconcilerProblem } from "./problem";

export type ReconcilerConfig = Readonly<{
  enabled: true;
  stage: typeof RECONCILER_STAGE;
  network: typeof RECONCILER_NETWORK;
  chainId: typeof STUDIONET_CHAIN_ID;
  rpcUrl: typeof STUDIONET_RPC_URL;
  contractAddress: typeof MARKETPLACE_ADDRESS;
  rpcContractAddress: typeof MARKETPLACE_RPC_ADDRESS;
  contractWithdrawalConfirmer: string;
  contractProtocol: typeof MARKETPLACE_PROTOCOL;
  contractSchemaVersion: typeof MARKETPLACE_SCHEMA_VERSION;
  privateKey: `0x${string}`;
  databaseUrl: string;
  serviceToken: string;
  caller: Readonly<{
    teamSlug: string;
    teamId: string;
    projectName: string;
    projectId: string;
    environment: "preview" | "production";
  }>;
}>;

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  deriveSignerAddress: (privateKey: `0x${string}`) => string = (privateKey) => createAccount(privateKey).address,
): ReconcilerConfig {
  const enabled = required(env, "INFLUENCEDX_WITHDRAWAL_RECONCILER_ENABLED");
  const stage = required(env, "INFLUENCEDX_WITHDRAWAL_RECONCILER_STAGE");
  const network = required(env, "INFLUENCEDX_GENLAYER_NETWORK");
  const chainId = required(env, "INFLUENCEDX_GENLAYER_CHAIN_ID");
  const rpcUrl = required(env, "INFLUENCEDX_GENLAYER_RPC_URL");
  const contractAddress = required(env, "INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS").toLowerCase();
  const contractWithdrawalConfirmer = required(
    env,
    "INFLUENCEDX_GENLAYER_MARKETPLACE_WITHDRAWAL_CONFIRMER",
  ).toLowerCase();
  const contractProtocol = required(env, "INFLUENCEDX_GENLAYER_MARKETPLACE_PROTOCOL");
  const contractSchemaVersion = required(env, "INFLUENCEDX_GENLAYER_MARKETPLACE_SCHEMA_VERSION");
  const privateKey = required(env, "GENLAYER_WITHDRAWAL_CONFIRMER_PRIVATE_KEY");
  const databaseUrl = required(env, "DATABASE_URL");
  const serviceToken = required(env, "INFLUENCEDX_WITHDRAWAL_RECONCILER_SERVICE_TOKEN");
  const teamSlug = required(env, "INFLUENCEDX_WITHDRAWAL_CALLER_TEAM_SLUG");
  const teamId = required(env, "INFLUENCEDX_WITHDRAWAL_CALLER_TEAM_ID");
  const projectName = required(env, "INFLUENCEDX_WITHDRAWAL_CALLER_PROJECT_NAME");
  const projectId = required(env, "INFLUENCEDX_WITHDRAWAL_CALLER_PROJECT_ID");
  const environment = required(env, "INFLUENCEDX_WITHDRAWAL_CALLER_ENVIRONMENT");

  if (enabled !== "true") fail("INFLUENCEDX_WITHDRAWAL_RECONCILER_ENABLED must be exactly true.");
  if (stage !== RECONCILER_STAGE) fail(`INFLUENCEDX_WITHDRAWAL_RECONCILER_STAGE must be ${RECONCILER_STAGE}.`);
  if (network !== RECONCILER_NETWORK) fail(`INFLUENCEDX_GENLAYER_NETWORK must be ${RECONCILER_NETWORK}.`);
  if (chainId !== String(STUDIONET_CHAIN_ID)) fail(`INFLUENCEDX_GENLAYER_CHAIN_ID must be ${STUDIONET_CHAIN_ID}.`);
  if (rpcUrl !== STUDIONET_RPC_URL) fail("INFLUENCEDX_GENLAYER_RPC_URL is not the pinned StudioNet endpoint.");
  if (contractAddress !== MARKETPLACE_ADDRESS) fail("INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS is not the pinned V2 deployment.");
  if (!/^0x[0-9a-f]{40}$/.test(contractWithdrawalConfirmer) || /^0x0{40}$/.test(contractWithdrawalConfirmer)) {
    fail("INFLUENCEDX_GENLAYER_MARKETPLACE_WITHDRAWAL_CONFIRMER must be a non-zero address.");
  }
  if (contractWithdrawalConfirmer !== MARKETPLACE_WITHDRAWAL_CONFIRMER) {
    fail("INFLUENCEDX_GENLAYER_MARKETPLACE_WITHDRAWAL_CONFIRMER is not the pinned confirmer.");
  }
  if (contractProtocol !== MARKETPLACE_PROTOCOL) fail("The marketplace protocol must be INFLUENCEDX_MARKETPLACE_V2.");
  if (contractSchemaVersion !== String(MARKETPLACE_SCHEMA_VERSION)) fail("The marketplace storage schema must be 2.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey) || /^0x0{64}$/i.test(privateKey)) {
    fail("GENLAYER_WITHDRAWAL_CONFIRMER_PRIVATE_KEY must be a non-zero 32-byte key.");
  }
  let signerAddress: string;
  try {
    signerAddress = deriveSignerAddress(privateKey as `0x${string}`).toLowerCase();
  } catch {
    fail("GENLAYER_WITHDRAWAL_CONFIRMER_PRIVATE_KEY is invalid.");
  }
  if (signerAddress !== contractWithdrawalConfirmer) {
    fail("GENLAYER_WITHDRAWAL_CONFIRMER_PRIVATE_KEY does not derive to the configured withdrawal confirmer.");
  }
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) fail("DATABASE_URL must be a PostgreSQL connection URL.");
  if (!/^[0-9a-fA-F]{64}$/.test(serviceToken)) fail("The reconciler service token must be random 32-byte hex.");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(teamSlug)) fail("The caller team slug is invalid.");
  if (!/^team_[A-Za-z0-9]+$/.test(teamId)) fail("The caller team ID is invalid.");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(projectName)) fail("The caller project name is invalid.");
  if (!/^prj_[A-Za-z0-9]+$/.test(projectId)) fail("The caller project ID is invalid.");
  if (environment !== "preview" && environment !== "production") fail("The caller environment is invalid.");
  if (env.VERCEL_ENV && env.VERCEL_ENV !== environment) fail("The caller environment must match this deployment.");

  return Object.freeze({
    enabled: true,
    stage: RECONCILER_STAGE,
    network: RECONCILER_NETWORK,
    chainId: STUDIONET_CHAIN_ID,
    rpcUrl: STUDIONET_RPC_URL,
    contractAddress: MARKETPLACE_ADDRESS,
    rpcContractAddress: MARKETPLACE_RPC_ADDRESS,
    contractWithdrawalConfirmer,
    contractProtocol: MARKETPLACE_PROTOCOL,
    contractSchemaVersion: MARKETPLACE_SCHEMA_VERSION,
    privateKey: privateKey as `0x${string}`,
    databaseUrl,
    serviceToken: serviceToken.toLowerCase(),
    caller: Object.freeze({ teamSlug, teamId, projectName, projectId, environment }),
  });
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required.`);
  return value as string;
}

function fail(message: string): never {
  throw new ReconcilerProblem(503, "RECONCILER_CONFIGURATION_INVALID", message);
}
