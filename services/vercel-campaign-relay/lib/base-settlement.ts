import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import type { RelayConfig } from "./config.js";
import {
  BASE_SEPOLIA_CHAIN_ID,
  escrowAbi,
  receiverAbi,
} from "./constants.js";
import { RelayProblem } from "./problem.js";
import type { VerifiedQuorum } from "./quorum.js";
import type { ResolutionOutcome } from "./types.js";

export type PreparedSettlement = Readonly<{
  request: Record<string, unknown>;
  account: Address;
  requestId: Hex;
  assignmentId: bigint;
  outcome: ResolutionOutcome;
  evidenceHash: Hex;
}>;

export interface BaseSettlementTransport {
  simulate(quorum: VerifiedQuorum, outcome: ResolutionOutcome): Promise<PreparedSettlement>;
  broadcast(prepared: PreparedSettlement): Promise<Hex>;
  waitAndVerify(prepared: PreparedSettlement, txHash: Hex): Promise<Readonly<{ blockNumber: string }>>;
}

export function createBaseSettlementTransport(config: RelayConfig): BaseSettlementTransport {
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(config.baseRpcUrl, { timeout: 15_000, retryCount: 1 }) });
  return Object.freeze({
    async simulate(quorum: VerifiedQuorum, outcome: ResolutionOutcome) {
      if (!config.relayerAddress) throw new RelayProblem(503, "RELAY_CONFIGURATION_INVALID", "A dedicated relayer address is required for simulation.");
      if (await publicClient.getChainId() !== BASE_SEPOLIA_CHAIN_ID) binding("Base RPC is not Base Sepolia.");
      const [used, paused, balance] = await Promise.all([
        publicClient.readContract({ address: config.receiver, abi: receiverAbi, functionName: "usedAttestations", args: [quorum.message.requestId] }),
        publicClient.readContract({ address: config.receiver, abi: receiverAbi, functionName: "paused" }),
        publicClient.getBalance({ address: config.relayerAddress }),
      ]);
      if (used) throw new RelayProblem(409, "REQUEST_ALREADY_USED", "The Base receiver already consumed this request.");
      if (paused) binding("The Base receiver is paused.");
      if (balance > config.relayerMaxBalanceWei) throw new RelayProblem(503, "RELAYER_BALANCE_POLICY", "The dedicated relayer exceeds its low-balance policy.");
      const args = [{
        requestId: quorum.message.requestId,
        assignmentId: BigInt(quorum.message.assignmentId),
        outcome: quorum.message.outcome,
        evidenceHash: quorum.message.evidenceHash,
        genlayerContract: quorum.message.genlayerContract,
        genlayerTxHash: quorum.message.genlayerTxHash,
        resolvedAt: BigInt(quorum.message.resolvedAt),
        relayDeadline: BigInt(quorum.message.relayDeadline),
      }, quorum.signatures] as const;
      let simulation;
      try {
        simulation = await publicClient.simulateContract({
          account: config.relayerAddress,
          address: config.receiver,
          abi: receiverAbi,
          functionName: "submitCampaignResolution",
          args,
        });
      } catch { throw new RelayProblem(409, "BASE_SIMULATION_REJECTED", "Base rejected the exact campaign settlement simulation."); }
      return Object.freeze({
        request: simulation.request as unknown as Record<string, unknown>,
        account: config.relayerAddress,
        requestId: quorum.message.requestId,
        assignmentId: BigInt(quorum.message.assignmentId),
        outcome,
        evidenceHash: quorum.message.evidenceHash,
      });
    },
    async broadcast(prepared: PreparedSettlement) {
      if (!config.broadcastEnabled || !config.relayerPrivateKey || !config.relayerAddress) throw new RelayProblem(503, "BROADCAST_DISABLED", "Automatic Base broadcast is disabled.");
      const account = privateKeyToAccount(config.relayerPrivateKey);
      if (getAddress(account.address) !== prepared.account) throw new RelayProblem(503, "RELAY_CONFIGURATION_INVALID", "The relayer signer changed after simulation.");
      const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(config.baseRpcUrl, { timeout: 15_000, retryCount: 0 }) });
      return await wallet.writeContract({ ...prepared.request, account } as Parameters<typeof wallet.writeContract>[0]);
    },
    async waitAndVerify(prepared: PreparedSettlement, txHash: Hex) {
      let receipt;
      try { receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1, timeout: 60_000 }); }
      catch { throw new RelayProblem(409, "RECEIPT_RECONCILIATION_REQUIRED", "Base broadcast receipt is not yet confirmed."); }
      if (receipt.status !== "success") throw new RelayProblem(409, "BASE_TRANSACTION_REVERTED", "The Base settlement transaction reverted.");
      let receiverEvents = 0;
      let escrowEvents = 0;
      for (const log of receipt.logs) {
        try {
          if (getAddress(log.address) === getAddress(config.receiver)) {
            const decoded = decodeEventLog({ abi: receiverAbi, data: log.data, topics: log.topics });
            if (decoded.eventName === "CampaignResolutionRelayed") {
              const args = decoded.args as { requestId: Hex; assignmentId: bigint; outcome: number; evidenceHash: Hex };
              if (args.requestId !== prepared.requestId || args.assignmentId !== prepared.assignmentId || args.outcome !== outcomeNumber(prepared.outcome) || args.evidenceHash !== prepared.evidenceHash) binding("Receiver settlement event mismatch.");
              receiverEvents += 1;
            }
          } else if (getAddress(log.address) === getAddress(config.escrow)) {
            const decoded = decodeEventLog({ abi: escrowAbi, data: log.data, topics: log.topics });
            if (decoded.eventName === "AssignmentSettled") {
              const args = decoded.args as { assignmentId: bigint; requestId: Hex; outcome: number; evidenceHash: Hex };
              if (args.requestId !== prepared.requestId || args.assignmentId !== prepared.assignmentId || args.outcome !== outcomeNumber(prepared.outcome) || args.evidenceHash !== prepared.evidenceHash) binding("Escrow settlement event mismatch.");
              escrowEvents += 1;
            }
          }
        } catch (error) {
          if (error instanceof RelayProblem) throw error;
        }
      }
      if (receiverEvents !== 1 || escrowEvents !== 1) binding("Settlement receipt must contain exactly one receiver and escrow event.");
      const [used, assignmentValue] = await Promise.all([
        publicClient.readContract({ address: config.receiver, abi: receiverAbi, functionName: "usedAttestations", args: [prepared.requestId] }),
        publicClient.readContract({ address: config.escrow, abi: escrowAbi, functionName: "assignments", args: [prepared.assignmentId] }),
      ]);
      if (used !== true || !Array.isArray(assignmentValue) || BigInt(String(assignmentValue[12])) !== expectedStatus(prepared.outcome)) binding("Post-settlement Base state does not match the receipt.");
      return Object.freeze({ blockNumber: receipt.blockNumber.toString() });
    },
  });
}

function outcomeNumber(outcome: ResolutionOutcome): number { return outcome === "PASS" ? 1 : outcome === "FAIL" ? 2 : 3; }
function expectedStatus(outcome: ResolutionOutcome): bigint { return outcome === "PASS" ? 6n : outcome === "FAIL" ? 7n : 5n; }
function binding(message: string): never { throw new RelayProblem(409, "BASE_SETTLEMENT_REJECTED", message); }
