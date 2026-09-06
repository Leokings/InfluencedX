import { ApiProblem, apiError, assertExactJsonKeys, readSameOriginJson, requireString } from "@/lib/verification-api";
import { resumeGenLayerIdentityBundlePreparation } from "@/lib/marketplace-genlayer-activation";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";
import { isAuthenticatedWalletSession, readWalletSession } from "@/lib/wallet-session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readSameOriginJson(request);
    assertExactJsonKeys(body, ["requestId", "preparedId"]);
    const session = readWalletSession(request);
    if (!session || !isAuthenticatedWalletSession(session)) throw new ApiProblem(401, "WALLET_AUTHENTICATION_REQUIRED", "Sign in to resume verification.");
    const requestId = requireString(body, "requestId", 128);
    await enforceVerificationRateLimit(request, "intent", { subject: session.subject, wallet: session.wallet, requestId });
    return Response.json(await resumeGenLayerIdentityBundlePreparation({ session, requestId, preparedId: requireString(body, "preparedId", 128) }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiError(error); }
}
