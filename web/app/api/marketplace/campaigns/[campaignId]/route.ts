import { optionalMarketplaceWallet } from "@/lib/marketplace-api";
import { getGenLayerMarketplaceCampaignDetail } from "@/lib/marketplace-genlayer-service";
import { apiError } from "@/lib/verification-api";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  try {
    const { campaignId } = await params;
    const result = await getGenLayerMarketplaceCampaignDetail({
      campaignId,
      viewerWallet: optionalMarketplaceWallet(request),
    });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
