"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { marketplaceErrorMessage, marketplaceRequest } from "../../marketplace-api";
import {
  campaignStatusLabel,
  deadlineLabel,
  fundingStatusLabel,
  shortenAddress,
  type ApplicationMutationResponse,
  type CampaignDetailResponse,
  type MarketplaceApplication,
  type MarketplaceCampaign,
  type PreparedApplicationMutationResponse,
  usdcAtomsToDisplay,
  usdcInputToAtoms,
} from "../../marketplace-types";
import { useMarketplaceWallet } from "../../use-marketplace-wallet";
import { MarketplaceState } from "../../components/MarketplaceState";
import { CampaignFunding } from "./CampaignFunding";
import { broadcastMarketplaceTransaction } from "../../marketplace-transaction";
import {
  creatorMetricsForWallet,
  type CreatorMetricsLookup,
  useCreatorMetrics,
} from "../../use-creator-metrics";

type DetailState =
  | { phase: "loading"; detail: null; error: null }
  | { phase: "ready"; detail: CampaignDetailResponse; loadedAt: number; error: null }
  | { phase: "error"; detail: null; error: string };

export function CampaignDetail({ campaignId }: { campaignId: string }) {
  const wallet = useMarketplaceWallet();
  const [state, setState] = useState<DetailState>({ phase: "loading", detail: null, error: null });
  const [action, setAction] = useState<{ key: string | null; error: string | null }>({ key: null, error: null });
  const genLayerRetryCount = useRef(0);

  const loadDetail = useCallback(async (signal?: AbortSignal) => {
    try {
      const detail = await marketplaceRequest<CampaignDetailResponse>(
        `/api/marketplace/campaigns/${encodeURIComponent(campaignId)}`,
        { signal },
      );
      setState({
        phase: "ready",
        detail: {
          ...detail,
          applications: Array.isArray(detail.applications) ? detail.applications : [],
          viewerApplication: detail.viewerApplication ?? null,
        },
        loadedAt: Date.now(),
        error: null,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState({ phase: "error", detail: null, error: marketplaceErrorMessage(error) });
    }
  }, [campaignId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadDetail(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadDetail]);

  useEffect(() => {
    if (state.phase !== "ready" || state.detail.campaign.status !== "resolving") return;
    const application = [
      state.detail.viewerApplication,
      ...state.detail.applications,
    ].find((candidate) => Boolean(
      candidate?.requestId && candidate.resolutionRequestTxHash,
    ));
    if (!application) return;
    const terminal = new Set([
      "EXECUTION_FAILED",
      "NETWORK_TERMINATED",
      "RECONCILIATION_REQUIRED",
      "POLLING_EXHAUSTED",
      "POISONED",
    ]).has(application.genlayerSubmitterStatus ?? "");
    if (terminal) return;
    // A finalized Bradbury result is not a finished marketplace payment. Keep
    // retrying this idempotent request until the fenced Base relay is mirrored.
    if (
      application.genlayerSubmitterStatus === "FINALIZED" &&
      application.resolutionTxHash
    ) return;
    const delay = application.genlayerSubmitterStatus
      ? 10_000
      : genLayerRetryCount.current === 0
        ? 0
        : Math.min(30_000, 2_000 * 2 ** Math.min(genLayerRetryCount.current - 1, 4));
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await marketplaceRequest(
            `/api/marketplace/campaigns/${encodeURIComponent(campaignId)}/applications/${encodeURIComponent(application.id)}/resolution/genlayer`,
            { method: "POST", body: "{}" },
          );
          genLayerRetryCount.current = 0;
        } catch (error) {
          genLayerRetryCount.current += 1;
          setAction({ key: null, error: marketplaceErrorMessage(error) });
        } finally {
          await loadDetail();
        }
      })();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [campaignId, loadDetail, state]);

  const metricsWallets = state.phase === "ready"
    ? wallet.address === state.detail.campaign.brandWallet.toLowerCase()
      ? state.detail.applications.map((application) => application.creatorWallet)
      : wallet.address
        ? [wallet.address]
        : []
    : [];
  const creatorMetrics = useCreatorMetrics(metricsWallets);

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction("apply", async () => {
      const creatorWallet = await wallet.authenticate();
      const values = new FormData(event.currentTarget);
      await marketplaceRequest<ApplicationMutationResponse>(
        `/api/marketplace/campaigns/${encodeURIComponent(campaignId)}/applications`,
        {
          method: "POST",
          body: JSON.stringify({
            creatorWallet,
            requestedRateUsdc: usdcInputToAtoms(String(values.get("requestedRateUsdc") ?? "")),
            pitch: String(values.get("pitch") ?? "").trim(),
          }),
        },
      );
    });
  }

  async function select(application: MarketplaceApplication) {
    await runAction(`select:${application.id}`, async () => {
      const brandWallet = await wallet.authenticate();
      if (!wallet.isBaseSepolia) await wallet.switchToBaseSepolia();
      const basePath = `/api/marketplace/campaigns/${encodeURIComponent(campaignId)}/applications/${encodeURIComponent(application.id)}`;
      const prepared = await marketplaceRequest<PreparedApplicationMutationResponse>(
        `${basePath}/select`,
        { method: "POST", body: JSON.stringify({ brandWallet }) },
      );
      const txHash = await broadcastMarketplaceTransaction(prepared.transaction, brandWallet);
      await marketplaceRequest<ApplicationMutationResponse>(
        `${basePath}/select/confirm`,
        { method: "POST", body: JSON.stringify({ brandWallet, txHash }) },
      );
    });
  }

  async function accept(application: MarketplaceApplication) {
    await runAction(`accept:${application.id}`, async () => {
      const creatorWallet = await wallet.authenticate();
      if (!wallet.isBaseSepolia) await wallet.switchToBaseSepolia();
      const basePath = `/api/marketplace/campaigns/${encodeURIComponent(campaignId)}/applications/${encodeURIComponent(application.id)}`;
      const prepared = await marketplaceRequest<PreparedApplicationMutationResponse>(
        `${basePath}/accept`,
        { method: "POST", body: JSON.stringify({ creatorWallet }) },
      );
      const txHash = await broadcastMarketplaceTransaction(prepared.transaction, creatorWallet);
      await marketplaceRequest<ApplicationMutationResponse>(
        `${basePath}/accept/confirm`,
        { method: "POST", body: JSON.stringify({ creatorWallet, txHash }) },
      );
    });
  }

  async function submitEvidence(application: MarketplaceApplication, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(`submit:${application.id}`, async () => {
      const creatorWallet = await wallet.authenticate();
      if (!wallet.isBaseSepolia) await wallet.switchToBaseSepolia();
      const values = new FormData(event.currentTarget);
      const basePath = `/api/marketplace/campaigns/${encodeURIComponent(campaignId)}/applications/${encodeURIComponent(application.id)}/submission`;
      const prepared = await marketplaceRequest<PreparedApplicationMutationResponse>(basePath, {
        method: "POST",
        body: JSON.stringify({
          creatorWallet,
          postUrl: String(values.get("postUrl") ?? "").trim(),
          expectedHandle: application.creatorHandle,
        }),
      });
      const txHash = await broadcastMarketplaceTransaction(prepared.transaction, creatorWallet);
      await marketplaceRequest<ApplicationMutationResponse>(`${basePath}/confirm`, {
        method: "POST",
        body: JSON.stringify({ creatorWallet, txHash }),
      });
    });
  }

  async function requestResolution(application: MarketplaceApplication) {
    await runAction(`resolve:${application.id}`, async () => {
      const actorWallet = await wallet.authenticate();
      if (!wallet.isBaseSepolia) await wallet.switchToBaseSepolia();
      const actorBody = actorWallet === campaign.brandWallet.toLowerCase()
        ? { brandWallet: actorWallet }
        : { creatorWallet: actorWallet };
      const basePath = `/api/marketplace/campaigns/${encodeURIComponent(campaignId)}/applications/${encodeURIComponent(application.id)}/resolution`;
      const prepared = await marketplaceRequest<PreparedApplicationMutationResponse>(basePath, {
        method: "POST",
        body: JSON.stringify(actorBody),
      });
      const txHash = await broadcastMarketplaceTransaction(prepared.transaction, actorWallet);
      await marketplaceRequest<ApplicationMutationResponse>(`${basePath}/confirm`, {
        method: "POST",
        body: JSON.stringify({ ...actorBody, txHash }),
      });
      try {
        await marketplaceRequest(`${basePath}/genlayer`, {
          method: "POST",
          body: "{}",
        });
      } catch (error) {
        // The Base request is already durable. Reload it so the idempotent
        // background retry below can enqueue the exact same request ID.
        await loadDetail();
        throw error;
      }
    });
  }

  async function runAction(key: string, operation: () => Promise<void>) {
    setAction({ key, error: null });
    try {
      await operation();
      await loadDetail();
      setAction({ key: null, error: null });
    } catch (error) {
      setAction({ key: null, error: marketplaceErrorMessage(error) });
    }
  }

  if (state.phase === "loading") {
    return <section className="marketplace-detail-shell"><MarketplaceState kind="loading" title="LOADING BRIEF" message="Reading the campaign and your permitted application view." /></section>;
  }
  if (state.phase === "error") {
    return (
      <section className="marketplace-detail-shell">
        <MarketplaceState
          kind="error"
          title="BRIEF UNAVAILABLE"
          message={state.error}
          onRetry={() => {
            setState({ phase: "loading", detail: null, error: null });
            void loadDetail();
          }}
        />
      </section>
    );
  }

  const { campaign, applications, viewerApplication } = state.detail;
  const isBrand = Boolean(wallet.address && wallet.address === campaign.brandWallet.toLowerCase());
  const canApply = campaign.status === "open" && campaign.fundingStatus === "funded" && !isBrand && !viewerApplication;

  return (
    <section className="marketplace-detail-shell">
      <div className="campaign-detail-head">
        <div>
          <Link className="verify-back" href="/#campaigns">← ALL CAMPAIGNS</Link>
          <p className="eyebrow"><span /> {campaign.id} / {campaignStatusLabel(campaign.status)}</p>
          <h1>{campaign.title}</h1>
          <p>{campaign.description}</p>
          <div className="tag-row">
            <span>{campaign.format.toUpperCase()}</span>
            <span>{campaign.category.toUpperCase()}</span>
            <span>{fundingStatusLabel(campaign.fundingStatus)}</span>
          </div>
        </div>
        <aside className="campaign-terms-card">
          <div><span>BUDGET</span><strong>{usdcAtomsToDisplay(campaign.budgetUsdc)} <small>TEST USDC</small></strong></div>
          <div><span>DEADLINE</span><strong>{deadlineLabel(campaign.deadline, state.loadedAt)}</strong><small>{formatDate(campaign.deadline)}</small></div>
          <div><span>APPLICATIONS</span><strong>{campaign.applicationCount}</strong></div>
          <div><span>BRAND</span><strong>{campaign.brandName ?? shortenAddress(campaign.brandWallet)}</strong><small>{shortenAddress(campaign.brandWallet)}</small></div>
        </aside>
      </div>

      <div className="campaign-detail-grid">
        <div>
          <section className="campaign-detail-panel">
            <div className="detail-panel-head"><span>DELIVERABLES</span><strong>{String(campaign.deliverables.length).padStart(2, "0")} ITEMS</strong></div>
            {campaign.deliverables.length ? (
              <ol className="deliverable-list">
                {campaign.deliverables.map((deliverable, index) => (
                  <li key={`${index}-${deliverable}`}><strong>{String(index + 1).padStart(2, "0")}</strong><span>{deliverable}</span></li>
                ))}
              </ol>
            ) : <p className="panel-empty">No deliverables were returned for this campaign.</p>}
          </section>

          <section className="campaign-detail-panel resolution-criteria-panel">
            <div className="detail-panel-head"><span>COMMITTED RESOLUTION CRITERIA</span><strong>GENLAYER INPUT</strong></div>
            <div className="semantic-brief">
              <span>SEMANTIC BRIEF</span>
              <p>{campaign.semanticBrief}</p>
            </div>
            <div className="criteria-columns">
              <div>
                <span>REQUIRED PHRASES</span>
                {campaign.requiredPhrases.length
                  ? <ul>{campaign.requiredPhrases.map((phrase) => <li key={phrase}>{phrase}</li>)}</ul>
                  : <p>NONE SPECIFIED</p>}
              </div>
              <div>
                <span>FORBIDDEN PHRASES</span>
                {campaign.forbiddenPhrases.length
                  ? <ul>{campaign.forbiddenPhrases.map((phrase) => <li key={phrase}>{phrase}</li>)}</ul>
                  : <p>NONE SPECIFIED</p>}
              </div>
            </div>
            <div className="ad-disclosure-rule">
              <span>AD DISCLOSURE</span>
              <strong>{campaign.requireAdDisclosure ? "REQUIRED" : "NOT REQUIRED"}</strong>
            </div>
          </section>

          {isBrand ? (
            <BrandApplications
              applications={applications}
              campaign={campaign}
              actionKey={action.key}
              loadedAt={state.loadedAt}
              metricsByWallet={creatorMetrics}
              onSelect={select}
              onResolve={requestResolution}
            />
          ) : null}
        </div>

        <aside className="campaign-action-panel">
          <div className="detail-panel-head"><span>YOUR ACTION</span><strong>{wallet.address ? shortenAddress(wallet.address) : "WALLET REQUIRED"}</strong></div>
          {!wallet.address ? (
            <div className="action-intro">
              <h2>CONNECT YOUR WALLET</h2>
              <p>Use the same wallet authorized during X verification. The server rejects a mismatched session.</p>
              <button className="button" type="button" disabled={wallet.authenticating} onClick={() => void wallet.authenticate()}>
                {wallet.authenticating ? "SIGNING IN…" : "CONNECT + SIGN →"}
              </button>
              <Link href="/verify">NEED TO VERIFY? START HERE →</Link>
            </div>
          ) : null}
          {isBrand ? (
            campaign.fundingStatus === "funded" ? (
              <div className="action-intro">
                <p className="card-index">BRAND VIEW</p>
                <h2>REVIEW APPLICATIONS</h2>
                <p>Only the campaign’s owning brand can see the applicant list. Select one creator to continue.</p>
              </div>
            ) : <CampaignFunding campaign={campaign} onFunded={loadDetail} />
          ) : null}
          {wallet.address && viewerApplication ? (
            <CreatorApplication
              application={viewerApplication}
              campaign={campaign}
              actionKey={action.key}
              loadedAt={state.loadedAt}
              onAccept={accept}
              onSubmit={submitEvidence}
              onResolve={requestResolution}
            />
          ) : null}
          {wallet.address && canApply ? (
            <ApplicationForm
              busy={action.key === "apply"}
              metrics={creatorMetricsForWallet(creatorMetrics, wallet.address)}
              onSubmit={apply}
            />
          ) : null}
          {wallet.address && !isBrand && !viewerApplication && !canApply ? (
            <div className="action-intro">
              <h2>APPLICATIONS CLOSED</h2>
              <p>
                Applications are available only when the campaign API reports OPEN and Base funding is explicitly confirmed.
              </p>
            </div>
          ) : null}
          {wallet.authenticated ? (
            <button className="wallet-signout" type="button" onClick={() => void wallet.signOut()}>SWITCH WALLET / SIGN OUT</button>
          ) : null}
          {action.error ? <p className="form-message error" role="alert">{action.error}</p> : null}
          {wallet.walletError ? <p className="form-message error" role="alert">{wallet.walletError}</p> : null}
        </aside>
      </div>
    </section>
  );
}

function ApplicationForm({
  busy,
  metrics,
  onSubmit,
}: {
  busy: boolean;
  metrics: CreatorMetricsLookup;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="application-form" onSubmit={onSubmit}>
      <p className="card-index">CREATOR APPLICATION</p>
      <h2>SET YOUR RATE.</h2>
      <p>Your requested rate is visible to the brand. The evidence-backed estimate is guidance only and never replaces your rate.</p>
      <CreatorRateEstimate lookup={metrics} />
      <label>
        <span>REQUESTED RATE / TEST USDC</span>
        <input name="requestedRateUsdc" inputMode="decimal" pattern="[0-9]+(?:\.[0-9]{1,6})?" placeholder="1200" required />
      </label>
      <label>
        <span>WHY YOU FIT THIS BRIEF</span>
        <textarea name="pitch" minLength={20} maxLength={1_500} rows={7} placeholder="Describe your audience, content angle, and relevant public work." required />
      </label>
      <button className="button" type="submit" disabled={busy}>{busy ? "SUBMITTING…" : "APPLY TO CAMPAIGN →"}</button>
    </form>
  );
}

function CreatorApplication({
  application,
  campaign,
  actionKey,
  loadedAt,
  onAccept,
  onSubmit,
  onResolve,
}: {
  application: MarketplaceApplication;
  campaign: MarketplaceCampaign;
  actionKey: string | null;
  loadedAt: number;
  onAccept: (application: MarketplaceApplication) => Promise<void>;
  onSubmit: (application: MarketplaceApplication, event: FormEvent<HTMLFormElement>) => Promise<void>;
  onResolve: (application: MarketplaceApplication) => Promise<void>;
}) {
  const selected = application.status === "selected" && Boolean(application.selectionTxHash);
  const selectionPending = application.status === "selected" && !application.selectionTxHash;
  const accepted = application.status === "accepted" && Boolean(application.acceptanceTxHash);
  const submitted = accepted && Boolean(application.submissionTxHash);
  const resolving = Boolean(application.requestId && application.resolutionRequestTxHash);
  const heading = resolving
    ? "RESOLUTION REQUESTED."
    : submitted
      ? "WORK SUBMITTED."
      : accepted
        ? "CAMPAIGN ACTIVE."
        : selected
          ? "YOU WERE SELECTED."
          : selectionPending
            ? "SELECTION PENDING."
            : "APPLICATION RECORDED.";
  return (
    <div className="creator-application-summary">
      <p className="card-index">YOUR APPLICATION / {application.status.toUpperCase()}</p>
      <h2>{heading}</h2>
      <dl>
        <div><dt>RATE</dt><dd>{usdcAtomsToDisplay(application.requestedRateUsdc)} TEST USDC</dd></div>
        <div><dt>STATUS</dt><dd>{application.status.toUpperCase()}</dd></div>
      </dl>
      <p>{application.pitch}</p>
      {selectionPending ? <p>The brand must finish the Base Sepolia selection transaction before you can accept.</p> : null}
      <Link className="profile-link" href={`/marketplace/creators/${application.creatorWallet}`}>VIEW PUBLIC PROFILE →</Link>
      {selected ? (
        <button className="button" type="button" disabled={actionKey === `accept:${application.id}`} onClick={() => void onAccept(application)}>
          {actionKey === `accept:${application.id}` ? "ACCEPTING…" : "ACCEPT CAMPAIGN →"}
        </button>
      ) : null}
      {accepted && !submitted && campaign.status === "active" ? (
        <EvidenceSubmissionForm
          application={application}
          busy={actionKey === `submit:${application.id}`}
          onSubmit={onSubmit}
        />
      ) : null}
      {submitted || resolving ? (
        <ResolutionControl
          application={application}
          campaign={campaign}
          actionKey={actionKey}
          loadedAt={loadedAt}
          onResolve={onResolve}
        />
      ) : null}
    </div>
  );
}

function BrandApplications({
  applications,
  campaign,
  actionKey,
  loadedAt,
  metricsByWallet,
  onSelect,
  onResolve,
}: {
  applications: MarketplaceApplication[];
  campaign: MarketplaceCampaign;
  actionKey: string | null;
  loadedAt: number;
  metricsByWallet: Readonly<Record<string, CreatorMetricsLookup>>;
  onSelect: (application: MarketplaceApplication) => Promise<void>;
  onResolve: (application: MarketplaceApplication) => Promise<void>;
}) {
  return (
    <section className="campaign-detail-panel application-list-panel">
      <div className="detail-panel-head"><span>PRIVATE BRAND VIEW</span><strong>{applications.length} APPLICATIONS</strong></div>
      {applications.length === 0 ? <p className="panel-empty">No creator applications have been submitted.</p> : null}
      {applications.map((application) => (
        <article className="brand-application" key={application.id}>
          <div>
            <Link className="profile-link" href={`/marketplace/creators/${application.creatorWallet}`}>
              {application.creatorHandle ?? shortenAddress(application.creatorWallet)}
            </Link>
            <strong>{usdcAtomsToDisplay(application.requestedRateUsdc)} TEST USDC</strong>
          </div>
          <CreatorRateEstimate
            compact
            lookup={creatorMetricsForWallet(metricsByWallet, application.creatorWallet)}
          />
          <p>{application.pitch}</p>
          <div>
            <small>{application.status.toUpperCase()} · {formatDate(application.createdAt)}</small>
            {application.status === "applied" || (application.status === "selected" && !application.selectionTxHash) ? (
              <button className="verify-secondary" type="button" disabled={actionKey === `select:${application.id}`} onClick={() => void onSelect(application)}>
                {actionKey === `select:${application.id}` ? "CONFIRMING ON BASE…" : application.status === "selected" ? "FINISH ONCHAIN SELECTION" : "SELECT CREATOR"}
              </button>
            ) : null}
          </div>
          {application.submissionTxHash ? (
            <ResolutionControl
              application={application}
              campaign={campaign}
              actionKey={actionKey}
              loadedAt={loadedAt}
              onResolve={onResolve}
            />
          ) : null}
        </article>
      ))}
    </section>
  );
}

function CreatorRateEstimate({
  lookup,
  compact = false,
}: {
  lookup: CreatorMetricsLookup;
  compact?: boolean;
}) {
  const className = [
    "creator-rate-estimate",
    compact ? "compact" : "",
    lookup.phase === "current" ? `risk-${lookup.metrics.riskLevel}` : lookup.phase,
  ].filter(Boolean).join(" ");

  if (lookup.phase === "current") {
    const minimum = usdcAtomsToDisplay(lookup.metrics.estimatedPayMinUsdc);
    const maximum = usdcAtomsToDisplay(lookup.metrics.estimatedPayMaxUsdc);
    if (minimum !== "â€”" && maximum !== "â€”") {
      return (
        <div className={className} aria-live="polite">
          <span>ESTIMATED RANGE, CREATOR SETS FINAL RATE</span>
          <strong>{minimum}â€“{maximum} TEST USDC</strong>
          <small>
            {lookup.metrics.riskLevel.toUpperCase()} RISK SIGNAL Â· CURRENT UNTIL {formatDate(lookup.metrics.expiresAt)}
          </small>
        </div>
      );
    }
  }

  const message = lookup.phase === "loading"
    ? "CHECKING CURRENT EVIDENCEâ€¦"
    : lookup.phase === "expired"
      ? "ESTIMATE EXPIRED â€” REFRESH CREATOR METRICS"
      : lookup.phase === "error"
        ? "METRICS TEMPORARILY UNAVAILABLE"
        : "NO CURRENT EVIDENCE-BACKED RANGE";

  return (
    <div className={className} aria-live="polite">
      <span>ESTIMATED RANGE, CREATOR SETS FINAL RATE</span>
      <strong>{message}</strong>
      <small>NO PLACEHOLDER PAY OR RISK FIGURES ARE SHOWN</small>
    </div>
  );
}

function EvidenceSubmissionForm({
  application,
  busy,
  onSubmit,
}: {
  application: MarketplaceApplication;
  busy: boolean;
  onSubmit: (application: MarketplaceApplication, event: FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const handle = application.creatorHandle?.replace(/^@/, "") ?? "";
  const retryUrl = handle && application.xPostId ? `https://x.com/${handle}/status/${application.xPostId}` : "";
  return (
    <form className="evidence-form" onSubmit={(event) => void onSubmit(application, event)}>
      <span>PUBLIC WORK EVIDENCE</span>
      <strong>SUBMIT YOUR X POST.</strong>
      <p>The post URL must belong to your verified @{handle || "handle"}. Your wallet submits only its commitment to Base.</p>
      <label>
        <span>CANONICAL X POST URL</span>
        <input
          type="url"
          name="postUrl"
          defaultValue={retryUrl}
          placeholder={handle ? `https://x.com/${handle}/status/…` : "https://x.com/handle/status/…"}
          autoComplete="url"
          required
        />
      </label>
      <button className="button" type="submit" disabled={busy}>{busy ? "CONFIRMING ON BASE…" : "SUBMIT EVIDENCE →"}</button>
    </form>
  );
}

function ResolutionControl({
  application,
  campaign,
  actionKey,
  loadedAt,
  onResolve,
}: {
  application: MarketplaceApplication;
  campaign: MarketplaceCampaign;
  actionKey: string | null;
  loadedAt: number;
  onResolve: (application: MarketplaceApplication) => Promise<void>;
}) {
  if (application.resolutionOutcome && application.resolutionTxHash) {
    return (
      <div className="resolution-control confirmed">
        <span>FINAL RESOLUTION</span>
        <strong>{application.resolutionOutcome.toUpperCase()}</strong>
        <p>Campaign state: {campaign.status.toUpperCase()}. This reflects the recorded Base settlement event.</p>
        <a href={`https://sepolia.basescan.org/tx/${application.resolutionTxHash}`} target="_blank" rel="noreferrer">VIEW SETTLEMENT TX →</a>
        {application.claimTxHash ? (
          <a href={`https://sepolia.basescan.org/tx/${application.claimTxHash}`} target="_blank" rel="noreferrer">VIEW WITHDRAWAL TX →</a>
        ) : null}
      </div>
    );
  }
  if (application.requestId && application.resolutionRequestTxHash) {
    const submitterStatus = application.genlayerSubmitterStatus;
    const outcome = application.genlayerResultOutcome;
    return (
      <div className="resolution-control confirmed">
        <span>GENLAYER REQUEST</span>
        <strong>{submitterStatus === "FINALIZED" && outcome
          ? `${outcome.toUpperCase()} FINALIZED`
          : submitterStatus
            ? submitterStatus.replaceAll("_", " ")
            : "QUEUEING RESOLUTION"}</strong>
        <code>{application.requestId}</code>
        {application.genlayerTxHash ? <code>{application.genlayerTxHash}</code> : null}
        {application.genlayerErrorCode ? <p>Submitter status: {application.genlayerErrorCode}</p> : null}
        <a href={`https://sepolia.basescan.org/tx/${application.resolutionRequestTxHash}`} target="_blank" rel="noreferrer">VIEW BASE REQUEST TX →</a>
      </div>
    );
  }
  if (!application.submissionTxHash || campaign.status !== "submitted" || !application.submittedAt) return null;
  const availableAt = new Date(application.submittedAt).getTime() + Number(campaign.retentionSeconds) * 1_000;
  const ready = Number.isFinite(availableAt) && availableAt <= loadedAt;
  const availableLabel = Number.isFinite(availableAt)
    ? formatDate(new Date(availableAt).toISOString())
    : "DATE UNAVAILABLE";
  return (
    <div className="resolution-control">
      <span>GENLAYER RESOLUTION</span>
      <strong>{ready ? "READY TO RESOLVE." : "RETENTION WINDOW ACTIVE."}</strong>
      <p>{ready
        ? "The brand or creator may now request the onchain resolution round."
        : `Resolution unlocks ${availableLabel}.`}</p>
      <button className="verify-secondary" type="button" disabled={!ready || actionKey === `resolve:${application.id}`} onClick={() => void onResolve(application)}>
        {actionKey === `resolve:${application.id}` ? "REQUESTING…" : "REQUEST RESOLUTION"}
      </button>
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "DATE UNAVAILABLE";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
