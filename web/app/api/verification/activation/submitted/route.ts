import {
  ApiProblem,
  assertExactJsonKeys,
  apiError,
  readSameOriginJson,
} from "@/lib/verification-api";
import { bindGenLayerIdentityBundleActivationSubmission } from "@/lib/marketplace-genlayer-activation";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";
import { readActivationReceiptCapability } from "@/lib/activation-receipt-capability";
import { marketplaceContractAddress } from "@/lib/marketplace-genlayer-rpc";
import {
  isAuthenticatedWalletSession,
  readWalletSession,
} from "@/lib/wallet-session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readSameOriginJson(request);
    assertExactJsonKeys(body, ["preparedId", "txHash", "submissionToken"], ["preparedId", "txHash"]);
    const session = readWalletSession(request);
    const receipt = body.submissionToken === undefined ? null : readActivationReceiptCapability(
      body.submissionToken,
      { preparedId: typeof body.preparedId === "string" ? body.preparedId : "", contractAddress: marketplaceContractAddress() },
    );
    const authority = receipt ?? (session && isAuthenticatedWalletSession(session) ? session : null);
    if (!authority) {
      throw new ApiProblem(
        401,
        "WALLET_AUTHENTICATION_REQUIRED",
        "Prove control of your wallet before recording activation submission.",
      );
    }
    await enforceVerificationRateLimit(request, "intent", {
      subject: authority.subject,
      wallet: authority.wallet,
      requestId:
        typeof body.preparedId === "string" ? body.preparedId : null,
    });
    return Response.json(
      await bindGenLayerIdentityBundleActivationSubmission({
        session: authority,
        preparedId: body.preparedId,
        txHash: body.txHash,
        receiptRequestId: receipt?.requestId,
      }),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
