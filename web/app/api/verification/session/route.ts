import { endNativeVerificationRun, getNativeVerificationStatus } from "@/lib/verification-native-service";
import {
  ApiProblem,
  apiError,
  assertExactJsonKeys,
  readSameOriginDeleteJson,
  requireString,
} from "@/lib/verification-api";
import {
  clearWalletSessionCookies,
  isAuthenticatedWalletSession,
  readWalletSession,
  walletSessionMatches,
} from "@/lib/wallet-session";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request) {
  try {
    const body = await readSameOriginDeleteJson(request);
    assertExactJsonKeys(body, ["requestId", "revision"]);
    const requestId = requireString(body, "requestId", 128);
    const revision = body.revision;
    if (!Number.isSafeInteger(revision) || Number(revision) < 0) {
      throw new ApiProblem(400, "INVALID_REQUEST", "revision is invalid.");
    }
    const session = readWalletSession(request);
    if (!session || !isAuthenticatedWalletSession(session)) {
      throw new ApiProblem(401, "AUTHENTICATION_REQUIRED", "Reconnect your wallet.");
    }
    const current = await getNativeVerificationStatus({ ownerUserId: session.subject, requestId });
    if (!current || !walletSessionMatches(session, current.wallet)) {
      throw new ApiProblem(404, "REQUEST_NOT_FOUND", "Verification request not found.");
    }
    const result = await endNativeVerificationRun({
      ownerUserId: session.subject,
      requestId,
      revision: Number(revision),
    });
    return clearWalletSessionCookies(
      Response.json(
        { ...result, authenticated: false, wallet: null },
        { headers: { "Cache-Control": "private, no-store" } },
      ),
    );
  } catch (error) {
    return apiError(error);
  }
}
