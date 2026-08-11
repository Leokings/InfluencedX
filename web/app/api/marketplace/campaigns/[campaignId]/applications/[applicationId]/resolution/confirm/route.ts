import {
  readMarketplaceJson,
  requireMarketplaceSession,
} from "@/lib/marketplace-api";
import { confirmMarketplaceResolutionRequest } from "@/lib/marketplace-service";
import { enqueueCampaignProgression } from "@/lib/campaign-progression-queue";
import { apiError } from "@/lib/verification-api";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ campaignId: string; applicationId: string }> },
) {
  try {
    const body = await readMarketplaceJson(request);
    const session = requireMarketplaceSession(request);
    const { campaignId, applicationId } = await params;
    await enforceVerificationRateLimit(request, "marketplace-accept", {
      subject: session.subject,
      wallet: session.wallet,
      requestId: campaignId,
    });
    const result = await confirmMarketplaceResolutionRequest({
      campaignId,
      applicationId,
      session,
      body,
    });
    if (!result.application.requestId) {
      throw new Error("The confirmed campaign resolution request is missing its durable ID.");
    }
    await enqueueCampaignProgression({
      requestId: result.application.requestId,
      campaignId: result.campaign.id,
      applicationId: result.application.id,
    });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
