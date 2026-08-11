import type { Metadata } from "next";
import { MarketplaceFooter, MarketplaceHeader } from "../components/MarketplaceHeader";
import { CreateCampaignForm } from "./CreateCampaignForm";

export const metadata: Metadata = {
  title: "Create a campaign · InfluencedX",
  description: "Create an InfluencedX campaign for verified X creators on Base Sepolia.",
};

export default function CreateCampaignPage() {
  return (
    <main className="marketplace-page">
      <MarketplaceHeader active="create" />
      <section className="marketplace-form-layout">
        <div className="marketplace-page-intro">
          <p className="eyebrow"><span /> BRAND WORKSPACE / BASE SEPOLIA</p>
          <h1>CREATE A<br /><em>CAMPAIGN.</em></h1>
          <p>
            Publish exact deliverables, a deadline, and a test-USDC budget.
            The API creates a draft first; it is never labelled funded until Base confirms it.
          </p>
          <ol className="marketplace-sequence">
            <li><strong>01</strong><span>WRITE THE PUBLIC BRIEF</span></li>
            <li><strong>02</strong><span>CREATE THE TESTNET DRAFT</span></li>
            <li><strong>03</strong><span>FUND ESCROW ON BASE</span></li>
            <li><strong>04</strong><span>OPEN APPLICATIONS</span></li>
          </ol>
        </div>
        <CreateCampaignForm />
      </section>
      <MarketplaceFooter />
    </main>
  );
}
