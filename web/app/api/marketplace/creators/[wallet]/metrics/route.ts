import {
  readMarketplaceJson,
  requireMarketplaceSession,
} from "@/lib/marketplace-api";
import {
  getMarketplaceCreatorMetricsStatus,
  refreshMarketplaceCreatorMetrics,
} from "@/lib/marketplace-metrics-service";
import { apiError, ApiProblem } from "@/lib/verification-api";
import { enforceVerificationRateLimit } from "@/lib/verification-rate-limit";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ wallet: string }> },
) {
  try {
    const session = requireMarketplaceSession(request);
    const { wallet } = await params;
    await enforceVerificationRateLimit(request, "marketplace-metrics-status", {
      subject: session.subject,
      wallet: session.wallet,
      requestId: wallet.toLowerCase(),
    });
    const submission = await getMarketplaceCreatorMetricsStatus({
      wallet,
      session,
    });
    return Response.json(
      { submission },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ wallet: string }> },
) {
  try {
    const body = await readMarketplaceJson(request);
    if (Object.keys(body).length !== 0) {
      throw new ApiProblem(
        400,
        "INVALID_REQUEST",
        "Metrics refresh accepts no caller-supplied handle, identity, audience, engagement, or pay values.",
      );
    }
    const session = requireMarketplaceSession(request);
    const { wallet } = await params;
    await enforceVerificationRateLimit(request, "marketplace-metrics-refresh", {
      subject: session.subject,
      wallet: session.wallet,
      requestId: wallet.toLowerCase(),
    });
    const submission = await refreshMarketplaceCreatorMetrics({
      wallet,
      session,
    });
    return Response.json(
      { submission },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
