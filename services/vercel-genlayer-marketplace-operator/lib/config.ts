import {
  MARKETPLACE_ADDRESS,
  MARKETPLACE_PROTOCOL,
  MARKETPLACE_RPC_ADDRESS,
  MARKETPLACE_SCHEMA_VERSION,
  OPERATOR_NETWORK,
  OPERATOR_STAGE,
  STUDIONET_CHAIN_ID,
  STUDIONET_RPC_URL,
} from "./constants";
import { OperatorProblem } from "./problem";

export type OperatorConfig = Readonly<{
  enabled: true;
  stage: "studionet";
  network: "studionet";
  chainId: typeof STUDIONET_CHAIN_ID;
  rpcUrl: typeof STUDIONET_RPC_URL;
  contractAddress: `0x${string}`;
  rpcContractAddress: typeof MARKETPLACE_RPC_ADDRESS;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OperatorConfig {
  const enabled = required(env, "INFLUENCEDX_MARKETPLACE_OPERATOR_ENABLED");
  const stage = required(env, "INFLUENCEDX_MARKETPLACE_OPERATOR_STAGE");
  const network = required(env, "INFLUENCEDX_GENLAYER_NETWORK");
  const chainId = required(env, "INFLUENCEDX_GENLAYER_CHAIN_ID");
  const contractAddress = required(env, "INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS").toLowerCase();
  const contractProtocol = required(env, "INFLUENCEDX_GENLAYER_MARKETPLACE_PROTOCOL");
  const contractSchemaVersion = required(env, "INFLUENCEDX_GENLAYER_MARKETPLACE_SCHEMA_VERSION");
  const privateKey = required(env, "GENLAYER_MARKETPLACE_OPERATOR_PRIVATE_KEY");
  const databaseUrl = required(env, "DATABASE_URL");
  const serviceToken = required(env, "INFLUENCEDX_OPERATOR_SERVICE_TOKEN");
  const teamSlug = required(env, "INFLUENCEDX_OPERATOR_CALLER_TEAM_SLUG");
  const teamId = required(env, "INFLUENCEDX_OPERATOR_CALLER_TEAM_ID");
  const projectName = required(env, "INFLUENCEDX_OPERATOR_CALLER_PROJECT_NAME");
  const projectId = required(env, "INFLUENCEDX_OPERATOR_CALLER_PROJECT_ID");
  const environment = required(env, "INFLUENCEDX_OPERATOR_CALLER_ENVIRONMENT");

  if (enabled !== "true") fail("INFLUENCEDX_MARKETPLACE_OPERATOR_ENABLED must be exactly true.");
  if (stage !== OPERATOR_STAGE) fail(`INFLUENCEDX_MARKETPLACE_OPERATOR_STAGE must be ${OPERATOR_STAGE}.`);
  if (network !== OPERATOR_NETWORK) fail(`INFLUENCEDX_GENLAYER_NETWORK must be ${OPERATOR_NETWORK}.`);
  if (chainId !== String(STUDIONET_CHAIN_ID)) fail(`INFLUENCEDX_GENLAYER_CHAIN_ID must be ${STUDIONET_CHAIN_ID}.`);
  if (!/^0x[0-9a-f]{40}$/.test(contractAddress) || /^0x0{40}$/.test(contractAddress)) {
    fail("INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS must be an exact non-zero contract address.");
  }
  if (contractAddress !== MARKETPLACE_ADDRESS) {
    fail("INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS is not the pinned V3 deployment.");
  }
  if (contractProtocol !== MARKETPLACE_PROTOCOL) {
    fail("INFLUENCEDX_GENLAYER_MARKETPLACE_PROTOCOL must pin V3.");
  }
  if (contractSchemaVersion !== String(MARKETPLACE_SCHEMA_VERSION)) {
    fail("INFLUENCEDX_GENLAYER_MARKETPLACE_SCHEMA_VERSION must pin schema 3.");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey) || /^0x0{64}$/i.test(privateKey)) {
    fail("GENLAYER_MARKETPLACE_OPERATOR_PRIVATE_KEY must be a non-zero 32-byte key.");
  }
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) fail("DATABASE_URL must be a PostgreSQL connection URL.");
  if (!/^[0-9a-fA-F]{64}$/.test(serviceToken)) {
    fail("INFLUENCEDX_OPERATOR_SERVICE_TOKEN must be a random 32-byte hex token.");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(teamSlug)) fail("The caller team slug is invalid.");
  if (!/^team_[A-Za-z0-9]+$/.test(teamId)) fail("The caller team ID is invalid.");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(projectName)) fail("The caller project name is invalid.");
  if (!/^prj_[A-Za-z0-9]+$/.test(projectId)) fail("The caller project ID is invalid.");
  if (environment !== "preview" && environment !== "production") fail("The caller environment must be preview or production.");
  if (env.VERCEL_ENV && env.VERCEL_ENV !== environment) {
    fail("The caller environment must match this operator deployment environment.");
  }

  return Object.freeze({
    enabled: true,
    stage: OPERATOR_STAGE,
    network: OPERATOR_NETWORK,
    chainId: STUDIONET_CHAIN_ID,
    rpcUrl: STUDIONET_RPC_URL,
    contractAddress: contractAddress as `0x${string}`,
    rpcContractAddress: MARKETPLACE_RPC_ADDRESS,
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
  throw new OperatorProblem(503, "OPERATOR_CONFIGURATION_INVALID", message);
}
