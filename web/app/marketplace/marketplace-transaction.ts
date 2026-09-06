import type { MarketplaceTransactionDto } from "../../lib/marketplace-types.ts";
import {
  STUDIONET_CHAIN_ID,
  STUDIONET_CHAIN_ID_HEX,
  STUDIONET_MARKETPLACE_ADDRESS,
} from "./marketplace-types.ts";

type GenLayerTransactionPlan = Readonly<{
  network: "studionet";
  chainId: 61_999;
  contractAddress: string;
  functionName: string;
  args: unknown[];
  argTypes: Array<"string" | "bool" | "u256" | "uint256" | "address">;
  value: string;
}>;

type PlanArgType = GenLayerTransactionPlan["argTypes"][number];

const USER_MARKETPLACE_CALLS: Readonly<Record<string, readonly PlanArgType[]>> = {
  activate_identity_bundle: [
    "string", "string", "string", "string", "string", "u256", "u256", "u256",
    "string", "string", "u256", "string", "string", "u256", "u256", "u256",
  ],
  create_campaign: [
    "string", "string", "string", "string", "string", "string", "string", "bool",
    "u256", "u256", "u256", "u256", "u256", "u256",
  ],
  apply_to_campaign: ["string", "string", "u256", "string"],
  withdraw_application: ["string"],
  select_creator: ["string", "string", "address", "u256", "string"],
  accept_assignment: ["string"],
  decline_assignment: ["string"],
  submit_evidence: ["string", "string", "string", "string"],
  resolve_assignment: ["string", "string"],
  expire_assignment: ["string"],
  refund_undetermined: ["string"],
  refund_unallocated: ["string"],
  cancel_campaign: ["string"],
  finalize_campaign: ["string"],
  request_withdrawal: ["string", "u256"],
  execute_withdrawal: ["string"],
} as const satisfies Readonly<Record<string, readonly PlanArgType[]>>;

export type UserMarketplaceFunctionName = keyof typeof USER_MARKETPLACE_CALLS;

export type GenLayerTransactionStage = "wallet" | "submitted" | "finality" | "finalized";

const TERMINAL_MARKETPLACE_TRANSACTION_CODES = new Set([
  "GENLAYER_EXECUTION_FAILED",
  "GENLAYER_TRANSACTION_TERMINATED",
]);

export function isExplicitEip1193UserRejection(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "number"
    && error.code === 4_001;
}

export function isTerminalMarketplaceTransactionError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    && TERMINAL_MARKETPLACE_TRANSACTION_CODES.has(error.code);
}

export async function broadcastMarketplaceTransaction(
  transaction: MarketplaceTransactionDto,
  actor: string,
  options: Readonly<{
    expectedFunctionName: UserMarketplaceFunctionName;
    expectedValue: string;
    onSubmitted?: (hash: `0x${string}`) => void | Promise<void>;
    beforeWalletRequest?: () => void;
    onStage?: (stage: GenLayerTransactionStage) => void;
  }>,
): Promise<`0x${string}`> {
  const plan: GenLayerTransactionPlan = transaction;
  validatePlan(plan, STUDIONET_MARKETPLACE_ADDRESS, options.expectedFunctionName, options.expectedValue);
  if (!/^0x[\da-f]{40}$/i.test(actor)) throw new Error("The transaction actor is invalid.");
  const provider = window.ethereum;
  if (!provider) throw new Error("No browser wallet is available.");

  const [{ createClient }, { studionet }, types] = await Promise.all([
    import("genlayer-js"),
    import("genlayer-js/chains"),
    import("genlayer-js/types"),
  ]);
  const account = actor.toLowerCase() as `0x${string}`;
  const [providerAccounts, providerChainId] = await Promise.all([
    provider.request({ method: "eth_accounts" }),
    provider.request({ method: "eth_chainId" }),
  ]);
  assertMarketplaceWalletContext(providerAccounts, providerChainId, account);

  const readClient = createClient({ chain: studionet });
  const writeClient = createClient({
    chain: studionet,
    account,
    provider: provider as never,
  });
  const contractAddress = plan.contractAddress as `0x${string}`;
  const value = BigInt(plan.value);

  options.onStage?.("wallet");
  options.beforeWalletRequest?.();
  const hash = await writeClient.writeContract({
    address: contractAddress,
    functionName: plan.functionName,
    args: hydrateArgs(plan.args, plan.argTypes, types.CalldataAddress) as never[],
    value,
  }) as `0x${string}`;
  if (!/^0x[\da-f]{64}$/i.test(hash)) throw new Error("StudioNet returned an invalid transaction hash.");
  await options.onSubmitted?.(hash);
  options.onStage?.("submitted");
  options.onStage?.("finality");

  const receipt = await readClient.waitForTransactionReceipt({
    hash: hash as never,
    status: types.TransactionStatus.FINALIZED,
    interval: 3_000,
    retries: 120,
  });
  // The backend owns execution-result validation and durable terminal
  // classification. Reaching consensus finality here lets the exact submitted
  // hash continue to confirmation even when the contract intentionally rolls
  // back, so the journal cannot remain stuck in recovery forever.
  assertMarketplaceTransactionConsensusFinality(receipt);
  if (plan.functionName === "resolve_assignment") {
    let triggered: readonly `0x${string}`[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      triggered = await readClient.getTriggeredTransactionIds({ hash: hash as never });
      if (triggered.length === 2) break;
      await new Promise((resolve) => window.setTimeout(resolve, 3_000));
    }
    if (triggered.length !== 2) {
      throw new Error("The finalized resolution did not emit its execution and fallback transactions.");
    }
    const fallbackReceipt = await readClient.waitForTransactionReceipt({
      hash: triggered[1] as never,
      status: types.TransactionStatus.FINALIZED,
      interval: 3_000,
      retries: 120,
    });
    assertMarketplaceTransactionFinality(fallbackReceipt);
  }
  options.onStage?.("finalized");
  return hash;
}

export function validatePlan(
  plan: GenLayerTransactionPlan,
  expectedContractAddress: string = STUDIONET_MARKETPLACE_ADDRESS,
  expectedFunctionName?: UserMarketplaceFunctionName,
  expectedValue?: string,
): void {
  if (plan.network !== "studionet" || plan.chainId !== STUDIONET_CHAIN_ID) {
    throw new Error("The prepared transaction is not for GenLayer StudioNet.");
  }
  if (!/^0x[\da-f]{40}$/i.test(plan.contractAddress)) {
    throw new Error("The prepared GenLayer contract address is invalid.");
  }
  if (!expectedContractAddress || !/^0x[\da-f]{40}$/i.test(expectedContractAddress)) {
    throw new Error("The InfluencedX GenLayer contract address is not configured.");
  }
  if (plan.contractAddress.toLowerCase() !== expectedContractAddress.toLowerCase()) {
    throw new Error("The prepared transaction targets an unauthorized GenLayer contract.");
  }
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(plan.functionName)) {
    throw new Error("The prepared GenLayer contract method is invalid.");
  }
  if (!Array.isArray(plan.args) || !Array.isArray(plan.argTypes) || plan.args.length !== plan.argTypes.length) {
    throw new Error("The prepared GenLayer arguments are invalid.");
  }
  if (!/^\d+$/.test(plan.value)) throw new Error("The prepared GEN value is invalid.");
  const expectedTypes = (USER_MARKETPLACE_CALLS as Readonly<Record<string, readonly PlanArgType[]>>)[plan.functionName];
  if (!expectedTypes || !sameArgTypes(plan.argTypes, expectedTypes)) {
    throw new Error("The prepared GenLayer method or argument schema is not authorized.");
  }
  if (expectedFunctionName !== undefined && plan.functionName !== expectedFunctionName) {
    throw new Error(`The prepared GenLayer method does not match the expected ${expectedFunctionName} action.`);
  }
  if (expectedValue !== undefined && plan.value !== expectedValue) {
    throw new Error("The prepared GEN value does not match the expected marketplace action.");
  }
  if (plan.functionName === "create_campaign") {
    const budget = plan.args.at(-1);
    if (typeof budget !== "string" || budget === "0" || budget !== plan.value) {
      throw new Error("The campaign GEN value does not match its exact committed budget.");
    }
  } else if (plan.value !== "0") {
    throw new Error("This InfluencedX action must not transfer GEN.");
  }
}

function sameArgTypes(actual: readonly PlanArgType[], expected: readonly PlanArgType[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => (
    normalizeArgType(value) === normalizeArgType(expected[index])
  ));
}

function normalizeArgType(value: PlanArgType): PlanArgType {
  return value === "uint256" ? "u256" : value;
}

export function hydrateArgs(
  args: unknown[],
  argTypes: GenLayerTransactionPlan["argTypes"],
  Address: new (value: Uint8Array) => unknown,
): unknown[] {
  if (args.length !== argTypes.length) throw new Error("The prepared GenLayer argument schema is invalid.");
  return args.map((value, index) => {
    const type = argTypes[index];
    if (type === "u256" || type === "uint256") {
      if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value)) {
        throw new Error(`Prepared argument ${index} is not a valid uint256.`);
      }
      const number = BigInt(value);
      if (number >= 1n << 256n) throw new Error(`Prepared argument ${index} exceeds uint256.`);
      return number;
    }
    if (type === "address") {
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw new Error(`Prepared argument ${index} is not a valid address.`);
      }
      const bytes = Uint8Array.from(
        value.slice(2).match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)),
      );
      return new Address(bytes);
    }
    if (type === "bool") {
      if (typeof value !== "boolean") throw new Error(`Prepared argument ${index} is not boolean.`);
      return value;
    }
    if (type === "string") {
      if (typeof value !== "string") throw new Error(`Prepared argument ${index} is not a string.`);
      return value;
    }
    throw new Error(`Prepared argument ${index} has an unsupported type.`);
  });
}

export function assertMarketplaceWalletContext(
  providerAccounts: unknown,
  providerChainId: unknown,
  actor: string,
): void {
  const selected = Array.isArray(providerAccounts) && typeof providerAccounts[0] === "string"
    ? providerAccounts[0].toLowerCase()
    : null;
  if (selected !== actor.toLowerCase()) {
    throw new Error("The active wallet account no longer matches the authenticated marketplace session.");
  }
  if (typeof providerChainId !== "string" || providerChainId.toLowerCase() !== STUDIONET_CHAIN_ID_HEX) {
    throw new Error("Switch the active wallet to GenLayer StudioNet before signing.");
  }
}

export function assertMarketplaceTransactionFinality(
  receipt: unknown,
  successfulExecutionName = "FINISHED_WITH_RETURN",
): void {
  assertMarketplaceTransactionConsensusFinality(receipt);
  const record = asRecord(receipt);

  // genlayer-js 1.1.x simplifies StudioNet receipts into the RPC's snake_case
  // shape. The authoritative execution result lives in the leader receipt;
  // older/local clients may still expose txExecutionResultName at the top level.
  const topLevelExecution = record.txExecutionResultName ?? record.tx_execution_result_name;
  if (
    topLevelExecution !== undefined
    && topLevelExecution !== successfulExecutionName
    && topLevelExecution !== "SUCCESS"
  ) {
    throw new Error("The StudioNet transaction finalized without a successful contract return.");
  }

  const consensus = asRecord(record.consensus_data ?? record.consensusData);
  const rawLeaderReceipts = consensus.leader_receipt ?? consensus.leaderReceipt;
  const leaderReceipts = Array.isArray(rawLeaderReceipts)
    ? rawLeaderReceipts
    : rawLeaderReceipts === undefined
      ? []
      : [rawLeaderReceipts];
  const leaders = leaderReceipts.filter((value) => asRecord(value).mode === "leader");
  const leaderSucceeded = leaders.length === 1 && leaders.every((value) => {
    const leader = asRecord(value);
    const execution = leader.execution_result ?? leader.executionResult;
    const result = asRecord(leader.result);
    const resultStatus = result.status;
    return execution === "SUCCESS" && resultStatus === "return";
  });
  if (!leaderSucceeded) {
    throw new Error("The StudioNet transaction finalized without a successful contract return.");
  }
}

export function assertMarketplaceTransactionConsensusFinality(receipt: unknown): void {
  const record = asRecord(receipt);
  const status = record.status_name ?? record.statusName;
  if (status !== "FINALIZED") {
    throw new Error("The StudioNet transaction did not reach validator finality.");
  }
  const consensusResult = record.result_name ?? record.resultName;
  if (consensusResult !== "MAJORITY_AGREE") {
    throw new Error("The StudioNet transaction did not finalize with majority agreement.");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
