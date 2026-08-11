import {
  readMarketplaceJson,
  requireMarketplaceSession,
} from "@/lib/marketplace-api";
import { applyToMarketplaceCampaign } from "@/lib/marketplace-service";
import { apiError } from "@/lib/verification-api";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  try {
    const body = await readMarketplaceJson(request);
    const session = requireMarketplaceSession(request);
    const { campaignId } = await params;
    await enforceVerificationRateLimit(request, "marketplace-apply", {
      subject: session.subject,
      wallet: session.wallet,
      requestId: campaignId,
    });
    const result = await applyToMarketplaceCampaign({
      campaignId,
      session,
      body,
    });
    return Response.json(result, {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
