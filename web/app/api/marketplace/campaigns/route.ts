import {
  optionalMarketplaceWallet,
  readMarketplaceJson,
  requireMarketplaceSession,
} from "@/lib/marketplace-api";
import {
  createGenLayerMarketplaceCampaign,
  listGenLayerMarketplaceCampaigns,
} from "@/lib/marketplace-genlayer-service";
import { apiError } from "@/lib/verification-api";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const result = await listGenLayerMarketplaceCampaigns({
      requestUrl: request.url,
      viewerWallet: optionalMarketplaceWallet(request),
    });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readMarketplaceJson(request);
    const session = requireMarketplaceSession(request);
    await enforceVerificationRateLimit(
      request,
      "marketplace-campaign-create",
      {
        subject: session.subject,
        wallet: session.wallet,
      },
    );
    const campaign = await createGenLayerMarketplaceCampaign({ session, body });
    return Response.json(
      { campaign },
      {
        status: 201,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (error) {
    return apiError(error);
  }
}
