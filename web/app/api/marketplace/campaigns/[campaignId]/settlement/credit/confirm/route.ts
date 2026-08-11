import {
  readMarketplaceJson,
  requireMarketplaceSession,
} from "@/lib/marketplace-api";
import { confirmMarketplaceUnallocatedCredit } from "@/lib/marketplace-settlement";
import { ApiProblem, apiError } from "@/lib/verification-api";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  try {
    const body = await readMarketplaceJson(request);
    if (Object.keys(body).length !== 1 || !("txHash" in body)) {
      throw new ApiProblem(400, "INVALID_REQUEST", "Credit confirmation requires only txHash.");
    }
    const session = requireMarketplaceSession(request);
    const { campaignId } = await params;
    await enforceVerificationRateLimit(request, "marketplace-settlement", {
      subject: session.subject,
      wallet: session.wallet,
      requestId: campaignId,
    });
    const result = await confirmMarketplaceUnallocatedCredit({
      campaignId,
      session,
      txHash: body.txHash,
    });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
