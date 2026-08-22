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

export const MARKETPLACE_MAINTENANCE_SLOT_DURATION_MS = 5 * 60 * 1_000;

export type MarketplaceMaintenanceSlotClaim =
  | "CLAIMED"
  | "SAME_MESSAGE"
  | "CONFLICT";

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
          heartbeatMessageId: null,
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
          heartbeatMessageId: null,
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

/**
 * Claims one wall-clock maintenance slot for one concrete queue message.
 *
 * The message ID is persisted so a duplicate delivery of the same leased
 * message is retried instead of acknowledged. A different message that loses
 * the slot can be acknowledged safely: another durable message already owns
 * the heartbeat for this generation and slot.
 */
export async function claimMarketplaceMaintenanceSlot(
  input: Readonly<{
    expected: Readonly<{ deploymentId: string; generation: number }>;
    messageId: string;
    nowMs?: number;
  }>,
  dependencies: {
    context?: MarketplaceMaintenanceDeploymentContext;
    claim?: (input: Readonly<{
      context: MarketplaceMaintenanceDeploymentContext;
      expected: Readonly<{ deploymentId: string; generation: number }>;
      messageId: string;
      nowMs: number;
      slotStartMs: number;
    }>) => Promise<MarketplaceMaintenanceSlotClaim>;
  } = {},
): Promise<MarketplaceMaintenanceSlotClaim> {
  validateGenerationClock(input.expected);
  validateQueueMessageId(input.messageId);
  const nowMs = input.nowMs ?? Date.now();
  assertEpoch(nowMs);
  const context = dependencies.context ?? marketplaceMaintenanceDeploymentContext();
  validateContext(context);
  if (input.expected.deploymentId !== context.deploymentId) return "CONFLICT";
  const result = await (dependencies.claim ?? claimDatabaseMaintenanceSlot)({
    context,
    expected: input.expected,
    messageId: input.messageId,
    nowMs,
    slotStartMs: marketplaceMaintenanceSlotStartMs(nowMs),
  });
  if (!["CLAIMED", "SAME_MESSAGE", "CONFLICT"].includes(result)) {
    throw new MarketplaceMaintenanceGenerationStateError();
  }
  return result;
}

export function marketplaceMaintenanceSlotStartMs(nowMs: number): number {
  assertEpoch(nowMs);
  return (
    Math.floor(nowMs / MARKETPLACE_MAINTENANCE_SLOT_DURATION_MS) *
    MARKETPLACE_MAINTENANCE_SLOT_DURATION_MS
  );
}

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

async function claimDatabaseMaintenanceSlot(input: Readonly<{
  context: MarketplaceMaintenanceDeploymentContext;
  expected: Readonly<{ deploymentId: string; generation: number }>;
  messageId: string;
  nowMs: number;
  slotStartMs: number;
}>): Promise<MarketplaceMaintenanceSlotClaim> {
  const scope = databaseScope(input.context);
  const rows = await getDb()
    .update(marketplaceGenLayerMaintenanceGenerations)
    .set({
      heartbeatMessageId: input.messageId,
      updatedAt: sql`greatest(
        ${input.nowMs},
        ${marketplaceGenLayerMaintenanceGenerations.activatedAt} + 1
      )`,
    })
    .where(
      and(
        scopeWhere(scope),
        eq(
          marketplaceGenLayerMaintenanceGenerations.activeDeploymentId,
          input.expected.deploymentId,
        ),
        eq(
          marketplaceGenLayerMaintenanceGenerations.generation,
          input.expected.generation,
        ),
        sql`(
          ${marketplaceGenLayerMaintenanceGenerations.updatedAt} =
            ${marketplaceGenLayerMaintenanceGenerations.activatedAt}
          or ${marketplaceGenLayerMaintenanceGenerations.updatedAt} <
            ${input.slotStartMs}
        )`,
      ),
    )
    .returning({
      heartbeatMessageId:
        marketplaceGenLayerMaintenanceGenerations.heartbeatMessageId,
    });
  if (rows.length > 1) {
    throw new MarketplaceMaintenanceGenerationStateError();
  }
  if (rows.length === 1) return "CLAIMED";

  const observed = await getDb()
    .select({
      activeDeploymentId:
        marketplaceGenLayerMaintenanceGenerations.activeDeploymentId,
      generation: marketplaceGenLayerMaintenanceGenerations.generation,
      updatedAt: marketplaceGenLayerMaintenanceGenerations.updatedAt,
      heartbeatMessageId:
        marketplaceGenLayerMaintenanceGenerations.heartbeatMessageId,
    })
    .from(marketplaceGenLayerMaintenanceGenerations)
    .where(scopeWhere(scope))
    .limit(2);
  if (observed.length > 1) {
    throw new MarketplaceMaintenanceGenerationStateError();
  }
  const state = observed[0];
  if (
    state?.activeDeploymentId === input.expected.deploymentId &&
    state.generation === input.expected.generation &&
    state.updatedAt >= input.slotStartMs &&
    state.heartbeatMessageId === input.messageId
  ) {
    return "SAME_MESSAGE";
  }
  return "CONFLICT";
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

function validateQueueMessageId(messageId: string): void {
  const containsControlCharacter =
    typeof messageId === "string" &&
    Array.from(messageId).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
  if (
    typeof messageId !== "string" ||
    messageId.length === 0 ||
    messageId.length > 512 ||
    messageId.trim() !== messageId ||
    containsControlCharacter
  ) {
    throw new MarketplaceMaintenanceGenerationStateError();
  }
}

function assertEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MarketplaceMaintenanceGenerationStateError();
  }
}
