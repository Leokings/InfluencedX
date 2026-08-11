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

export function readMarketplaceJson(
  request: Request,
): Promise<Record<string, unknown>> {
  return readSameOriginJson(request, {
    mutationsEnabled: marketplaceMutationsEnabled,
    disabledCode: "MARKETPLACE_MUTATIONS_DISABLED",
    disabledMessage:
      "Marketplace actions are not enabled in this deployment.",
  });
}
