import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  BASE_SEPOLIA_CHAIN_ID,
  INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT,
  marketplaceCreatorRegistryAbi,
} from "./marketplace-chain.ts";
import type { CreatorProfileRow } from "./marketplace-repository.ts";

export type MarketplaceMetricsBindingClient = {
  getChainId(): Promise<number>;
  readContract(input: {
    address: Address;
    abi: typeof marketplaceCreatorRegistryAbi;
    functionName: "getProfile";
    args: readonly [Address];
  }): Promise<unknown>;
};

export type VerifiedMetricsProfileBinding = Readonly<{
  wallet: Address;
  identityHash: Hex;
  expectedHandle: string;
  credentialExpiresAtEpoch: number;
}>;

/** Re-reads the pinned Base registry immediately before any metrics job. */
export async function readVerifiedMetricsProfileBinding(input: {
  profile: CreatorProfileRow;
  nowEpoch?: number;
  client?: MarketplaceMetricsBindingClient;
}): Promise<VerifiedMetricsProfileBinding> {
  const nowEpoch = input.nowEpoch ?? Math.floor(Date.now() / 1_000);
  invariant(Number.isSafeInteger(nowEpoch) && nowEpoch > 0, "Metrics clock is invalid.");
  const profile = input.profile;
  const wallet = canonicalAddress(profile.ownerWallet, "profile wallet");
  const identityHash = bytes32(profile.identityHash, "profile identity hash");
  const handleHash = bytes32(profile.handleHash, "profile handle hash");
  const verificationPostHash = bytes32(
    profile.verificationPostHash,
    "profile verification post hash",
  );
  const expectedHandle = canonicalHandle(profile.publicHandle);
  const credentialExpiresAtEpoch = exactEpochSeconds(
    profile.credentialExpiresAt,
    "profile credential expiry",
  );
  invariant(profile.active, "The verified creator profile is inactive.");
  invariant(
    credentialExpiresAtEpoch > nowEpoch,
    "The verified creator profile has expired.",
  );

  const client = input.client ?? createMarketplaceMetricsBindingClient();
  invariant(
    (await client.getChainId()) === BASE_SEPOLIA_CHAIN_ID,
    "Base RPC chain mismatch.",
  );
  const raw = await client.readContract({
    address: INFLUENCEDX_BASE_SEPOLIA_DEPLOYMENT.registry,
    abi: marketplaceCreatorRegistryAbi,
    functionName: "getProfile",
    args: [wallet],
  });
  const onchain = profileTuple(raw);
  invariant(
    positiveUint(onchain.profileId, "onchain profile ID").toString() ===
      profile.baseProfileId,
    "Base profile ID mismatch.",
  );
  invariant(
    canonicalAddress(onchain.wallet, "onchain profile wallet") === wallet,
    "Base profile wallet mismatch.",
  );
  invariant(
    bytes32(onchain.identityHash, "onchain identity hash") === identityHash,
    "Base profile identity mismatch.",
  );
  invariant(
    bytes32(onchain.handleHash, "onchain handle hash") === handleHash,
    "Base profile handle mismatch.",
  );
  invariant(
    bytes32(onchain.verificationPostHash, "onchain verification post hash") ===
      verificationPostHash,
    "Base verification post mismatch.",
  );
  invariant(onchain.active === true, "The Base creator profile is inactive.");
  invariant(
    positiveUint(onchain.expiresAt, "onchain profile expiry") ===
      BigInt(credentialExpiresAtEpoch),
    "Base profile expiry mismatch.",
  );
  invariant(
    credentialExpiresAtEpoch > nowEpoch,
    "The Base creator profile has expired.",
  );

  return Object.freeze({
    wallet,
    identityHash,
    expectedHandle,
    credentialExpiresAtEpoch,
  });
}

function createMarketplaceMetricsBindingClient(): MarketplaceMetricsBindingClient {
  const value =
    process.env.XPROOF_BASE_SEPOLIA_RPC_URL?.trim() ??
    "https://sepolia.base.org";
  let rpc: URL;
  try {
    rpc = new URL(value);
  } catch {
    throw new Error("XPROOF_BASE_SEPOLIA_RPC_URL is invalid.");
  }
  if (
    rpc.protocol !== "https:" ||
    rpc.username ||
    rpc.password ||
    rpc.search ||
    rpc.hash
  ) {
    throw new Error("XPROOF_BASE_SEPOLIA_RPC_URL must be a clean HTTPS URL.");
  }
  return createPublicClient({
    chain: baseSepolia,
    transport: http(rpc.toString(), { timeout: 12_000, retryCount: 1 }),
  }) as unknown as MarketplaceMetricsBindingClient;
}

function profileTuple(value: unknown): Record<
  | "profileId"
  | "wallet"
  | "identityHash"
  | "handleHash"
  | "verificationPostHash"
  | "expiresAt"
  | "active",
  unknown
> {
  if (Array.isArray(value) && value.length >= 11) {
    return {
      profileId: value[0],
      wallet: value[1],
      identityHash: value[2],
      handleHash: value[3],
      verificationPostHash: value[4],
      expiresAt: value[7],
      active: value[10],
    };
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    return {
      profileId: item.profileId,
      wallet: item.wallet,
      identityHash: item.identityHash,
      handleHash: item.handleHash,
      verificationPostHash: item.verificationPostHash,
      expiresAt: item.expiresAt,
      active: item.active,
    };
  }
  throw new Error("Base creator profile response is invalid.");
}

function canonicalAddress(value: unknown, label: string): Address {
  invariant(
    typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value),
    `${label} is invalid.`,
  );
  return getAddress(value).toLowerCase() as Address;
}

function bytes32(value: unknown, label: string): Hex {
  invariant(
    typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value),
    `${label} is invalid.`,
  );
  return value.toLowerCase() as Hex;
}

function canonicalHandle(value: unknown): string {
  invariant(
    typeof value === "string" && /^[a-z0-9_]{1,15}$/.test(value),
    "The verified profile has no canonical public X handle.",
  );
  return value;
}

function positiveUint(value: unknown, label: string): bigint {
  let parsed: bigint;
  try {
    parsed =
      typeof value === "bigint"
        ? value
        : typeof value === "number" && Number.isSafeInteger(value)
          ? BigInt(value)
          : typeof value === "string" && /^[1-9][0-9]*$/.test(value)
            ? BigInt(value)
            : 0n;
  } catch {
    parsed = 0n;
  }
  invariant(parsed > 0n, `${label} is invalid.`);
  return parsed;
}

function exactEpochSeconds(value: unknown, label: string): number {
  invariant(
    Number.isSafeInteger(value) && Number(value) > 0 && Number(value) % 1_000 === 0,
    `${label} is invalid.`,
  );
  return Number(value) / 1_000;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
