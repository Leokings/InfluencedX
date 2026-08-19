import { ApiProblem, apiError } from "@/lib/verification-api";
import { getGenLayerVerificationStatus } from "@/lib/marketplace-genlayer-activation";
import {
  isAuthenticatedWalletSession,
  readWalletSession,
  walletSessionMatches,
} from "@/lib/wallet-session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = readWalletSession(request);
    if (!session) {
      return Response.json(
        { request: null },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }
    const requestId = new URL(request.url).searchParams.get("requestId")?.trim();
    if (requestId && requestId.length > 128) {
      throw new ApiProblem(400, "INVALID_REQUEST", "requestId is invalid.");
    }
    const current = await getGenLayerVerificationStatus({
      ownerUserId: session.subject,
      requestId,
    });
    if (
      current &&
      isAuthenticatedWalletSession(session) &&
      !walletSessionMatches(session, current.wallet)
    ) {
      throw new ApiProblem(
        409,
        "SESSION_WALLET_MISMATCH",
        "This session is bound to another wallet.",
      );
    }
    return Response.json(
      { request: current },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
