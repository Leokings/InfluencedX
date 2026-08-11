import { requireMarketplaceSession } from "@/lib/marketplace-api";
import { getMarketplaceSettlementState } from "@/lib/marketplace-settlement";
import { apiError } from "@/lib/verification-api";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  try {
    const session = requireMarketplaceSession(request);
    const { campaignId } = await params;
    const settlement = await getMarketplaceSettlementState({ campaignId, session });
    return Response.json({ settlement }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
