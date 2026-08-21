import Link from "next/link";
import { CampaignDirectory } from "./marketplace/components/CampaignDirectory";
import { MarketplaceFooter, MarketplaceHeader } from "./marketplace/components/MarketplaceHeader";

export default function Home() {
  return (
    <main>
      <MarketplaceHeader />
      <CampaignDirectory />

      <section className="proof-section" id="proof">
        <div className="proof-intro">
          <p className="eyebrow"><span /> HOW IT WORKS</p>
          <h2>WORK.<br /><em>RESOLVED.</em></h2>
          <p>
            Submit an X post or Farcaster cast. GenLayer settles the payment or refund.
          </p>
          <Link className="button" href="/verify">VERIFY X + FARCASTER →</Link>
        </div>

        <div className="proof-board">
          <div className="proof-board-head">
            <span>CAMPAIGN FLOW</span>
            <span>4 STEPS</span>
          </div>
          {[
            ["01", "BRIEF", "TERMS + DELIVERABLES", "REQUIRED"],
            ["02", "SUBMISSION", "X POST OR FARCASTER CAST", "REQUIRED"],
            ["03", "REVIEW", "GENLAYER", "PENDING"],
            ["04", "SETTLEMENT", "PAY OR REFUND", "AFTER FINALITY"],
          ].map(([number, title, detail, status]) => (
            <div className="proof-step" key={number}>
              <strong>{number}</strong>
              <div><b>{title}</b><span>{detail}</span></div>
              <em>{status}</em>
            </div>
          ))}
          <div className="proof-result proof-result-neutral">
            <span>OUTCOME</span>
            <strong>PAY OR REFUND</strong>
            <span>AFTER FINALITY</span>
          </div>
        </div>
      </section>

      <section className="creator-section" id="creators">
        <div className="section-heading creator-heading">
          <div>
            <p className="eyebrow"><span /> IDENTITY</p>
            <h2>CREATOR BOARD</h2>
          </div>
          <p>Verified profiles only.</p>
        </div>
        <div className="creator-data-notice">
          <div>
            <span>IDENTITY</span>
            <strong>PROVEN WITH X + FARCASTER · 1 TRANSACTION</strong>
          </div>
          <div>
            <span>RATE</span>
            <strong>SET BY CREATOR</strong>
          </div>
          <div>
            <span>DATA</span>
            <strong>VERIFIED ONLY</strong>
          </div>
        </div>
        <div className="method-note">
          <span>GET VERIFIED</span>
          <p>Create your profile.</p>
          <Link href="/verify">VERIFY A PROFILE →</Link>
        </div>
      </section>

      <MarketplaceFooter />
    </main>
  );
}
