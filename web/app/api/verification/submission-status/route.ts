import { ApiProblem, apiError } from "@/lib/verification-api";
import { requireWalletBoundRequest } from "@/lib/verification-route-session";
import { refreshOwnershipSubmissionStatus } from "@/lib/verification-service";
import {
  isAuthenticatedWalletSession,
  readWalletSession,
} from "@/lib/wallet-session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin") {
      throw new ApiProblem(
        403,
        "SAME_ORIGIN_REQUIRED",
        "Cross-site status requests are not accepted.",
      );
    }
    const session = readWalletSession(request);
    if (!session || !isAuthenticatedWalletSession(session)) {
      throw new ApiProblem(
        401,
        "WALLET_AUTHENTICATION_REQUIRED",
        "Authenticate the verification wallet first.",
      );
    }
    const requestId = new URL(request.url).searchParams.get("requestId")?.trim();
    if (!requestId || requestId.length > 128) {
      throw new ApiProblem(400, "INVALID_REQUEST", "requestId is required.");
    }
    await requireWalletBoundRequest(session, requestId);
    const current = await refreshOwnershipSubmissionStatus({
      ownerUserId: session.subject,
      requestId,
      authenticatedWallet: session.wallet,
    });
    return Response.json(
      { request: current },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
