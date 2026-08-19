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
          <p>
            Publish exact deliverables, a deadline, and a native GEN budget.
            The API creates a draft first; it opens only after StudioNet finalizes the matching deposit.
          </p>
          <ol className="marketplace-sequence">
            <li><strong>01</strong><span>WRITE THE PUBLIC BRIEF</span></li>
            <li><strong>02</strong><span>CREATE THE TESTNET DRAFT</span></li>
            <li><strong>03</strong><span>LOCK TEST GEN ON STUDIONET</span></li>
            <li><strong>04</strong><span>OPEN APPLICATIONS</span></li>
          </ol>
        </div>
        <CreateCampaignForm />
      </section>
      <MarketplaceFooter />
    </main>
  );
}
