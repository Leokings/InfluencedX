import {
  ApiProblem,
  apiError,
  readSameOriginJson,
  requireString,
} from "@/lib/verification-api";
import {
  authorizeWallet,
  getVerificationStatus,
} from "@/lib/verification-service";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";
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
    const body = await readSameOriginJson(request);
    const session = readWalletSession(request);
    await enforceVerificationRateLimit(request, "authorize", {
      subject: session?.subject,
    });
    if (!session) {
      throw new ApiProblem(
        401,
        "AUTHENTICATION_REQUIRED",
        "Start a wallet verification before authorizing it.",
      );
    }
    const requestId = requireString(body, "requestId", 128);
    if (isAuthenticatedWalletSession(session)) {
      const current = await getVerificationStatus({
        ownerUserId: session.subject,
        requestId,
      });
      if (current && !walletSessionMatches(session, current.wallet)) {
        throw new ApiProblem(
          409,
          "SESSION_WALLET_MISMATCH",
          "This session is already bound to another wallet.",
        );
      }
    }

    const verified = await authorizeWallet({
      ownerUserId: session.subject,
      requestId,
      signature: requireString(body, "signature", 1_000),
    });
    const authenticatedSession = authenticateWalletSession(
      session,
      verified.wallet,
    );
    const response = Response.json(
      { request: verified },
      { headers: { "Cache-Control": "private, no-store" } },
    );
    return attachWalletSessionCookie(response, authenticatedSession);
  } catch (error) {
    return apiError(error);
  }
}
