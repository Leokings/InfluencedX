import {
  ApiProblem,
  assertExactJsonKeys,
  apiError,
  readSameOriginJson,
  requireString,
} from "@/lib/verification-api";
import { prepareGenLayerCreatorActivation } from "@/lib/marketplace-genlayer-activation";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";
import {
  isAuthenticatedWalletSession,
  readWalletSession,
} from "@/lib/wallet-session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = await readSameOriginJson(request);
    if (body.source === "X") {
      assertExactJsonKeys(body, ["requestId", "source", "verificationPostUrl"]);
    } else if (body.source === "FARCASTER") {
      assertExactJsonKeys(body, ["requestId", "source", "castHash"]);
    } else {
      throw new ApiProblem(400, "INVALID_IDENTITY_SOURCE", "source must be X or FARCASTER.");
    }
    const session = readWalletSession(request);
    if (!session || !isAuthenticatedWalletSession(session)) {
      throw new ApiProblem(401, "WALLET_AUTHENTICATION_REQUIRED", "Prove control of your wallet before preparing activation.");
    }
    const requestId = requireString(body, "requestId", 128);
    await enforceVerificationRateLimit(request, "intent", {
      subject: session.subject,
      wallet: session.wallet,
      requestId,
    });
    return Response.json(await prepareGenLayerCreatorActivation({
      session,
      requestId,
      source: body.source,
      verificationPostUrl: body.verificationPostUrl,
      castHash: body.castHash,
    }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
