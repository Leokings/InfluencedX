import { confirmGenLayerCampaignCancel } from "@/lib/marketplace-genlayer-actions";
import { campaignActionRoute } from "@/lib/marketplace-genlayer-route-handler";

export const dynamic = "force-dynamic";
export const POST = campaignActionRoute(confirmGenLayerCampaignCancel);
