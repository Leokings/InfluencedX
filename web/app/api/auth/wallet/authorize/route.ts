import { applicationOriginForRequest, marketplaceMutationsEnabled } from "@/lib/verification-config";
import { ApiProblem, apiError, readSameOriginJson, requireString } from "@/lib/verification-api";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";
import { verifyMarketplaceWalletSignIn } from "@/lib/marketplace-wallet-auth";
import { restoreNativeVerificationWalletSession } from "@/lib/verification-native-service";
import {
  attachWalletSessionCookie,
  authenticateWalletSession,
  isAuthenticatedWalletSession,
  readWalletSession,
  walletSessionMatches,
} from "@/lib/wallet-session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readSameOriginJson(request, {
      mutationsEnabled: marketplaceMutationsEnabled,
      disabledCode: "MARKETPLACE_MUTATIONS_DISABLED",
      disabledMessage: "Marketplace wallet sign-in is not enabled in this deployment.",
    });
    const session = readWalletSession(request);
    await enforceVerificationRateLimit(request, "authorize", { subject: session?.subject });
    if (!session) {
      throw new ApiProblem(401, "AUTHENTICATION_REQUIRED", "Start a wallet sign-in request first.");
    }
    const wallet = requireString(body, "wallet", 64);
    if (isAuthenticatedWalletSession(session)) {
      if (!walletSessionMatches(session, wallet)) {
        throw new ApiProblem(409, "SESSION_WALLET_MISMATCH", "This session is already bound to another wallet.");
      }
      return Response.json(
        { authenticated: true, wallet: session.wallet, expiresAt: new Date(session.expiresAt * 1_000).toISOString() },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }

    const verifiedWallet = await verifyMarketplaceWalletSignIn({
      origin: applicationOriginForRequest(request),
      wallet,
      signature: body.signature,
      session,
    });
    // Only a freshly verified signature can recover a previous run's subject.
    const authenticated = await restoreNativeVerificationWalletSession(
      authenticateWalletSession(session, verifiedWallet),
    );
    return attachWalletSessionCookie(
      Response.json(
        { authenticated: true, wallet: authenticated.wallet, expiresAt: new Date(authenticated.expiresAt * 1_000).toISOString() },
        { headers: { "Cache-Control": "private, no-store" } },
      ),
      authenticated,
    );
  } catch (error) {
    return apiError(error);
  }
}
