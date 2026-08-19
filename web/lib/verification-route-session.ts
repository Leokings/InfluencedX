import { ApiProblem } from "@/lib/verification-api";
import { getNativeVerificationStatus } from "@/lib/verification-native-service";
import {
  walletSessionMatches,
  type AuthenticatedWalletSession,
} from "@/lib/wallet-session";

export async function requireWalletBoundRequest(
  session: AuthenticatedWalletSession,
  requestId: string,
): Promise<void> {
  const current = await getNativeVerificationStatus({
    ownerUserId: session.subject,
    requestId,
  });
  if (!current) {
    throw new ApiProblem(
      404,
      "REQUEST_NOT_FOUND",
      "Verification request not found.",
    );
  }
  if (!walletSessionMatches(session, current.wallet)) {
    throw new ApiProblem(
      409,
      "SESSION_WALLET_MISMATCH",
      "This session is bound to another wallet.",
    );
  }
}
