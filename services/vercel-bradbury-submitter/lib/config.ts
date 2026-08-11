import {
  BRADBURY_RPC_URL,
  PINNED_BRADBURY_RESOLVER,
  SUBMITTER_NETWORK,
  SUBMITTER_STAGE,
} from "./constants";
import { SubmitterProblem } from "./problem";

export type SubmitterConfig = Readonly<{
  enabled: true;
  stage: "testnet";
  network: "testnet-bradbury";
  resolver: typeof PINNED_BRADBURY_RESOLVER;
  rpcUrl: typeof BRADBURY_RPC_URL;
  privateKey: `0x${string}`;
  databaseUrl: string;
  caller: Readonly<{
    teamSlug: string;
    teamId: string;
    projectName: string;
    projectId: string;
    environment: "preview" | "production";
  }>;
}>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SubmitterConfig {
  const enabled = required(env, "XPROOF_SUBMITTER_ENABLED");
  const stage = required(env, "XPROOF_SUBMITTER_STAGE");
  const network = required(env, "XPROOF_GENLAYER_NETWORK");
  const resolver = required(env, "XPROOF_GENLAYER_RESOLVER");
  const privateKey = required(env, "GENLAYER_SUBMITTER_PRIVATE_KEY");
  const databaseUrl = required(env, "DATABASE_URL");
  const teamSlug = required(env, "XPROOF_CALLER_TEAM_SLUG");
  const teamId = required(env, "XPROOF_CALLER_TEAM_ID");
  const projectName = required(env, "XPROOF_CALLER_PROJECT_NAME");
  const projectId = required(env, "XPROOF_CALLER_PROJECT_ID");
  const environment = required(env, "XPROOF_CALLER_ENVIRONMENT");

  if (enabled !== "true") fail("XPROOF_SUBMITTER_ENABLED must be exactly true.");
  if (stage !== SUBMITTER_STAGE) fail(`XPROOF_SUBMITTER_STAGE must be ${SUBMITTER_STAGE}.`);
  if (network !== SUBMITTER_NETWORK) fail(`XPROOF_GENLAYER_NETWORK must be ${SUBMITTER_NETWORK}.`);
  if (resolver.toLowerCase() !== PINNED_BRADBURY_RESOLVER.toLowerCase()) fail("XPROOF_GENLAYER_RESOLVER must be the pinned APV2 Bradbury resolver.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey) || /^0x0{64}$/i.test(privateKey)) fail("GENLAYER_SUBMITTER_PRIVATE_KEY must be a non-zero 32-byte key.");
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) fail("DATABASE_URL must be a PostgreSQL connection URL.");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(teamSlug)) fail("XPROOF_CALLER_TEAM_SLUG is invalid.");
  if (!/^team_[A-Za-z0-9]+$/.test(teamId)) fail("XPROOF_CALLER_TEAM_ID is invalid.");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(projectName)) fail("XPROOF_CALLER_PROJECT_NAME is invalid.");
  if (!/^prj_[A-Za-z0-9]+$/.test(projectId)) fail("XPROOF_CALLER_PROJECT_ID is invalid.");
  if (environment !== "preview" && environment !== "production") fail("XPROOF_CALLER_ENVIRONMENT must be preview or production.");
  if (env.VERCEL_ENV && env.VERCEL_ENV !== environment) {
    fail("XPROOF_CALLER_ENVIRONMENT must match this submitter deployment environment.");
  }

  return Object.freeze({
    enabled: true,
    stage: SUBMITTER_STAGE,
    network: SUBMITTER_NETWORK,
    resolver: PINNED_BRADBURY_RESOLVER,
    rpcUrl: BRADBURY_RPC_URL,
    privateKey: privateKey as `0x${string}`,
    databaseUrl,
    caller: Object.freeze({ teamSlug, teamId, projectName, projectId, environment }),
  });
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) fail(`${name} is required.`);
  return value as string;
}

function fail(message: string): never {
  throw new SubmitterProblem(503, "SUBMITTER_CONFIGURATION_INVALID", message);
}
