import {
  ApiProblem,
  assertExactJsonKeys,
  apiError,
  readSameOriginJson,
} from "@/lib/verification-api";
import { bindGenLayerIdentityBundleActivationSubmission } from "@/lib/marketplace-genlayer-activation";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";
import {
  isAuthenticatedWalletSession,
  readWalletSession,
} from "@/lib/wallet-session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readSameOriginJson(request);
    assertExactJsonKeys(body, ["preparedId", "txHash"]);
    const session = readWalletSession(request);
    if (!session || !isAuthenticatedWalletSession(session)) {
      throw new ApiProblem(
        401,
        "WALLET_AUTHENTICATION_REQUIRED",
        "Prove control of your wallet before recording activation submission.",
      );
    }
    await enforceVerificationRateLimit(request, "intent", {
      subject: session.subject,
      wallet: session.wallet,
      requestId:
        typeof body.preparedId === "string" ? body.preparedId : null,
    });
    return Response.json(
      await bindGenLayerIdentityBundleActivationSubmission({
        session,
        preparedId: body.preparedId,
        txHash: body.txHash,
      }),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
