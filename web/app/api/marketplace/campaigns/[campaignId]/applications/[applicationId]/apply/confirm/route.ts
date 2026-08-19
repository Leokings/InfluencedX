import { confirmGenLayerApplication } from "@/lib/marketplace-genlayer-actions";
import { applicationActionRoute } from "@/lib/marketplace-genlayer-route-handler";

export const dynamic = "force-dynamic";
export const POST = applicationActionRoute(confirmGenLayerApplication, "marketplace-apply");
