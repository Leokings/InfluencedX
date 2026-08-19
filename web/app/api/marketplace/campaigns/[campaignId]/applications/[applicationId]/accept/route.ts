import {
  readMarketplaceJson,
  requireMarketplaceSession,
} from "@/lib/marketplace-api";
import { prepareGenLayerAccept } from "@/lib/marketplace-genlayer-actions";
import { apiError } from "@/lib/verification-api";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ campaignId: string; applicationId: string }>;
  },
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
    const result = await prepareGenLayerAccept({
      campaignId,
      applicationId,
      session,
      body,
    });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
