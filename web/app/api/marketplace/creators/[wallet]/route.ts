import { getPublicMarketplaceCreatorProfile } from "@/lib/marketplace-service";
import { apiError } from "@/lib/verification-api";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ wallet: string }> },
) {
  try {
    const { wallet } = await params;
    const creator = await getPublicMarketplaceCreatorProfile({ wallet });
    return Response.json(
      { creator },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
