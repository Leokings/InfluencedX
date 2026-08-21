import { marketplaceMutationsEnabled } from "./verification-config.ts";
import {
  ApiProblem,
  readSameOriginJson,
} from "./verification-api.ts";
import {
  isAuthenticatedWalletSession,
  readWalletSession,
  type AuthenticatedWalletSession,
} from "./wallet-session.ts";

const marketplaceRecoveryOnlyMarker = Symbol("marketplace-recovery-only");

type MarketplaceJsonBody = Record<string, unknown> & {
  [marketplaceRecoveryOnlyMarker]?: true;
};

export function requireMarketplaceSession(
  request: Request,
): AuthenticatedWalletSession {
  const session = readWalletSession(request);
  if (!session || !isAuthenticatedWalletSession(session)) {
    throw new ApiProblem(
      401,
      "WALLET_AUTHENTICATION_REQUIRED",
      "Authenticate a wallet before performing this marketplace action.",
    );
  }
  return session;
}

export function optionalMarketplaceWallet(request: Request): string | null {
  const session = readWalletSession(request);
  return session && isAuthenticatedWalletSession(session)
    ? session.wallet
    : null;
}

export async function readMarketplaceJson(
  request: Request,
): Promise<Record<string, unknown>> {
  const body: MarketplaceJsonBody = await readSameOriginJson(request, {
    mutationsEnabled: marketplaceMutationsEnabled,
    disabledCode: "MARKETPLACE_MUTATIONS_DISABLED",
    disabledMessage:
      "Marketplace actions are not enabled in this deployment.",
  });
  if (request.headers.get("x-marketplace-recovery-only") === "1") {
    Object.defineProperty(body, marketplaceRecoveryOnlyMarker, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
  }
  return body;
}

/**
 * Returns the server-authenticated recovery mode attached by
 * {@link readMarketplaceJson}. The non-enumerable marker cannot be supplied
 * through JSON and therefore does not weaken exact request-body validation.
 */
export function marketplaceRecoveryOnly(
  body: Record<string, unknown>,
): boolean {
  return (body as MarketplaceJsonBody)[marketplaceRecoveryOnlyMarker] === true;
}
