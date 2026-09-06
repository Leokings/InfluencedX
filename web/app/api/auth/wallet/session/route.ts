import { apiError, assertSameOriginRequest } from "@/lib/verification-api";
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
    assertSameOriginRequest(request, "DELETE");
    // Signing out never cancels verification, edits its journal, or waits for
    // a database/chain operation. Those records survive independently.
    return clearWalletSessionCookies(
      Response.json(
        {
          authenticated: false,
          wallet: null,
          expiresAt: null,
        },
        { headers: { "Cache-Control": "private, no-store" } },
      ),
    );
  } catch (error) {
    return apiError(error);
  }
}
