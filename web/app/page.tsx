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
          <p className="eyebrow"><span /> PUBLIC EVIDENCE / PRIVATE KEYS STAY PRIVATE</p>
          <h2>WORK.<br /><em>RESOLVED.</em></h2>
          <p>
            A creator’s public X post, campaign terms, and deadlines form a resolution request.
            GenLayer evaluates the public evidence and atomically credits the creator or refunds the brand.
          </p>
          <Link className="button" href="/verify">VERIFY YOUR X →</Link>
        </div>

        <div className="proof-board">
          <div className="proof-board-head">
            <span>CAMPAIGN RESOLUTION PIPELINE</span>
            <span>NO RESULT IMPLIED</span>
          </div>
          {[
            ["01", "CAMPAIGN TERMS", "HASHED BRIEF + DELIVERABLES", "REQUIRED"],
            ["02", "CREATOR SUBMISSION", "PUBLIC X POST", "REQUIRED"],
            ["03", "GENLAYER RESOLUTION", "VALIDATOR CONSENSUS", "PENDING"],
            ["04", "GENLAYER SETTLEMENT", "CREDIT OR REFUND", "AFTER FINALITY"],
          ].map(([number, title, detail, status]) => (
            <div className="proof-step" key={number}>
              <strong>{number}</strong>
              <div><b>{title}</b><span>{detail}</span></div>
              <em>{status}</em>
            </div>
          ))}
          <div className="proof-result proof-result-neutral">
            <span>SETTLEMENT RULE</span>
            <strong>FINAL EVIDENCE ONLY</strong>
            <span>NATIVE TEST GEN</span>
          </div>
        </div>
      </section>

      <section className="creator-section" id="creators">
        <div className="section-heading creator-heading">
          <div>
            <p className="eyebrow"><span /> VERIFIED SIGNALS / NO DEMO METRICS</p>
            <h2>CREATOR BOARD</h2>
          </div>
          <p>Creator figures appear only after account ownership and metric evidence are recorded.</p>
        </div>
        <div className="creator-data-notice">
          <div>
            <span>ACCOUNT OWNERSHIP</span>
            <strong>PROVEN WITH A ONE-TIME PUBLIC X POST</strong>
          </div>
          <div>
            <span>PAY ESTIMATE INPUTS</span>
            <strong>ACCOUNT AGE · FOLLOWERS · MEDIAN ENGAGEMENT</strong>
          </div>
          <div>
            <span>MARKET RULE</span>
            <strong>CREATORS ALWAYS SET THEIR OWN APPLICATION RATE</strong>
          </div>
        </div>
        <div className="method-note">
          <span>REAL DATA ONLY</span>
          <p>No follower counts, engagement rates, or pay ranges are displayed until the metrics API supplies evidence-backed values.</p>
          <Link href="/verify">VERIFY A PROFILE →</Link>
        </div>
      </section>

      <MarketplaceFooter />
    </main>
  );
}
