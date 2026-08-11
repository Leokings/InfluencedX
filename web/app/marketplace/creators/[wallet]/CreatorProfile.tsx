"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  MarketplaceApiError,
  marketplaceErrorMessage,
  marketplaceRequest,
} from "../../marketplace-api";
import { shortenAddress, usdcAtomsToDisplay } from "../../marketplace-types";
import { MarketplaceState } from "../../components/MarketplaceState";
import { useMarketplaceWallet } from "../../use-marketplace-wallet";
import type { MarketplaceMetricsRefreshProjection } from "@/lib/marketplace-metrics-service";
import type { MarketplaceCreatorProfileDto } from "@/lib/marketplace-types";

type PublicCreator = MarketplaceCreatorProfileDto & {
  verificationTxHash?: string | null;
};

type CreatorState =
  | { phase: "loading"; creator: null; error: null }
  | { phase: "ready"; creator: PublicCreator; loadedAt: number; error: null }
  | { phase: "error"; creator: null; error: string };

type MetricsRefreshState =
  | { phase: "idle"; submission: null; error: null }
  | { phase: "authorizing" | "dispatching"; submission: null; error: null }
  | { phase: "polling"; submission: MarketplaceMetricsRefreshProjection | null; error: null }
  | { phase: "complete"; submission: MarketplaceMetricsRefreshProjection; error: null }
  | { phase: "error"; submission: MarketplaceMetricsRefreshProjection | null; error: string };

const TERMINAL_METRICS_STATUSES = new Set([
  "FINALIZED",
  "PRECHECK_FAILED",
  "EXECUTION_FAILED",
  "NETWORK_TERMINATED",
  "RECONCILIATION_REQUIRED",
  "POLLING_EXHAUSTED",
  "POISONED",
]);

export function CreatorProfile({ wallet }: { wallet: string }) {
  const marketplaceWallet = useMarketplaceWallet();
  const [state, setState] = useState<CreatorState>({ phase: "loading", creator: null, error: null });
  const [metricsRefresh, setMetricsRefresh] = useState<MetricsRefreshState>({
    phase: "idle",
    submission: null,
    error: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void marketplaceRequest<{ creator: PublicCreator }>(
        `/api/marketplace/creators/${encodeURIComponent(wallet)}`,
        { signal: controller.signal },
      ).then(({ creator }) => {
        setState({ phase: "ready", creator, loadedAt: Date.now(), error: null });
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

  const applyMetricsProjection = useCallback((submission: MarketplaceMetricsRefreshProjection) => {
    if (submission.metrics) {
      setState((current) => current.phase === "ready"
        ? {
            ...current,
            creator: { ...current.creator, metrics: submission.metrics },
            loadedAt: Date.now(),
          }
        : current);
    }
    const terminal = TERMINAL_METRICS_STATUSES.has(submission.status);
    const successful = submission.status === "FINALIZED" && submission.resultOutcome === "VERIFIED";
    setMetricsRefresh(terminal
      ? successful
        ? { phase: "complete", submission, error: null }
        : {
            phase: "error",
            submission,
            error: submission.errorCode
              ? `Metrics resolution stopped: ${submission.errorCode}.`
              : `Metrics resolution finished with ${submission.resultOutcome ?? submission.status}.`,
          }
      : { phase: "polling", submission, error: null });
  }, []);

  const pollMetrics = useCallback(async () => {
    const response = await marketplaceRequest<{ submission: MarketplaceMetricsRefreshProjection }>(
      `/api/marketplace/creators/${encodeURIComponent(wallet)}/metrics`,
    );
    applyMetricsProjection(response.submission);
  }, [applyMetricsProjection, wallet]);

  useEffect(() => {
    if (metricsRefresh.phase !== "polling") return undefined;
    const timer = window.setTimeout(() => {
      void pollMetrics().catch((error) => {
        setMetricsRefresh((current) => ({
          phase: "error",
          submission: current.submission,
          error: marketplaceErrorMessage(error),
        }));
      });
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [metricsRefresh.phase, metricsRefresh.submission?.status, pollMetrics]);

  const refreshMetrics = useCallback(async () => {
    setMetricsRefresh({ phase: "authorizing", submission: null, error: null });
    try {
      let selected = marketplaceWallet.address;
      if (!selected) selected = await marketplaceWallet.connect();
      if (selected.toLowerCase() !== wallet.toLowerCase()) {
        throw new Error("Connect the wallet that owns this verified creator profile.");
      }
      if (!marketplaceWallet.authenticated) {
        await marketplaceWallet.authenticate();
      }
      setMetricsRefresh({ phase: "dispatching", submission: null, error: null });
      const response = await marketplaceRequest<{ submission: MarketplaceMetricsRefreshProjection }>(
        `/api/marketplace/creators/${encodeURIComponent(wallet)}/metrics`,
        { method: "POST", body: "{}" },
      );
      applyMetricsProjection(response.submission);
    } catch (error) {
      if (
        error instanceof MarketplaceApiError &&
        error.code === "GENLAYER_SUBMISSION_OUTCOME_UNKNOWN"
      ) {
        setMetricsRefresh({
          phase: "polling",
          submission: null,
          error: null,
        });
        return;
      }
      setMetricsRefresh({
        phase: "error",
        submission: null,
        error: marketplaceErrorMessage(error),
      });
    }
  }, [applyMetricsProjection, marketplaceWallet, wallet]);

  if (state.phase === "loading") {
    return <section className="creator-profile-shell"><MarketplaceState kind="loading" title="LOADING CREATOR" message="Reading the active public profile and current evidence-backed metrics." /></section>;
  }
  if (state.phase === "error") {
    return <section className="creator-profile-shell"><MarketplaceState kind="error" title="PROFILE NOT AVAILABLE" message={state.error} action={{ href: "/verify", label: "VERIFY A CREATOR" }} /></section>;
  }

  const creator = state.creator;
  const metricsCurrent = Boolean(creator.metrics && new Date(creator.metrics.expiresAt).getTime() > state.loadedAt);
  const verificationTransaction = validTransactionHash(creator.verificationTxHash) ? creator.verificationTxHash : null;
  const identityLabel = creator.displayName ?? creator.publicHandle ?? shortenAddress(creator.ownerWallet);

  return (
    <section className="creator-profile-shell">
      <Link className="verify-back" href="/#creators">← CREATOR BOARD</Link>
      <article className="creator-profile-hero">
        <div className="creator-identity-hero">
          <div className="creator-avatar-tile" aria-hidden="true">{identityInitial(identityLabel)}</div>
          <div className="creator-hero-copy">
            <p>BASE PROFILE {creator.baseProfileId}</p>
            <h1>{identityLabel}</h1>
            <strong>{creator.publicHandle ? `@${creator.publicHandle.replace(/^@/, "")}` : "PUBLIC HANDLE HIDDEN"}</strong>
            {creator.bio ? <span>{creator.bio}</span> : null}
            <div className="tag-row">
              {creator.categories.map((category) => <span key={category}>{category.toUpperCase()}</span>)}
            </div>
          </div>
          <div className="creator-verification-badge">
            <i />
            <span>BASE VERIFIED</span>
            <small>ACTIVE · EXPIRES {shortDate(creator.credentialExpiresAt)}</small>
          </div>
        </div>

        <div className="creator-real-metrics" aria-label="Current evidence-backed creator metrics">
          {metricsCurrent && creator.metrics ? (
            <>
              <Metric label="FOLLOWERS" value={countLabel(creator.metrics.followersCount)} />
              <Metric label="ACCOUNT AGE" value={accountAge(creator.metrics.accountCreatedAt, state.loadedAt)} />
              <Metric label="MEDIAN ENGAGEMENT" value={countLabel(creator.metrics.medianEngagementCount)} />
              <Metric label="ESTIMATED PAY" value={`${usdcAtomsToDisplay(creator.metrics.estimatedPayMinUsdc)}–${usdcAtomsToDisplay(creator.metrics.estimatedPayMaxUsdc)} USDC`} />
            </>
          ) : (
            <div className="creator-metrics-unavailable">
              <span>PUBLIC METRICS</span>
              <strong>NO CURRENT EVIDENCE-BACKED SNAPSHOT</strong>
              <p>InfluencedX does not display placeholder audience, engagement, or pay figures.</p>
            </div>
          )}
        </div>
        <div className="creator-metrics-control" aria-live="polite">
          <div>
            <span>GENLAYER METRICS</span>
            <strong>{metricsRefreshLabel(metricsRefresh)}</strong>
            <p>{metricsRefresh.error ?? metricsRefreshMessage(metricsRefresh)}</p>
          </div>
          <button
            className="button button-small"
            type="button"
            disabled={metricsRefresh.phase === "authorizing" || metricsRefresh.phase === "dispatching" || metricsRefresh.phase === "polling"}
            onClick={() => void refreshMetrics()}
          >
            {metricsRefresh.phase === "authorizing"
              ? "AUTHORIZING..."
              : metricsRefresh.phase === "dispatching"
                ? "QUEUING..."
                : metricsRefresh.phase === "polling"
                  ? "RESOLVING..."
                  : metricsCurrent
                    ? "REFRESH METRICS ->"
                    : "VERIFY METRICS ->"}
          </button>
        </div>
      </article>

      <div className="creator-profile-grid">
        <section className="campaign-detail-panel">
          <div className="detail-panel-head"><span>BASE IDENTITY COMMITMENTS</span><strong>PROFILE {creator.baseProfileId}</strong></div>
          <dl className="commitment-list">
            <Commitment label="OWNER WALLET" value={creator.ownerWallet} link={`https://sepolia.basescan.org/address/${creator.ownerWallet}`} />
            <Commitment label="IDENTITY HASH" value={creator.identityHash} />
            <Commitment label="X HANDLE HASH" value={creator.handleHash} />
            <Commitment label="VERIFICATION POST HASH" value={creator.verificationPostHash} />
            {verificationTransaction ? (
              <Commitment label="BASE REGISTRATION TX" value={verificationTransaction} link={`https://sepolia.basescan.org/tx/${verificationTransaction}`} />
            ) : null}
          </dl>
        </section>

        <aside className="campaign-detail-panel creator-proof-history">
          <div className="detail-panel-head"><span>PROOF HISTORY</span><strong>PUBLIC RECORD</strong></div>
          <dl>
            <div><dt>OWNERSHIP VERIFIED</dt><dd>{formatDate(creator.verifiedAt)}</dd></div>
            <div><dt>CREDENTIAL EXPIRES</dt><dd>{formatDate(creator.credentialExpiresAt)}</dd></div>
            {metricsCurrent && creator.metrics ? (
              <>
                <div><dt>METRICS CAPTURED</dt><dd>{formatDate(creator.metrics.capturedAt)}</dd></div>
                <div><dt>METRICS EXPIRE</dt><dd>{formatDate(creator.metrics.expiresAt)}</dd></div>
                <div><dt>ENGAGEMENT RATE</dt><dd>{(creator.metrics.engagementRateBps / 100).toFixed(2)}%</dd></div>
                <div><dt>RISK SIGNAL</dt><dd>{creator.metrics.riskLevel.toUpperCase()}</dd></div>
                <div><dt>METRICS EVIDENCE</dt><dd><code>{creator.metrics.evidenceHash}</code></dd></div>
              </>
            ) : null}
          </dl>
        </aside>
      </div>
    </section>
  );
}

function metricsRefreshLabel(state: MetricsRefreshState): string {
  if (state.phase === "idle") return "OWNER-CONTROLLED REFRESH";
  if (state.phase === "authorizing") return "AUTHORIZING PROFILE OWNER";
  if (state.phase === "dispatching") return "QUEUING SNAPSHOT_METRICS";
  if (state.phase === "complete") return "FINALIZED / VERIFIED";
  if (state.phase === "error") return "REFRESH NEEDS ATTENTION";
  return state.submission?.status.replaceAll("_", " ") ?? "RECONCILING SUBMISSION";
}

function metricsRefreshMessage(state: MetricsRefreshState): string {
  if (state.phase === "idle") {
    return "The profile owner can request a fresh public X snapshot. Audience and engagement counts come only from the finalized GenLayer result.";
  }
  if (state.phase === "complete") {
    return "Fresh sanitized metrics and the result evidence hash are now published on this profile.";
  }
  if (state.phase === "polling") {
    return state.submission
      ? `Idempotently checking ${state.submission.requestId.slice(0, 10)}... on GenLayer Bradbury.`
      : "The dispatch outcome was ambiguous; checking the deterministic job ID before any retry.";
  }
  return "No caller-supplied follower, engagement, risk, or pay values are accepted.";
}

function Commitment({ label, value, link }: { label: string; value: string; link?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{link ? <a href={link} target="_blank" rel="noreferrer">{value} ↗</a> : <code>{value}</code>}</dd>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "DATE UNAVAILABLE";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function accountAge(value: string, nowMs: number): string {
  const createdAt = new Date(value).getTime();
  if (!Number.isFinite(createdAt) || createdAt > nowMs) return "UNAVAILABLE";
  const days = Math.floor((nowMs - createdAt) / 86_400_000);
  if (days < 60) return `${days} DAYS`;
  if (days < 730) return `${Math.floor(days / 30)} MONTHS`;
  return `${(days / 365).toFixed(1)} YEARS`;
}

function countLabel(value: string): string {
  return /^\d+$/.test(value) ? new Intl.NumberFormat("en-US").format(BigInt(value)) : "UNAVAILABLE";
}

function validTransactionHash(value: string | null | undefined): value is string {
  return Boolean(value && /^0x[\da-f]{64}$/i.test(value));
}

function identityInitial(value: string): string {
  return value.trim().charAt(0).toUpperCase() || "X";
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "UNAVAILABLE";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(date).toUpperCase();
}
