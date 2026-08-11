import {
  ApiProblem,
  apiError,
  readSameOriginJson,
  requireString,
} from "@/lib/verification-api";
import { issueXChallenge } from "@/lib/verification-service";
import { requireWalletBoundRequest } from "@/lib/verification-route-session";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";
import {
  isAuthenticatedWalletSession,
  readWalletSession,
} from "@/lib/wallet-session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readSameOriginJson(request);
    const session = readWalletSession(request);
    await enforceVerificationRateLimit(request, "x-challenge", {
      subject: session?.subject,
      wallet:
        session && isAuthenticatedWalletSession(session)
          ? session.wallet
          : null,
      requestId:
        typeof body.requestId === "string" && body.requestId.length <= 128
          ? body.requestId
          : null,
    });
    if (!session || !isAuthenticatedWalletSession(session)) {
      throw new ApiProblem(
        401,
        "WALLET_AUTHENTICATION_REQUIRED",
        "Prove control of your wallet before creating an X challenge.",
      );
    }
    const requestId = requireString(body, "requestId", 128);
    await requireWalletBoundRequest(session, requestId);
    const issued = await issueXChallenge({
      ownerUserId: session.subject,
      requestId,
      handle: body.handle,
    });
    return Response.json(
      {
        request: issued,
        xChallenge: {
          handle: issued.handle,
          tweetText: issued.tweetText,
          issuedAt: issued.xChallengeIssuedAt,
          expiresAt: issued.xChallengeExpiresAt,
          credentialExpiresAt: issued.credentialExpiresAt,
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
