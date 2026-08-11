import { applicationOriginForRequest } from "@/lib/verification-config";
import { ApiProblem, apiError } from "@/lib/verification-api";
import {
  clearWalletSessionCookies,
  isAuthenticatedWalletSession,
  readWalletSession,
} from "@/lib/wallet-session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = readWalletSession(request);
  return Response.json(
    session && isAuthenticatedWalletSession(session)
      ? { authenticated: true, wallet: session.wallet, expiresAt: new Date(session.expiresAt * 1_000).toISOString() }
      : { authenticated: false, wallet: null, expiresAt: null },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function DELETE(request: Request) {
  try {
    const origin = request.headers.get("origin");
    let applicationOrigin: string;
    try {
      applicationOrigin = applicationOriginForRequest(request);
    } catch {
      throw new ApiProblem(403, "SAME_ORIGIN_REQUIRED", "This InfluencedX application origin is not allowed.");
    }
    if (!origin || origin !== applicationOrigin) {
      throw new ApiProblem(403, "SAME_ORIGIN_REQUIRED", "This action must come from the InfluencedX application.");
    }
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin") {
      throw new ApiProblem(403, "SAME_ORIGIN_REQUIRED", "Cross-site requests are not accepted.");
    }
    return clearWalletSessionCookies(
      Response.json(
        { authenticated: false, wallet: null, expiresAt: null },
        { headers: { "Cache-Control": "private, no-store" } },
      ),
    );
  } catch (error) {
    return apiError(error);
  }
}
