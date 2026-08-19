import {
  ApiProblem,
  assertExactJsonKeys,
  apiError,
  readSameOriginJson,
  requireString,
} from "@/lib/verification-api";
import { issueIdentityBundleChallenge } from "@/lib/marketplace-genlayer-activation";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";
import {
  isAuthenticatedWalletSession,
  readWalletSession,
} from "@/lib/wallet-session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readSameOriginJson(request);
    assertExactJsonKeys(body, [
      "requestId",
      "handle",
      "farcasterUsername",
      "farcasterFid",
    ]);
    const session = readWalletSession(request);
    if (!session || !isAuthenticatedWalletSession(session)) {
      throw new ApiProblem(
        401,
        "WALLET_AUTHENTICATION_REQUIRED",
        "Prove control of your wallet before creating identity challenges.",
      );
    }
    const requestId = requireString(body, "requestId", 128);
    await enforceVerificationRateLimit(request, "x-challenge", {
      subject: session.subject,
      wallet: session.wallet,
      requestId,
    });
    return Response.json(
      await issueIdentityBundleChallenge({
        session,
        requestId,
        handle: body.handle,
        farcasterUsername: body.farcasterUsername,
        farcasterFid: body.farcasterFid,
      }),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
