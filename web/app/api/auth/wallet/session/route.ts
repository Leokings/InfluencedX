import { authorizeNativeWalletSessionClear } from "@/lib/verification-native-service";
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
    const session = readWalletSession(request);
    const result = session
      ? await authorizeNativeWalletSessionClear({ ownerUserId: session.subject })
      : { processing: false };
    return clearWalletSessionCookies(
      Response.json(
        {
          ...result,
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
