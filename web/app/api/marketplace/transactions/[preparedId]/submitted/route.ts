import { readMarketplaceJson, requireMarketplaceSession } from "@/lib/marketplace-api";
import { bindSubmittedGenLayerMarketplaceTransaction } from "@/lib/marketplace-genlayer-actions";
import { apiError } from "@/lib/verification-api";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ preparedId: string }> },
) {
  try {
    const [body, session, { preparedId }] = await Promise.all([
      readMarketplaceJson(request),
      Promise.resolve(requireMarketplaceSession(request)),
      params,
    ]);
    await enforceVerificationRateLimit(request, "marketplace-transaction-submit", {
      subject: session.subject,
      wallet: session.wallet,
      requestId: preparedId,
    });
    return Response.json(
      await bindSubmittedGenLayerMarketplaceTransaction({
        preparedId,
        session,
        body,
      }),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
