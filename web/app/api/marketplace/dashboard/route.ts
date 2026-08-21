import { requireMarketplaceSession } from "@/lib/marketplace-api";
import { getGenLayerDashboardRows } from "@/lib/marketplace-genlayer-repository";
import { marketplaceDashboardDto } from "@/lib/marketplace-types";
import { apiError } from "@/lib/verification-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = requireMarketplaceSession(request);
    const dashboard = await getGenLayerDashboardRows(session.wallet);
    return Response.json(marketplaceDashboardDto(dashboard), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
