import { and, eq, sql, type InferSelectModel } from "drizzle-orm";
import { getDb } from "../db/index.ts";
import { marketplaceGenLayerMaintenanceGenerations } from "../db/postgres-schema.ts";
import {
  MARKETPLACE_GENLAYER_CHAIN_ID,
  MARKETPLACE_GENLAYER_NETWORK,
  marketplaceContractAddress,
} from "./marketplace-genlayer-rpc.ts";

export type MarketplaceMaintenanceDeploymentContext = Readonly<{
  deploymentId: string;
  projectId: string;
  environment: "preview" | "production";
}>;

export type MarketplaceMaintenanceGeneration = Readonly<{
  deploymentId: string;
  generation: number;
  activatedAt: number;
  updatedAt: number;
}>;

type MaintenanceGenerationRow = InferSelectModel<
  typeof marketplaceGenLayerMaintenanceGenerations
>;

export type MarketplaceMaintenanceGenerationStore = Readonly<{
  read: (
    context: MarketplaceMaintenanceDeploymentContext,
  ) => Promise<MarketplaceMaintenanceGeneration | null>;
  insertFirst: (
    context: MarketplaceMaintenanceDeploymentContext,
    nowMs: number,
  ) => Promise<MarketplaceMaintenanceGeneration | null>;
  compareAndSwap: (
    context: MarketplaceMaintenanceDeploymentContext,
    current: MarketplaceMaintenanceGeneration,
    nowMs: number,
  ) => Promise<MarketplaceMaintenanceGeneration | null>;
}>;

const deploymentIdPattern = /^dpl_[A-Za-z0-9]{16,96}$/;
const projectIdPattern = /^prj_[A-Za-z0-9]{16,96}$/;

/**
 * Resolves a deployment identity exclusively from Vercel system variables.
 * Local processes, unsupported custom environments, and partially exposed
 * system variables cannot participate in the hosted maintenance loop.
 */
export function marketplaceMaintenanceDeploymentContext(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MarketplaceMaintenanceDeploymentContext {
  const deploymentId = environment.VERCEL_DEPLOYMENT_ID?.trim() ?? "";
  const projectId = environment.VERCEL_PROJECT_ID?.trim() ?? "";
  const vercelEnvironment = environment.VERCEL_ENV?.trim() ?? "";
  const targetEnvironment = environment.VERCEL_TARGET_ENV?.trim() ?? "";
  if (
    environment.VERCEL !== "1" ||
    !deploymentIdPattern.test(deploymentId) ||
    !projectIdPattern.test(projectId) ||
    !["preview", "production"].includes(vercelEnvironment) ||
    targetEnvironment !== vercelEnvironment
  ) {
    throw new MarketplaceMaintenanceDeploymentConfigurationError();
  }
  return Object.freeze({
    deploymentId,
    projectId,
    environment: vercelEnvironment as "preview" | "production",
  });
}

/**
 * Explicitly promotes only this function's Vercel deployment. This is called
 * only after the internal bootstrap route authenticates its request. The CAS
 * prevents two concurrent deployment activations from both succeeding.
 */
export async function promoteMarketplaceMaintenanceGeneration(
  input: { expectedGeneration: number; nowMs?: number },
  dependencies: {
    context?: MarketplaceMaintenanceDeploymentContext;
    store?: MarketplaceMaintenanceGenerationStore;
  } = {},
): Promise<
  Readonly<{
    generation: MarketplaceMaintenanceGeneration;
    promoted: boolean;
  }>
> {
  const nowMs = input.nowMs ?? Date.now();
  assertEpoch(nowMs);
  if (
    !Number.isSafeInteger(input.expectedGeneration) ||
    input.expectedGeneration < 0
  ) {
    throw new MarketplaceMaintenanceGenerationConflictError();
  }
  const context = dependencies.context ?? marketplaceMaintenanceDeploymentContext();
  validateContext(context);
  const store = dependencies.store ?? databaseMaintenanceGenerationStore;
  const current = await store.read(context);
  if ((current?.generation ?? 0) !== input.expectedGeneration) {
    throw new MarketplaceMaintenanceGenerationConflictError();
  }
  if (current?.deploymentId === context.deploymentId) {
    return Object.freeze({ generation: current, promoted: false });
  }

  const generation = current
    ? await store.compareAndSwap(context, current, nowMs)
    : await store.insertFirst(context, nowMs);
  if (!generation) {
    throw new MarketplaceMaintenanceGenerationConflictError();
  }
  validateGeneration(generation);
  if (
    generation.deploymentId !== context.deploymentId ||
    generation.generation !== (current?.generation ?? 0) + 1
  ) {
    throw new MarketplaceMaintenanceGenerationStateError();
  }
  return Object.freeze({ generation, promoted: true });
}

/** Reads the one authoritative row in this runtime-derived namespace. */
export async function readMarketplaceMaintenanceGeneration(
  dependencies: {
    context?: MarketplaceMaintenanceDeploymentContext;
    read?: MarketplaceMaintenanceGenerationStore["read"];
  } = {},
): Promise<MarketplaceMaintenanceGeneration | null> {
  const context = dependencies.context ?? marketplaceMaintenanceDeploymentContext();
  validateContext(context);
  const state = await (dependencies.read ?? readDatabaseMaintenanceGeneration)(
    context,
  );
  if (!state) return null;
  validateGeneration(state);
  return state;
}

/** Returns the DB-authorized generation only when this runtime owns it. */
export async function readCurrentMarketplaceMaintenanceGeneration(
  dependencies: {
    context?: MarketplaceMaintenanceDeploymentContext;
    read?: MarketplaceMaintenanceGenerationStore["read"];
  } = {},
): Promise<MarketplaceMaintenanceGeneration | null> {
  const context = dependencies.context ?? marketplaceMaintenanceDeploymentContext();
  const state = await readMarketplaceMaintenanceGeneration({
    context,
    read: dependencies.read,
  });
  if (!state) return null;
  return state.deploymentId === context.deploymentId ? state : null;
}

/**
 * Checks the payload's opaque clock against the authoritative row in the
 * runtime-derived namespace. Payload fields never select a project, network,
 * environment, contract, or database row.
 */
export async function marketplaceMaintenanceGenerationIsActive(
  expected: Readonly<{ deploymentId: string; generation: number }>,
  dependencies: {
    context?: MarketplaceMaintenanceDeploymentContext;
    read?: MarketplaceMaintenanceGenerationStore["read"];
  } = {},
): Promise<boolean> {
  validateGenerationClock(expected);
  const context = dependencies.context ?? marketplaceMaintenanceDeploymentContext();
  validateContext(context);
  if (expected.deploymentId !== context.deploymentId) return false;
  const state = await (dependencies.read ?? readDatabaseMaintenanceGeneration)(
    context,
  );
  if (!state) return false;
  validateGeneration(state);
  return (
    state.deploymentId === expected.deploymentId &&
    state.generation === expected.generation
  );
}

export class MarketplaceMaintenanceDeploymentConfigurationError extends Error {
  constructor() {
    super("The Vercel maintenance deployment identity is unavailable or ambiguous.");
    this.name = "MarketplaceMaintenanceDeploymentConfigurationError";
  }
}

export class MarketplaceMaintenanceGenerationConflictError extends Error {
  constructor() {
    super("Another deployment won the maintenance generation activation race.");
    this.name = "MarketplaceMaintenanceGenerationConflictError";
  }
}

export class MarketplaceMaintenanceGenerationStateError extends Error {
  constructor() {
    super("The marketplace maintenance generation state is invalid.");
    this.name = "MarketplaceMaintenanceGenerationStateError";
  }
}

const databaseMaintenanceGenerationStore: MarketplaceMaintenanceGenerationStore =
  Object.freeze({
    read: readDatabaseMaintenanceGeneration,
    async insertFirst(context, nowMs) {
      const [row] = await getDb()
        .insert(marketplaceGenLayerMaintenanceGenerations)
        .values({
          ...databaseScope(context),
          activeDeploymentId: context.deploymentId,
          generation: 1,
          activatedAt: nowMs,
          updatedAt: nowMs,
        })
        .onConflictDoNothing()
        .returning();
      return row ? generationFromRow(row) : null;
    },
    async compareAndSwap(context, current, nowMs) {
      validateGeneration(current);
      const scope = databaseScope(context);
      const [row] = await getDb()
        .update(marketplaceGenLayerMaintenanceGenerations)
        .set({
          activeDeploymentId: context.deploymentId,
          generation: sql`${marketplaceGenLayerMaintenanceGenerations.generation} + 1`,
          activatedAt: nowMs,
          updatedAt: nowMs,
        })
        .where(
          and(
            scopeWhere(scope),
            eq(
              marketplaceGenLayerMaintenanceGenerations.activeDeploymentId,
              current.deploymentId,
            ),
            eq(
              marketplaceGenLayerMaintenanceGenerations.generation,
              current.generation,
            ),
          ),
        )
        .returning();
      return row ? generationFromRow(row) : null;
    },
  });

async function readDatabaseMaintenanceGeneration(
  context: MarketplaceMaintenanceDeploymentContext,
): Promise<MarketplaceMaintenanceGeneration | null> {
  const rows = await getDb()
    .select()
    .from(marketplaceGenLayerMaintenanceGenerations)
    .where(scopeWhere(databaseScope(context)))
    .limit(2);
  if (rows.length > 1) {
    throw new MarketplaceMaintenanceGenerationStateError();
  }
  return rows[0] ? generationFromRow(rows[0]) : null;
}

function databaseScope(context: MarketplaceMaintenanceDeploymentContext) {
  return Object.freeze({
    network: MARKETPLACE_GENLAYER_NETWORK,
    chainId: MARKETPLACE_GENLAYER_CHAIN_ID,
    contractAddress: marketplaceContractAddress(),
    vercelProjectId: context.projectId,
    vercelEnvironment: context.environment,
  });
}

function scopeWhere(scope: ReturnType<typeof databaseScope>) {
  return and(
    eq(marketplaceGenLayerMaintenanceGenerations.network, scope.network),
    eq(marketplaceGenLayerMaintenanceGenerations.chainId, scope.chainId),
    eq(
      marketplaceGenLayerMaintenanceGenerations.contractAddress,
      scope.contractAddress,
    ),
    eq(
      marketplaceGenLayerMaintenanceGenerations.vercelProjectId,
      scope.vercelProjectId,
    ),
    eq(
      marketplaceGenLayerMaintenanceGenerations.vercelEnvironment,
      scope.vercelEnvironment,
    ),
  );
}

function generationFromRow(
  row: MaintenanceGenerationRow,
): MarketplaceMaintenanceGeneration {
  const generation = Object.freeze({
    deploymentId: row.activeDeploymentId,
    generation: row.generation,
    activatedAt: row.activatedAt,
    updatedAt: row.updatedAt,
  });
  validateGeneration(generation);
  return generation;
}

function validateContext(context: MarketplaceMaintenanceDeploymentContext): void {
  if (
    !deploymentIdPattern.test(context.deploymentId) ||
    !projectIdPattern.test(context.projectId) ||
    !["preview", "production"].includes(context.environment)
  ) {
    throw new MarketplaceMaintenanceDeploymentConfigurationError();
  }
}

function validateGeneration(
  generation: MarketplaceMaintenanceGeneration,
): void {
  validateGenerationClock(generation);
  assertEpoch(generation.activatedAt);
  assertEpoch(generation.updatedAt);
  if (generation.updatedAt < generation.activatedAt) {
    throw new MarketplaceMaintenanceGenerationStateError();
  }
}

function validateGenerationClock(
  generation: Readonly<{ deploymentId: string; generation: number }>,
): void {
  if (
    !deploymentIdPattern.test(generation.deploymentId) ||
    !Number.isSafeInteger(generation.generation) ||
    generation.generation <= 0
  ) {
    throw new MarketplaceMaintenanceGenerationStateError();
  }
}

function assertEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MarketplaceMaintenanceGenerationStateError();
  }
}
