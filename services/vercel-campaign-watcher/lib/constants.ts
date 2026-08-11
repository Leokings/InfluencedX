import { parseAbi } from "viem";

export const BASE_SEPOLIA_CHAIN_ID = 84_532;
export const BASE_SEPOLIA_ESCROW = "0x7e9b6b757d1ef12509889826b2f2a42906661927" as const;
export const BASE_SEPOLIA_RECEIVER = "0x15ddbcd98f97065746a1c35f88bb670a7a942264" as const;
export const BRADBURY_RESOLVER = "0x017311b35dbB9802883bDaE7Fb0Efd7Bd77cB0b2" as const;
export const RELAY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
export const MAX_REQUEST_BYTES = 32_768;
export const RESOLUTION_REQUESTED_STATUS = 4n;

export const receiverAbi = parseAbi([
  "function escrow() view returns (address)",
  "function genlayerContract() view returns (bytes32)",
  "function threshold() view returns (uint256)",
  "function isWatcher(address) view returns (bool)",
  "function usedAttestations(bytes32) view returns (bool)",
  "function paused() view returns (bool)",
]);

export const escrowAbi = parseAbi([
  "function assignments(uint256 assignmentId) view returns (uint256 campaignId, address creator, bytes32 identityHash, bytes32 agreementHash, uint256 payout, uint64 acceptedAt, uint64 submittedAt, bytes32 postIdHash, bytes32 submissionHash, bytes32 requestId, uint32 resolutionRound, uint16 feeBps, uint8 status)",
  "function campaigns(uint256 campaignId) view returns (address brand, bytes32 termsHash, uint256 deposited, uint256 allocated, uint256 disbursed, uint256 unallocatedWithdrawn, uint64 applicationDeadline, uint64 selectionDeadline, uint64 submissionDeadline, uint64 retentionSeconds)",
]);

export const campaignResolutionTypes = {
  CampaignResolution: [
    { name: "requestId", type: "bytes32" },
    { name: "assignmentId", type: "uint256" },
    { name: "outcome", type: "uint8" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "genlayerContract", type: "bytes32" },
    { name: "genlayerTxHash", type: "bytes32" },
    { name: "resolvedAt", type: "uint64" },
    { name: "relayDeadline", type: "uint64" },
  ],
} as const;
