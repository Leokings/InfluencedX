import {
  normalizeMarketplaceAddress,
  parseProfileState,
  type GenLayerContentSource,
  type GenLayerProfileState,
} from "./marketplace-genlayer-core.ts";
import { findGenLayerProfileByWallet } from "./marketplace-genlayer-repository.ts";
import {
  marketplaceCalldataAddress,
  readMarketplaceState,
} from "./marketplace-genlayer-rpc.ts";
import { ApiProblem } from "./verification-api.ts";

export type PublicGenLayerIdentityDto = Readonly<{
  source: GenLayerContentSource;
  handle: string;
  externalUserId: string;
  identityHash: string;
  ownershipRequestId: string;
  activationTxHash: string | null;
  active: boolean;
  verifiedAt: string;
  credentialExpiresAt: string;
}>;

export type PublicGenLayerCreatorDto = Readonly<{
  ownerWallet: string;
  activeSources: GenLayerContentSource[];
  x: PublicGenLayerIdentityDto | null;
  farcaster: PublicGenLayerIdentityDto | null;
  displayName: string | null;
  bio: string | null;
  categories: string[];
  metrics: null;
}>;

export async function getPublicGenLayerCreatorProfile(input: {
  wallet: string;
}): Promise<PublicGenLayerCreatorDto> {
  const wallet = normalizeMarketplaceAddress(input.wallet, "wallet");
  const raw = await readMarketplaceState("get_profile", [marketplaceCalldataAddress(wallet)]);
  if (!plain(raw) || normalizeMarketplaceAddress(raw.wallet, "profile.wallet") !== wallet) {
    throw invalidState();
  }
  const [x, farcaster] = await Promise.all([
    identityDto(raw.x, wallet, "X"),
    identityDto(raw.farcaster, wallet, "FARCASTER"),
  ]);
  const activeSources = [x, farcaster]
    .filter((identity): identity is PublicGenLayerIdentityDto => identity?.active === true)
    .map((identity) => identity.source);
  if (activeSources.length === 0) {
    throw new ApiProblem(404, "CREATOR_NOT_FOUND", "No active GenLayer creator identity was found.");
  }
  const [xProjection, farcasterProjection] = await Promise.all([
    findGenLayerProfileByWallet(wallet, "X"),
    findGenLayerProfileByWallet(wallet, "FARCASTER"),
  ]);
  const metadata = xProjection ?? farcasterProjection;
  return Object.freeze({
    ownerWallet: wallet,
    activeSources,
    x: withActivationTx(x, xProjection?.activationTxHash ?? null),
    farcaster: withActivationTx(farcaster, farcasterProjection?.activationTxHash ?? null),
    displayName: metadata?.displayName ?? null,
    bio: metadata?.bio ?? null,
    categories: metadata?.categories ?? [],
    // No inferred follower/pay/risk numbers: metrics remain absent until a
    // source-verifiable metrics pipeline is deployed.
    metrics: null,
  });
}

async function identityDto(
  raw: unknown,
  wallet: string,
  source: GenLayerContentSource,
): Promise<PublicGenLayerIdentityDto | null> {
  if (!plain(raw)) throw invalidState();
  if (raw.exists === false) {
    if (
      normalizeMarketplaceAddress(raw.wallet, "identity.wallet") !== wallet ||
      raw.source !== source ||
      raw.active !== false
    ) throw invalidState();
    return null;
  }
  const state = parseProfileState(raw);
  if (state.wallet !== wallet || state.source !== source) throw invalidState();
  return stateDto(state, null);
}

function stateDto(
  state: GenLayerProfileState,
  activationTxHash: string | null,
): PublicGenLayerIdentityDto {
  return Object.freeze({
    source: state.source,
    handle: state.handle,
    externalUserId: state.externalUserId,
    identityHash: state.identityHash,
    ownershipRequestId: state.ownershipRequestId,
    activationTxHash,
    active: state.active,
    verifiedAt: new Date(state.verifiedAtEpoch * 1_000).toISOString(),
    credentialExpiresAt: new Date(state.expiresAtEpoch * 1_000).toISOString(),
  });
}

function withActivationTx(
  identity: PublicGenLayerIdentityDto | null,
  activationTxHash: string | null,
): PublicGenLayerIdentityDto | null {
  return identity ? Object.freeze({ ...identity, activationTxHash }) : null;
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidState(): Error {
  return new ApiProblem(
    503,
    "GENLAYER_PROFILE_STATE_INVALID",
    "The StudioNet creator profile could not be verified.",
  );
}
