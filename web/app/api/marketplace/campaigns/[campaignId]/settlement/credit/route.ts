import {
  readMarketplaceJson,
  requireMarketplaceSession,
} from "@/lib/marketplace-api";
import { prepareMarketplaceUnallocatedCredit } from "@/lib/marketplace-settlement";
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
      throw new ApiProblem(400, "INVALID_REQUEST", "Unused-budget preparation accepts no input fields.");
    }
    const session = requireMarketplaceSession(request);
    const { campaignId } = await params;
    await enforceVerificationRateLimit(request, "marketplace-settlement", {
      subject: session.subject,
      wallet: session.wallet,
      requestId: campaignId,
    });
    const result = await prepareMarketplaceUnallocatedCredit({ campaignId, session });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
