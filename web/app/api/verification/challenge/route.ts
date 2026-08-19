import {
  ApiProblem,
  assertExactJsonKeys,
  apiError,
  readSameOriginJson,
  requireString,
} from "@/lib/verification-api";
import { createNativeVerificationRequest } from "@/lib/verification-native-service";
import { applicationOriginForRequest } from "@/lib/verification-config";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";
import {
  attachWalletSessionCookie,
  createPendingWalletSession,
  isAuthenticatedWalletSession,
  readWalletSession,
  walletSessionMatches,
} from "@/lib/wallet-session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readSameOriginJson(request);
    assertExactJsonKeys(body, ["wallet"]);
    const wallet = requireString(body, "wallet", 64);
    let session = readWalletSession(request);
    const createdPendingSession = !session;
    session ??= createPendingWalletSession();
    await enforceVerificationRateLimit(request, "challenge", {
      subject: session.subject,
    });
    if (
      isAuthenticatedWalletSession(session) &&
      !walletSessionMatches(session, wallet)
    ) {
      throw new ApiProblem(
        409,
        "SESSION_WALLET_MISMATCH",
        "This session is already bound to another wallet.",
      );
    }

    const created = await createNativeVerificationRequest({
      ownerUserId: session.subject,
      wallet,
      origin: applicationOriginForRequest(request),
    });
    const response = Response.json(
      {
        request: created.request,
        walletChallenge: created.message
          ? {
              message: created.message,
              expiresAt: created.request.walletChallengeExpiresAt,
            }
          : null,
      },
      { status: 201, headers: { "Cache-Control": "private, no-store" } },
    );
    return createdPendingSession
      ? attachWalletSessionCookie(response, session)
      : response;
  } catch (error) {
    return apiError(error);
  }
}
