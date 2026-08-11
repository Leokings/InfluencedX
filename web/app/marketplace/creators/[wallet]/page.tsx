import type { Metadata } from "next";
import { MarketplaceFooter, MarketplaceHeader } from "../../components/MarketplaceHeader";
import { CreatorProfile } from "./CreatorProfile";

export const metadata: Metadata = {
  title: "Creator profile · InfluencedX",
  description: "Public InfluencedX creator identity and evidence-backed marketplace signals.",
};

export default async function CreatorProfilePage({ params }: { params: Promise<{ wallet: string }> }) {
  const { wallet } = await params;
  return (
    <main className="marketplace-page">
      <MarketplaceHeader />
      <CreatorProfile wallet={wallet} />
      <MarketplaceFooter />
    </main>
  );
}
