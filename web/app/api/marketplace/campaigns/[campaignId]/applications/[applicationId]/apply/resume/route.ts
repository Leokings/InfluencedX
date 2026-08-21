import { resumePreparedGenLayerApplication } from "@/lib/marketplace-genlayer-actions";
import { applicationActionRoute } from "@/lib/marketplace-genlayer-route-handler";

export const dynamic = "force-dynamic";
export const POST = applicationActionRoute(
  resumePreparedGenLayerApplication,
  "marketplace-apply",
);
