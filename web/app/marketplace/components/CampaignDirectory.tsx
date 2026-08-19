"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { marketplaceErrorMessage, marketplaceRequest } from "../marketplace-api";
import {
  campaignStatusLabel,
  campaignBudgetAtoms,
  campaignContentSource,
  contentSourceLabel,
  deadlineLabel,
  fundingStatusLabel,
  genAtomsToDisplay,
  type CampaignListResponse,
  type MarketplaceCampaign,
} from "../marketplace-types";
import { MarketplaceState } from "./MarketplaceState";

const FILTERS = ["All", "X", "Farcaster", "Crypto", "Dev tools", "Consumer", "AI"];
const EMPTY_CAMPAIGNS: MarketplaceCampaign[] = [];

type LoadState =
  | { phase: "loading"; data: null; error: null }
  | { phase: "ready"; data: CampaignListResponse; loadedAt: number; error: null }
  | { phase: "error"; data: null; error: string };

export function CampaignDirectory() {
  const [filter, setFilter] = useState("All");
  const [loadState, setLoadState] = useState<LoadState>({ phase: "loading", data: null, error: null });

  const loadCampaigns = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await marketplaceRequest<CampaignListResponse>("/api/marketplace/campaigns", { signal });
      setLoadState({
        phase: "ready",
        data: {
          campaigns: Array.isArray(data.campaigns) ? data.campaigns : [],
          summary: data.summary ?? { openCampaigns: 0, lockedGen: "0" },
        },
        loadedAt: Date.now(),
        error: null,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadState({ phase: "error", data: null, error: marketplaceErrorMessage(error) });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadCampaigns(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadCampaigns]);

  const campaigns = loadState.data?.campaigns ?? EMPTY_CAMPAIGNS;
  const supportedCampaigns = useMemo(
    () => campaigns.filter((campaign) => campaign.format.toLowerCase() === "post"),
    [campaigns],
  );
  const visibleCampaigns = useMemo(
    () => supportedCampaigns.filter((campaign) => (
      filter === "All"
      || campaign.format.toLowerCase() === filter.toLowerCase()
      || campaign.category.toLowerCase() === filter.toLowerCase()
      || campaignContentSource(campaign).toLowerCase() === filter.toLowerCase()
    )),
    [supportedCampaigns, filter],
  );
  const featured = supportedCampaigns.find((campaign) => campaign.status === "open")
    ?? supportedCampaigns[0]
    ?? null;
  const summary = loadState.data?.summary ?? null;

  return (
    <>
      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow"><span /> CREATOR MARKETPLACE / PROOF-SETTLED</p>
          <h1>DEALS.<br /><em>PROVED.</em><br />PAID.</h1>
          <p className="hero-description">
            Brands publish a funded brief. Verified creators apply with their rate.
            Campaign funding, public-work resolution, payouts, and refunds all run on GenLayer.
          </p>
          <div className="hero-actions">
            <a className="button" href="#campaigns">EXPLORE CAMPAIGNS →</a>
            <Link className="underlined-action" href="/marketplace/create">Create a campaign</Link>
          </div>

          <div className="hero-stats" aria-label="Live InfluencedX marketplace statistics">
            <div><strong>{summary ? summary.openCampaigns : "—"}</strong><span>OPEN CAMPAIGNS</span></div>
            <div><strong>{summary ? genAtomsToDisplay(summaryLockedAtoms(summary)) : "—"}</strong><span>LOCKED TEST GEN</span></div>
            <div><strong>61999</strong><span>STUDIONET CHAIN</span></div>
            <div className="live-stat"><strong>GEN</strong><span>NATIVE CAMPAIGN ASSET</span></div>
          </div>
        </div>

        <CampaignSpotlight campaign={featured} phase={loadState.phase} loadedAt={loadState.phase === "ready" ? loadState.loadedAt : 0} />
      </section>

      <MarketActivity loading={loadState.phase === "loading"} />

      <section className="campaign-section" id="campaigns">
        <div className="section-heading">
          <div>
            <p className="eyebrow"><span /> LIVE API / GENLAYER STUDIONET</p>
            <h2>ACTIVE CAMPAIGNS</h2>
          </div>
          <p>Browse public briefs. Apply with a wallet that has an active InfluencedX identity for the campaign&apos;s source.</p>
        </div>

        <div className="filter-bar" role="group" aria-label="Filter campaigns">
          {FILTERS.map((item) => (
            <button
              type="button"
              className={filter === item ? "active" : ""}
              aria-pressed={filter === item}
              onClick={() => setFilter(item)}
              key={item}
            >
              {item.toUpperCase()}
            </button>
          ))}
          <span>{String(visibleCampaigns.length).padStart(2, "0")} RESULTS</span>
        </div>

        {loadState.phase === "loading" ? (
          <MarketplaceState kind="loading" title="LOADING THE MARKET" message="Reading current campaign records from InfluencedX." />
        ) : null}
        {loadState.phase === "error" ? (
          <MarketplaceState
            kind="error"
            title="MARKET UNAVAILABLE"
            message={loadState.error}
            onRetry={() => {
              setLoadState({ phase: "loading", data: null, error: null });
              void loadCampaigns();
            }}
          />
        ) : null}
        {loadState.phase === "ready" && visibleCampaigns.length === 0 ? (
          <MarketplaceState
            kind="empty"
            title={supportedCampaigns.length === 0 ? "NO TEXT-POST CAMPAIGNS YET" : "NO MATCHING CAMPAIGNS"}
            message={supportedCampaigns.length === 0
              ? "Be the first brand to publish a testnet campaign. It will appear here after the API accepts it."
              : "Choose another filter to see the campaigns currently available."}
            action={supportedCampaigns.length === 0 ? { href: "/marketplace/create", label: "CREATE CAMPAIGN" } : undefined}
          />
        ) : null}
        {loadState.phase === "ready" && visibleCampaigns.length > 0 ? (
          <div className="campaign-grid">
            {visibleCampaigns.map((campaign) => <CampaignCard campaign={campaign} loadedAt={loadState.loadedAt} key={campaign.id} />)}
          </div>
        ) : null}
      </section>
    </>
  );
}

function CampaignSpotlight({ campaign, phase, loadedAt }: { campaign: MarketplaceCampaign | null; phase: LoadState["phase"]; loadedAt: number }) {
  if (phase === "loading") {
    return (
      <aside className="spotlight spotlight-state" aria-label="Loading featured campaign">
        <span>READING LIVE CAMPAIGNS</span>
        <h2>THE NEXT<br />BRIEF</h2>
        <p>No campaign details are shown until the API responds.</p>
      </aside>
    );
  }
  if (!campaign) {
    return (
      <aside className="spotlight spotlight-state" aria-label="No featured campaign">
        <span>OPEN MARKET</span>
        <h2>YOUR BRIEF<br />GOES HERE</h2>
        <p>Create the first live campaign. Drafts stay marked unfunded until StudioNet finalizes the matching GEN deposit.</p>
        <Link className="button campaign-cta" href="/marketplace/create">CREATE CAMPAIGN →</Link>
      </aside>
    );
  }

  return (
    <aside className={`spotlight campaign-status-${campaign.status}`} aria-label="Featured campaign">
      <div className="panel-kicker">
        <span><i /> {campaignStatusLabel(campaign.status)}</span>
        <span>{campaign.id}</span>
      </div>
      <div className="spotlight-body">
        <p className="mono-label">{(campaign.brandName ?? "WALLET BRAND").toUpperCase()} · {campaign.category.toUpperCase()}</p>
        <h2>{campaign.title}</h2>
        <div className="tag-row">
          <span>{contentSourceLabel(campaignContentSource(campaign))} POST</span>
          <span>{fundingStatusLabel(campaign.fundingStatus)}</span>
          <span>{campaign.category.toUpperCase()}</span>
        </div>
        <p className="spotlight-copy">{campaign.description}</p>
      </div>
      <div className="campaign-numbers">
        <div><span>BUDGET</span><strong>{genAtomsToDisplay(campaignBudgetAtoms(campaign))} <small>TEST GEN</small></strong></div>
        <div><span>DEADLINE</span><strong>{deadlineLabel(campaign.deadline, loadedAt)}</strong></div>
        <div><span>APPLICANTS</span><strong>{campaign.applicationCount}</strong></div>
      </div>
      <Link className="button campaign-cta" href={`/marketplace/campaigns/${encodeURIComponent(campaign.id)}`}>
        VIEW BRIEF →
      </Link>
    </aside>
  );
}

function MarketActivity({ loading }: { loading: boolean }) {
  return (
    <div className="market-ticker" id="activity" aria-label="Marketplace activity">
      <span className="ticker-title"><i /> MARKET DATA</span>
      {loading ? <span>LOADING CURRENT ACTIVITY</span> : null}
      {!loading ? <span>ACTIVITY FEED WILL APPEAR WHEN THE API RECORDS AN ONCHAIN EVENT</span> : null}
    </div>
  );
}

function CampaignCard({ campaign, loadedAt }: { campaign: MarketplaceCampaign; loadedAt: number }) {
  return (
    <article className={`campaign-card campaign-status-${campaign.status} campaign-category-${categoryClass(campaign.category)}`}>
      <div className="card-topline">
        <span>{campaign.id}</span>
        <span><i /> {campaignStatusLabel(campaign.status)}</span>
      </div>
      <div className="campaign-brand">{(campaign.brandName ?? "WALLET BRAND").toUpperCase()}</div>
      <h3>{campaign.title}</h3>
      <div className="tag-row compact">
        <span>{contentSourceLabel(campaignContentSource(campaign))} POST</span>
        <span>{campaign.category.toUpperCase()}</span>
        <span>{fundingStatusLabel(campaign.fundingStatus)}</span>
      </div>
      <dl>
        <div><dt>BUDGET</dt><dd>{genAtomsToDisplay(campaignBudgetAtoms(campaign))} <small>GEN</small></dd></div>
        <div><dt>CLOSES</dt><dd>{deadlineLabel(campaign.deadline, loadedAt)}</dd></div>
        <div><dt>APPLIED</dt><dd>{String(campaign.applicationCount).padStart(2, "0")}</dd></div>
      </dl>
      <Link className="card-action" href={`/marketplace/campaigns/${encodeURIComponent(campaign.id)}`}>
        OPEN BRIEF →
      </Link>
    </article>
  );
}

function categoryClass(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "crypto") return "crypto";
  if (normalized === "dev tools") return "dev-tools";
  if (normalized === "consumer") return "consumer";
  return "other";
}

function summaryLockedAtoms(summary: CampaignListResponse["summary"]): string {
  return summary.lockedGen;
}
