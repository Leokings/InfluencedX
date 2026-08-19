import { requireMarketplaceSession } from "@/lib/marketplace-api";
import { getGenLayerSettlement } from "@/lib/marketplace-genlayer-actions";
import { apiError } from "@/lib/verification-api";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  try {
    const session = requireMarketplaceSession(request);
    const { campaignId } = await params;
    const result = await getGenLayerSettlement({ campaignId, session, body: {} });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
