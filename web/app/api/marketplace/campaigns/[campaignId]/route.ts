import { optionalMarketplaceWallet } from "@/lib/marketplace-api";
import { getMarketplaceCampaignDetail } from "@/lib/marketplace-service";
import { apiError } from "@/lib/verification-api";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  try {
    const { campaignId } = await params;
    const result = await getMarketplaceCampaignDetail({
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
