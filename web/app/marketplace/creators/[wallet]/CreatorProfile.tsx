"use client";

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { marketplaceErrorMessage, marketplaceRequest } from "../../marketplace-api";
import { MarketplaceState } from "../../components/MarketplaceState";
import { shortenAddress, studioNetExplorerLink } from "../../marketplace-types";

type IdentitySource = "X" | "FARCASTER";

type PublicCreatorIdentity = Readonly<{
  source: IdentitySource;
  handle: string;
  externalUserId: string;
  identityHash: string;
  ownershipRequestId: string;
  activationTxHash: string | null;
  active: boolean;
  verifiedAt: string;
  credentialExpiresAt: string;
}>;

type PublicCreator = Readonly<{
  ownerWallet: string;
  activeSources: IdentitySource[];
  x: PublicCreatorIdentity | null;
  farcaster: PublicCreatorIdentity | null;
  displayName: string | null;
  bio: string | null;
  categories: string[];
  metrics: null;
}>;

type CreatorState =
  | { phase: "loading"; creator: null; error: null }
  | { phase: "ready"; creator: PublicCreator; error: null }
  | { phase: "error"; creator: null; error: string };

export function CreatorProfile({ wallet }: { wallet: string }) {
  const [state, setState] = useState<CreatorState>({ phase: "loading", creator: null, error: null });

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void marketplaceRequest<{ creator: PublicCreator }>(
        `/api/marketplace/creators/${encodeURIComponent(wallet)}`,
        { signal: controller.signal },
      ).then(({ creator }) => {
        setState({ phase: "ready", creator, error: null });
      }).catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ phase: "error", creator: null, error: marketplaceErrorMessage(error) });
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [wallet]);

  if (state.phase === "loading") {
    return (
      <section className="creator-profile-shell">
        <MarketplaceState
          kind="loading"
          title="LOADING CREATOR"
          message="Reading the source-keyed creator identities directly from GenLayer StudioNet."
        />
      </section>
    );
  }
  if (state.phase === "error") {
    return (
      <section className="creator-profile-shell">
        <MarketplaceState
          kind="error"
          title="PROFILE NOT AVAILABLE"
          message={state.error}
          action={{ href: "/verify", label: "VERIFY A CREATOR" }}
        />
      </section>
    );
  }

  const creator = state.creator;
  const identities = sourceIdentities(creator);
  const primaryIdentity = identities.find((identity) => identity.active) ?? identities[0];
  const identityLabel = creator.displayName ?? primaryIdentity?.handle ?? shortenAddress(creator.ownerWallet);

  return (
    <section className="creator-profile-shell">
      <Link className="verify-back" href="/#creators">← CREATOR BOARD</Link>
      <article className="creator-profile-hero">
        <div className="creator-identity-hero">
          <div className="creator-avatar-tile" aria-hidden="true">{identityInitial(identityLabel)}</div>
          <div className="creator-hero-copy">
            <p>GENLAYER PROFILE {shortenAddress(creator.ownerWallet)}</p>
            <h1>{identityLabel}</h1>
            <strong>{primaryIdentity ? `@${primaryIdentity.handle.replace(/^@/, "")}` : "NO ACTIVE IDENTITY"}</strong>
            {creator.bio ? <span>{creator.bio}</span> : null}
            <div className="tag-row">
              {creator.activeSources.map((source) => <span key={source}>{source}</span>)}
              {creator.categories.map((category) => <span key={category}>{category.toUpperCase()}</span>)}
            </div>
          </div>
          <div className="creator-verification-badge">
            <i />
            <span>GENLAYER VERIFIED</span>
            <small>{creator.activeSources.length} ACTIVE SOURCE{creator.activeSources.length === 1 ? "" : "S"}</small>
          </div>
        </div>

        <div className="creator-real-metrics" aria-label="Source-keyed creator identity status">
          <IdentityMetric label="ACTIVE SOURCES" value={String(creator.activeSources.length)} />
          <IdentityMetric label="X IDENTITY" value={creator.x?.active ? "ACTIVE" : "NOT ACTIVE"} />
          <IdentityMetric label="FARCASTER IDENTITY" value={creator.farcaster?.active ? "ACTIVE" : "NOT ACTIVE"} />
          <IdentityMetric label="NEXT EXPIRY" value={shortDate(nextExpiry(identities))} />
        </div>
      </article>

      <div className="creator-profile-grid">
        <section className="campaign-detail-panel">
          <div className="detail-panel-head">
            <span>GENLAYER IDENTITY COMMITMENTS</span>
            <strong>{identities.length} SOURCE{identities.length === 1 ? "" : "S"}</strong>
          </div>
          <dl className="commitment-list">
            <Commitment
              label="OWNER WALLET"
              value={creator.ownerWallet}
              link={studioNetExplorerLink("address", creator.ownerWallet) ?? undefined}
            />
            {identities.map((identity) => (
              <Fragment key={identity.source}>
                <div className="source-identity-record">
                  <dt>{identity.source} IDENTITY</dt>
                  <dd><strong>@{identity.handle}</strong> · {identity.active ? "ACTIVE" : "INACTIVE"}</dd>
                </div>
                <Commitment label={`${identity.source} STABLE ID`} value={identity.externalUserId} />
                <Commitment label={`${identity.source} IDENTITY HASH`} value={identity.identityHash} />
                <Commitment label={`${identity.source} OWNERSHIP REQUEST`} value={identity.ownershipRequestId} />
                {identity.activationTxHash ? (
                  <Commitment
                    label={`${identity.source} ACTIVATION TX`}
                    value={identity.activationTxHash}
                    link={studioNetExplorerLink("tx", identity.activationTxHash) ?? undefined}
                  />
                ) : null}
              </Fragment>
            ))}
          </dl>
        </section>

        <aside className="campaign-detail-panel creator-proof-history">
          <div className="detail-panel-head"><span>PROOF HISTORY</span><strong>PUBLIC GENLAYER STATE</strong></div>
          <dl>
            {identities.map((identity) => (
              <div key={identity.source}>
                <dt>{identity.source} PROOF</dt>
                <dd>{formatDate(identity.verifiedAt)} · EXPIRES {formatDate(identity.credentialExpiresAt)}</dd>
              </div>
            ))}
          </dl>
          <p className="panel-empty">
            Audience, engagement, risk, and pay estimates remain hidden until a source-verifiable metrics pipeline is available.
          </p>
        </aside>
      </div>
    </section>
  );
}

function sourceIdentities(creator: PublicCreator): PublicCreatorIdentity[] {
  return [creator.x, creator.farcaster].filter(
    (identity): identity is PublicCreatorIdentity => identity !== null,
  );
}

function Commitment({ label, value, link }: { label: string; value: string; link?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{link ? <a href={link} target="_blank" rel="noreferrer">{value} ↗</a> : <code>{value}</code>}</dd>
    </div>
  );
}

function IdentityMetric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function nextExpiry(identities: PublicCreatorIdentity[]): string | null {
  const expiries = identities
    .filter((identity) => identity.active)
    .map((identity) => identity.credentialExpiresAt)
    .filter((value) => Number.isFinite(new Date(value).getTime()))
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime());
  return expiries[0] ?? null;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "DATE UNAVAILABLE";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function shortDate(value: string | null): string {
  if (!value) return "UNAVAILABLE";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "UNAVAILABLE";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" })
    .format(date)
    .toUpperCase();
}

function identityInitial(value: string): string {
  return value.trim().charAt(0).toUpperCase() || "I";
}
