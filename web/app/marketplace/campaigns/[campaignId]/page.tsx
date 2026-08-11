import type { Metadata } from "next";
import { MarketplaceFooter, MarketplaceHeader } from "../../components/MarketplaceHeader";
import { CampaignDetail } from "./CampaignDetail";

export const metadata: Metadata = {
  title: "Campaign brief · InfluencedX",
  description: "Review and take action on an InfluencedX creator campaign.",
};

export default async function CampaignDetailPage({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaignId } = await params;
  return (
    <main className="marketplace-page">
      <MarketplaceHeader />
      <CampaignDetail campaignId={campaignId} />
      <MarketplaceFooter />
    </main>
  );
}
