"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { marketplaceErrorMessage, marketplaceRequest } from "../marketplace-api";
import {
  genAtomsToDisplay,
  shortenAddress,
} from "../marketplace-types";
import { useMarketplaceWallet } from "../use-marketplace-wallet";
import type { MarketplaceDashboardResponseDto } from "../../../lib/marketplace-types";

export function MarketplaceDashboard() {
  const wallet = useMarketplaceWallet();
  const [data, setData] = useState<MarketplaceDashboardResponseDto | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      await wallet.authenticate();
      const response = await marketplaceRequest<MarketplaceDashboardResponseDto>("/api/marketplace/dashboard");
      setData({
        ...response,
        brandCampaigns: Array.isArray(response.brandCampaigns) ? response.brandCampaigns : [],
        creatorApplications: Array.isArray(response.creatorApplications) ? response.creatorApplications : [],
      });
      setPhase("ready");
    } catch (loadError) {
      setError(marketplaceErrorMessage(loadError));
      setPhase("error");
    }
  }, [wallet]);

  return (
    <section className="marketplace-detail-shell dashboard-shell">
      <div className="campaign-detail-head">
        <div>
          <p className="eyebrow"><span /> WALLET WORKSPACE / GENLAYER</p>
          <h1>YOUR<br /><em>ACTIVITY.</em></h1>
        </div>
        <aside className="campaign-terms-card">
          <div><span>WALLET</span><strong>{shortenAddress(wallet.address)}</strong></div>
          <div><span>CLAIMABLE</span><strong>{data ? genAtomsToDisplay(data.claimableAtto) : "—"} <small>GEN</small></strong></div>
          <div><span>BRAND CAMPAIGNS</span><strong>{data?.brandCampaigns.length ?? "—"}</strong></div>
          <div><span>CREATOR APPLICATIONS</span><strong>{data?.creatorApplications.length ?? "—"}</strong></div>
        </aside>
      </div>

      {phase !== "ready" ? (
        <div className="campaign-detail-panel dashboard-connect-panel">
          <h2>{wallet.address ? "LOAD YOUR PRIVATE VIEW" : "CONNECT YOUR WALLET"}</h2>
          <p>Private pitches stay visible only to the brand.</p>
          <button className="button" type="button" disabled={phase === "loading" || wallet.authenticating} onClick={() => void load()}>
            {phase === "loading" || wallet.authenticating ? "LOADING…" : "CONNECT + LOAD DASHBOARD →"}
          </button>
          {error ? <p className="form-message error" role="alert">{error}</p> : null}
        </div>
      ) : null}

      {data ? (
        <div className="campaign-detail-grid">
          <section className="campaign-detail-panel application-list-panel">
            <div className="detail-panel-head"><span>BRAND VIEW</span><strong>{data.brandCampaigns.length} CAMPAIGNS</strong></div>
            {data.brandCampaigns.length === 0 ? <p className="panel-empty">No campaigns created by this wallet.</p> : null}
            {data.brandCampaigns.map((campaign) => (
              <article className="brand-application" key={campaign.id}>
                <div><Link href={`/marketplace/campaigns/${encodeURIComponent(campaign.id)}`}>{shortenAddress(campaign.campaignId)}</Link><strong>{genAtomsToDisplay(campaign.budgetAtto)} GEN</strong></div>
                <p>{campaign.status.toUpperCase()} · {genAtomsToDisplay(campaign.availableAtto)} GEN AVAILABLE</p>
              </article>
            ))}
          </section>
          <section className="campaign-detail-panel application-list-panel">
            <div className="detail-panel-head"><span>CREATOR VIEW</span><strong>{data.creatorApplications.length} APPLICATIONS</strong></div>
            {data.creatorApplications.length === 0 ? <p className="panel-empty">No creator applications from this wallet.</p> : null}
            {data.creatorApplications.map((application) => (
              <article className="brand-application" key={application.id}>
                <div><Link href={`/marketplace/campaigns/${encodeURIComponent(application.campaignId)}`}>{application.campaignId}</Link><strong>{application.rateAtto ? `${genAtomsToDisplay(application.rateAtto)} GEN` : "RATE PENDING"}</strong></div>
                <p>{application.status.toUpperCase()}</p>
              </article>
            ))}
          </section>
        </div>
      ) : null}
    </section>
  );
}
