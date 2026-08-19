import {
  readMarketplaceJson,
  requireMarketplaceSession,
} from "./marketplace-api.ts";
import { apiError } from "./verification-api.ts";
import { enforceVerificationRateLimit } from "./verification-rate-limit.ts";
import type { AuthenticatedWalletSession } from "./wallet-session.ts";

type ApplicationAction = (input: {
  campaignId: string;
  applicationId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
}) => Promise<unknown>;

type CampaignAction = (input: {
  campaignId: string;
  session: AuthenticatedWalletSession;
  body: Record<string, unknown>;
}) => Promise<unknown>;

type MarketplaceRateBucket =
  | "marketplace-apply"
  | "marketplace-select"
  | "marketplace-accept"
  | "marketplace-settlement";

export function applicationActionRoute(
  action: ApplicationAction,
  bucket: MarketplaceRateBucket,
) {
  return async function POST(
    request: Request,
    { params }: { params: Promise<{ campaignId: string; applicationId: string }> },
  ) {
    try {
      const [body, session, route] = await Promise.all([
        readMarketplaceJson(request),
        Promise.resolve(requireMarketplaceSession(request)),
        params,
      ]);
      await enforceVerificationRateLimit(request, bucket, {
        subject: session.subject,
        wallet: session.wallet,
        requestId: route.applicationId,
      });
      return Response.json(await action({ ...route, session, body }), {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (error) {
      return apiError(error);
    }
  };
}

export function campaignActionRoute(
  action: CampaignAction,
  bucket: MarketplaceRateBucket = "marketplace-settlement",
) {
  return async function POST(
    request: Request,
    { params }: { params: Promise<{ campaignId: string }> },
  ) {
    try {
      const [body, session, route] = await Promise.all([
        readMarketplaceJson(request),
        Promise.resolve(requireMarketplaceSession(request)),
        params,
      ]);
      await enforceVerificationRateLimit(request, bucket, {
        subject: session.subject,
        wallet: session.wallet,
        requestId: route.campaignId,
      });
      return Response.json(await action({ ...route, session, body }), {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (error) {
      return apiError(error);
    }
  };
}
