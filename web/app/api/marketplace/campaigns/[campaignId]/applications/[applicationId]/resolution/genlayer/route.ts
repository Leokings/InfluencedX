import { readMarketplaceJson, requireMarketplaceSession } from "@/lib/marketplace-api";
import { advanceMarketplaceGenLayerResolution } from "@/lib/marketplace-genlayer-bridge";
import { apiError, ApiProblem } from "@/lib/verification-api";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ campaignId: string; applicationId: string }> },
) {
  try {
    const body = await readMarketplaceJson(request);
    if (Object.keys(body).length !== 0) {
      throw new ApiProblem(
        400,
        "INVALID_REQUEST",
        "The GenLayer campaign bridge accepts no caller-controlled method or arguments.",
      );
    }
    const session = requireMarketplaceSession(request);
    const { campaignId, applicationId } = await params;
    await enforceVerificationRateLimit(request, "marketplace-accept", {
      subject: session.subject,
      wallet: session.wallet,
      requestId: campaignId,
    });
    const result = await advanceMarketplaceGenLayerResolution({
      campaignId,
      applicationId,
      session,
    });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
