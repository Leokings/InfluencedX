"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { marketplaceErrorMessage, marketplaceRequest } from "../marketplace-api";
import {
  applicationRateAtoms,
  campaignBudgetAtoms,
  campaignContentSource,
  genAtomsToDisplay,
  type MarketplaceApplication,
  type MarketplaceCampaign,
  shortenAddress,
} from "../marketplace-types";
import { useMarketplaceWallet } from "../use-marketplace-wallet";

type DashboardResponse = {
  brandCampaigns: MarketplaceCampaign[];
  creatorApplications: MarketplaceApplication[];
  claimableGen?: string;
  claimableAtto?: string;
  withdrawalId?: string | null;
  withdrawalStatus?: "PENDING" | "EMITTED_UNCONFIRMED" | "CONFIRMED" | "RESTORED_FAILED" | null;
};

export function MarketplaceDashboard() {
  const wallet = useMarketplaceWallet();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase("loading");
    setError(null);
    try {
      await wallet.authenticate();
      const response = await marketplaceRequest<DashboardResponse>("/api/marketplace/dashboard");
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
          <p>Track campaigns, applications, finalized outcomes, and native GEN available to claim.</p>
        </div>
        <aside className="campaign-terms-card">
          <div><span>WALLET</span><strong>{shortenAddress(wallet.address)}</strong></div>
          <div><span>CLAIMABLE</span><strong>{data ? genAtomsToDisplay(data.claimableAtto ?? data.claimableGen ?? "0") : "—"} <small>GEN</small></strong></div>
          {data?.withdrawalStatus ? <div><span>WITHDRAWAL</span><strong>{data.withdrawalStatus.replaceAll("_", " ")}</strong><small>{data.withdrawalStatus === "CONFIRMED" ? "DELIVERY CONFIRMED" : "NOT YET CONFIRMED AS PAID"}</small></div> : null}
          <div><span>BRAND CAMPAIGNS</span><strong>{data?.brandCampaigns.length ?? "—"}</strong></div>
          <div><span>CREATOR APPLICATIONS</span><strong>{data?.creatorApplications.length ?? "—"}</strong></div>
        </aside>
      </div>

      {phase !== "ready" ? (
        <div className="campaign-detail-panel dashboard-connect-panel">
          <h2>{wallet.address ? "LOAD YOUR PRIVATE VIEW" : "CONNECT YOUR WALLET"}</h2>
          <p>The dashboard is scoped to the wallet’s authenticated session. Other creators’ pitches remain private.</p>
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
                <div><Link href={`/marketplace/campaigns/${encodeURIComponent(campaign.id)}`}>{campaign.title}</Link><strong>{genAtomsToDisplay(campaignBudgetAtoms(campaign))} GEN</strong></div>
                <p>{campaignContentSource(campaign)} · {campaign.status.toUpperCase()} · {campaign.fundingStatus.toUpperCase()}</p>
              </article>
            ))}
          </section>
          <section className="campaign-detail-panel application-list-panel">
            <div className="detail-panel-head"><span>CREATOR VIEW</span><strong>{data.creatorApplications.length} APPLICATIONS</strong></div>
            {data.creatorApplications.length === 0 ? <p className="panel-empty">No creator applications from this wallet.</p> : null}
            {data.creatorApplications.map((application) => (
              <article className="brand-application" key={application.id}>
                <div><Link href={`/marketplace/campaigns/${encodeURIComponent(application.campaignId)}`}>{application.campaignId}</Link><strong>{genAtomsToDisplay(applicationRateAtoms(application))} GEN</strong></div>
                <p>{application.status.toUpperCase()}</p>
              </article>
            ))}
          </section>
        </div>
      ) : null}
    </section>
  );
}
