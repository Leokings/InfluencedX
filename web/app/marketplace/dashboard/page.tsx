import type { Metadata } from "next";
import { MarketplaceFooter, MarketplaceHeader } from "../components/MarketplaceHeader";
import { MarketplaceDashboard } from "./MarketplaceDashboard";

export const metadata: Metadata = {
  title: "Dashboard · InfluencedX",
  description: "Track your GenLayer campaigns, creator applications, and claimable test GEN.",
};

export default function MarketplaceDashboardPage() {
  return (
    <main className="marketplace-page">
      <MarketplaceHeader active="dashboard" />
      <MarketplaceDashboard />
      <MarketplaceFooter />
    </main>
  );
}
