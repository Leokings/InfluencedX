import {
  readMarketplaceJson,
  requireMarketplaceSession,
} from "@/lib/marketplace-api";
import { prepareGenLayerWithdrawal } from "@/lib/marketplace-genlayer-actions";
import { ApiProblem, apiError } from "@/lib/verification-api";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  try {
    const body = await readMarketplaceJson(request);
    if (Object.keys(body).length !== 0) {
      throw new ApiProblem(400, "INVALID_REQUEST", "Withdrawal preparation accepts no input fields.");
    }
    const session = requireMarketplaceSession(request);
    const { campaignId } = await params;
    await enforceVerificationRateLimit(request, "marketplace-settlement", {
      subject: session.subject,
      wallet: session.wallet,
      requestId: campaignId,
    });
    const result = await prepareGenLayerWithdrawal({ campaignId, session, body });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
