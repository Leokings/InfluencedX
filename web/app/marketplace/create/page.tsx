import type { Metadata } from "next";
import { MarketplaceFooter, MarketplaceHeader } from "../components/MarketplaceHeader";
import { CreateCampaignForm } from "./CreateCampaignForm";

export const metadata: Metadata = {
  title: "Create a campaign · InfluencedX",
  description: "Create and fund an InfluencedX campaign with native test GEN on GenLayer StudioNet.",
};

export default function CreateCampaignPage() {
  return (
    <main className="marketplace-page">
      <MarketplaceHeader active="create" />
      <section className="marketplace-form-layout">
        <div className="marketplace-page-intro">
          <p className="eyebrow"><span /> BRAND WORKSPACE / GENLAYER</p>
          <h1>CREATE A<br /><em>CAMPAIGN.</em></h1>
          <p>Set the brief, budget, and deadline.</p>
        </div>
        <CreateCampaignForm />
      </section>
      <MarketplaceFooter />
    </main>
  );
}
