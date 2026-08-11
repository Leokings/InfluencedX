import { applicationOriginForRequest, marketplaceMutationsEnabled } from "@/lib/verification-config";
import { ApiProblem, apiError, readSameOriginJson, requireString } from "@/lib/verification-api";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";
import { buildMarketplaceWalletSignInMessage } from "@/lib/marketplace-wallet-auth";
import {
  attachWalletSessionCookie,
  createPendingWalletSession,
  isAuthenticatedWalletSession,
  normalizeSessionWallet,
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
    const wallet = normalizeSessionWallet(requireString(body, "wallet", 64));
    let session = readWalletSession(request);
    const created = !session;
    session ??= createPendingWalletSession();
    await enforceVerificationRateLimit(request, "challenge", { subject: session.subject });

    if (isAuthenticatedWalletSession(session)) {
      if (!walletSessionMatches(session, wallet)) {
        throw new ApiProblem(409, "SESSION_WALLET_MISMATCH", "This session is already bound to another wallet.");
      }
      return Response.json(
        { authenticated: true, wallet: session.wallet, message: null, expiresAt: new Date(session.expiresAt * 1_000).toISOString() },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }

    const response = Response.json(
      {
        authenticated: false,
        wallet,
        message: buildMarketplaceWalletSignInMessage({
          origin: applicationOriginForRequest(request),
          wallet,
          session,
        }),
        expiresAt: new Date(session.expiresAt * 1_000).toISOString(),
      },
      { status: created ? 201 : 200, headers: { "Cache-Control": "private, no-store" } },
    );
    return created ? attachWalletSessionCookie(response, session) : response;
  } catch (error) {
    return apiError(error);
  }
}
