import {
  ApiProblem,
  apiError,
  readSameOriginJson,
  requireString,
} from "@/lib/verification-api";
import {
  authorizeOwnershipIntent,
  prepareOwnershipIntent,
  resumeOwnershipIntent,
} from "@/lib/verification-service";
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
    await enforceVerificationRateLimit(request, "intent", {
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
        "Prove control of your wallet before authorizing an ownership intent.",
      );
    }
    const action = requireString(body, "action", 32);
    const requestId = requireString(body, "requestId", 128);
    await requireWalletBoundRequest(session, requestId);

    if (action === "prepare") {
      const prepared = await prepareOwnershipIntent({
        ownerUserId: session.subject,
        requestId,
        verificationPostUrl: body.verificationPostUrl,
      });
      return Response.json(prepared, {
        headers: { "Cache-Control": "private, no-store" },
      });
    }

    if (action === "authorize") {
      const authorized = await authorizeOwnershipIntent({
        ownerUserId: session.subject,
        requestId,
        signature: requireString(body, "signature", 1_000),
        evidenceToken:
          typeof body.evidenceToken === "string" ? body.evidenceToken : undefined,
      });
      return Response.json(
        authorized,
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }

    if (action === "resume") {
      const resumed = await resumeOwnershipIntent({
        ownerUserId: session.subject,
        requestId,
      });
      return Response.json(resumed, {
        headers: { "Cache-Control": "private, no-store" },
      });
    }

    throw new ApiProblem(
      400,
      "INVALID_ACTION",
      "action must be prepare, resume, or authorize.",
    );
  } catch (error) {
    return apiError(error);
  }
}
