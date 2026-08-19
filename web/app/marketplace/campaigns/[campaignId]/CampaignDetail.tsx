"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { MarketplaceState } from "../../components/MarketplaceState";
import { marketplaceErrorMessage, marketplaceRequest } from "../../marketplace-api";
import {
  broadcastMarketplaceTransaction,
  type GenLayerTransactionStage,
  type UserMarketplaceFunctionName,
} from "../../marketplace-transaction";
import {
  applicationRateAtoms,
  campaignBudgetAtoms,
  campaignContentSource,
  campaignStatusLabel,
  contentSourceLabel,
  deadlineLabel,
  fundingStatusLabel,
  genAtomsToDisplay,
  genInputToAtoms,
  type CampaignDetailResponse,
  type MarketplaceApplication,
  type MarketplaceCampaign,
  type MarketplaceSettlementStateDto,
  type MarketplaceTransactionDto,
  shortenAddress,
  studioNetExplorerLink,
} from "../../marketplace-types";
import { useMarketplaceWallet } from "../../use-marketplace-wallet";
import { CampaignFunding } from "./CampaignFunding";

type DetailState =
  | { phase: "loading"; detail: null; error: null }
  | { phase: "ready"; detail: CampaignDetailResponse; loadedAt: number; error: null }
  | { phase: "error"; detail: null; error: string };

type PreparedMutation = {
  preparedId: string;
  transaction: MarketplaceTransactionDto;
  campaign?: MarketplaceCampaign;
  application?: MarketplaceApplication;
};

type Recovery = { preparedId: string; txHash: string; confirmPath: string };

export function CampaignDetail({ campaignId }: { campaignId: string }) {
  const wallet = useMarketplaceWallet();
  const [state, setState] = useState<DetailState>({ phase: "loading", detail: null, error: null });
  const [action, setAction] = useState<{ key: string | null; notice: string | null; error: string | null }>({ key: null, notice: null, error: null });
  const [recoveries, setRecoveries] = useState<Record<string, Recovery>>(() => loadRecoveries(campaignId));

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
    if (state.phase !== "ready" || !["funding", "open"].includes(state.detail.campaign.status)) return;
    const timer = window.setInterval(() => void loadDetail(), 12_000);
    return () => window.clearInterval(timer);
  }, [loadDetail, state]);

  async function executePrepared(input: {
    key: string;
    expectedFunctionName: UserMarketplaceFunctionName;
    preparePath: string;
    confirmPath?: string | ((prepared: PreparedMutation) => string);
    body?: Record<string, unknown>;
  }) {
    setAction({ key: input.key, notice: "Preparing the exact StudioNet action…", error: null });
    try {
      const actor = await wallet.authenticate();
      if (!wallet.isStudioNet) await wallet.switchToStudioNet();
      const existing = recoveries[input.key];
      if (existing) {
        setAction({ key: input.key, notice: "Reconciling the previously submitted transaction…", error: null });
        await marketplaceRequest(existing.confirmPath, {
          method: "POST",
          body: JSON.stringify({ preparedId: existing.preparedId, txHash: existing.txHash }),
        });
        clearRecovery(input.key);
        await loadDetail();
        setAction({ key: null, notice: "Finalized contract state reconciled.", error: null });
        return;
      }
      const prepared = await marketplaceRequest<PreparedMutation>(input.preparePath, {
        method: "POST",
        body: JSON.stringify(input.body ?? {}),
      });
      const confirmPath = typeof input.confirmPath === "function"
        ? input.confirmPath(prepared)
        : input.confirmPath ?? `${input.preparePath}/confirm`;
      const txHash = await broadcastMarketplaceTransaction(prepared.transaction, actor, {
        expectedFunctionName: input.expectedFunctionName,
        expectedValue: "0",
        onSubmitted: (hash) => saveRecovery(input.key, { preparedId: prepared.preparedId, txHash: hash, confirmPath }),
        onStage: (stage) => setAction({ key: input.key, notice: transactionNotice(stage), error: null }),
      });
      setAction({ key: input.key, notice: "Validator finality reached. Verifying authoritative contract state…", error: null });
      await marketplaceRequest(confirmPath, {
        method: "POST",
        body: JSON.stringify({ preparedId: prepared.preparedId, txHash }),
      });
      clearRecovery(input.key);
      await loadDetail();
      setAction({ key: null, notice: "StudioNet action finalized and recorded.", error: null });
    } catch (error) {
      setAction({ key: null, notice: null, error: marketplaceErrorMessage(error) });
    }
  }

  function saveRecovery(key: string, recovery: Recovery) {
    setRecoveries((current) => ({ ...current, [key]: recovery }));
    window.sessionStorage.setItem(recoveryStorageKey(campaignId, key), JSON.stringify(recovery));
  }

  function clearRecovery(key: string) {
    setRecoveries((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    window.sessionStorage.removeItem(recoveryStorageKey(campaignId, key));
  }

  async function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await executePrepared({
      key: "apply",
      expectedFunctionName: "apply_to_campaign",
      preparePath: `/api/marketplace/campaigns/${encodeURIComponent(campaignId)}/applications`,
      confirmPath: (prepared) => {
        if (!prepared.application?.id) throw new Error("The prepared application is missing its durable ID.");
        return `/api/marketplace/campaigns/${encodeURIComponent(campaignId)}/applications/${encodeURIComponent(prepared.application.id)}/apply/confirm`;
      },
      body: {
        creatorWallet: wallet.address,
        requestedRateGen: genInputToAtoms(String(values.get("requestedRateGen") ?? "")),
        pitch: String(values.get("pitch") ?? "").trim(),
      },
    });
  }

  async function select(application: MarketplaceApplication) {
    const basePath = applicationPath(campaignId, application.id);
    await executePrepared({ key: `select:${application.id}`, expectedFunctionName: "select_creator", preparePath: `${basePath}/select`, confirmPath: `${basePath}/selection` });
  }

  async function accept(application: MarketplaceApplication) {
    const basePath = applicationPath(campaignId, application.id);
    await executePrepared({ key: `accept:${application.id}`, expectedFunctionName: "accept_assignment", preparePath: `${basePath}/accept`, confirmPath: `${basePath}/acceptance` });
  }

  async function decline(application: MarketplaceApplication) {
    const basePath = applicationPath(campaignId, application.id);
    await executePrepared({ key: `decline:${application.id}`, expectedFunctionName: "decline_assignment", preparePath: `${basePath}/decline` });
  }

  async function withdrawApplication(application: MarketplaceApplication) {
    const basePath = applicationPath(campaignId, application.id);
    await executePrepared({ key: `withdraw:${application.id}`, expectedFunctionName: "withdraw_application", preparePath: `${basePath}/withdraw` });
  }

  async function submitEvidence(application: MarketplaceApplication, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const basePath = `${applicationPath(campaignId, application.id)}/submission`;
    const contentSource = application.contentSource;
    await executePrepared({
      key: `submit:${application.id}`,
      expectedFunctionName: "submit_evidence",
      preparePath: basePath,
      body: {
        contentId: String(values.get("contentId") ?? "").trim(),
        contentSource,
        expectedHandle: application.creatorHandle,
      },
    });
  }

  async function requestResolution(application: MarketplaceApplication) {
    const basePath = `${applicationPath(campaignId, application.id)}/resolution`;
    await executePrepared({ key: `resolve:${application.id}`, expectedFunctionName: "resolve_assignment", preparePath: basePath });
  }

  async function refundUndetermined(application: MarketplaceApplication) {
    const basePath = `${applicationPath(campaignId, application.id)}/resolution/refund-undetermined`;
    await executePrepared({ key: `refund:${application.id}`, expectedFunctionName: "refund_undetermined", preparePath: basePath });
  }

  async function cancelCampaign() {
    const basePath = `/api/marketplace/campaigns/${encodeURIComponent(campaignId)}/cancel`;
    await executePrepared({ key: "cancel", expectedFunctionName: "cancel_campaign", preparePath: basePath });
  }

  if (state.phase === "loading") {
    return <section className="marketplace-detail-shell"><MarketplaceState kind="loading" title="LOADING BRIEF" message="Reading the campaign and your permitted application view." /></section>;
  }
  if (state.phase === "error") {
    return (
      <section className="marketplace-detail-shell">
        <MarketplaceState kind="error" title="BRIEF UNAVAILABLE" message={state.error} onRetry={() => void loadDetail()} />
      </section>
    );
  }

  const { campaign, applications, viewerApplication } = state.detail;
  const contentSource = campaignContentSource(campaign);
  const isBrand = Boolean(wallet.address && wallet.address === campaign.brandWallet.toLowerCase());
  const canApply = campaign.status === "open" && campaign.fundingStatus === "funded" && !isBrand && !viewerApplication;
  const canCancel = isBrand && ["funding", "open"].includes(campaign.status);

  return (
    <section className="marketplace-detail-shell">
      <div className="campaign-detail-head">
        <div>
          <Link className="verify-back" href="/#campaigns">← ALL CAMPAIGNS</Link>
          <p className="eyebrow"><span /> {campaign.id} / {campaignStatusLabel(campaign.status)}</p>
          <h1>{campaign.title}</h1>
          <p>{campaign.description}</p>
          <div className="tag-row"><span>{contentSourceLabel(contentSource)} POST</span><span>{campaign.category.toUpperCase()}</span><span>{fundingStatusLabel(campaign.fundingStatus)}</span></div>
        </div>
        <aside className="campaign-terms-card">
          <div><span>BUDGET</span><strong>{genAtomsToDisplay(campaignBudgetAtoms(campaign))} <small>TEST GEN</small></strong></div>
          <div><span>DEADLINE</span><strong>{deadlineLabel(campaign.deadline, state.loadedAt)}</strong><small>{formatDate(campaign.deadline)}</small></div>
          <div><span>APPLICATIONS</span><strong>{campaign.applicationCount}</strong></div>
          <div><span>BRAND</span><strong>{campaign.brandName ?? shortenAddress(campaign.brandWallet)}</strong><small>{shortenAddress(campaign.brandWallet)}</small></div>
        </aside>
      </div>

      <div className="campaign-detail-grid">
        <div>
          <section className="campaign-detail-panel">
            <div className="detail-panel-head"><span>{contentSourceLabel(contentSource)} POST DELIVERABLES</span><strong>{String(campaign.deliverables.length).padStart(2, "0")} ITEMS</strong></div>
            {campaign.deliverables.length ? <ol className="deliverable-list">{campaign.deliverables.map((deliverable, index) => <li key={`${index}-${deliverable}`}><strong>{String(index + 1).padStart(2, "0")}</strong><span>{deliverable}</span></li>)}</ol> : <p className="panel-empty">No deliverables were returned.</p>}
          </section>
          <ResolutionCriteria campaign={campaign} />
          {isBrand ? (
            <BrandApplications
              applications={applications}
              actionKey={action.key}
              onSelect={select}
              onResolve={requestResolution}
            />
          ) : null}
        </div>

        <aside className="campaign-action-panel">
          <div className="detail-panel-head"><span>YOUR ACTION</span><strong>{wallet.address ? shortenAddress(wallet.address) : "WALLET REQUIRED"}</strong></div>
          {!wallet.address ? <WalletIntro wallet={wallet} /> : null}
          {isBrand && campaign.fundingStatus !== "funded" ? <CampaignFunding campaign={campaign} onFunded={loadDetail} /> : null}
          {isBrand && campaign.fundingStatus === "funded" ? <div className="action-intro"><p className="card-index">BRAND VIEW</p><h2>REVIEW APPLICATIONS</h2><p>Select a creator or manage the campaign’s remaining native GEN.</p></div> : null}
          {wallet.address && viewerApplication ? (
            <CreatorApplication
              application={viewerApplication as MarketplaceApplication}
              campaign={campaign}
              actionKey={action.key}
              loadedAt={state.loadedAt}
              onAccept={accept}
              onDecline={decline}
              onWithdraw={withdrawApplication}
              onSubmit={submitEvidence}
              onResolve={requestResolution}
              onRefund={refundUndetermined}
            />
          ) : null}
          {wallet.address && canApply ? <ApplicationForm busy={action.key === "apply"} contentSource={contentSource} onSubmit={apply} /> : null}
          {wallet.address && !isBrand && !viewerApplication && !canApply ? <div className="action-intro"><h2>APPLICATIONS CLOSED</h2><p>Applications open only after the GEN deposit is finalized and while the campaign remains OPEN.</p></div> : null}
          {wallet.authenticated && campaign.fundingStatus === "funded" && (isBrand || viewerApplication) ? <SettlementControls campaign={campaign} wallet={wallet} onUpdated={loadDetail} /> : null}
          {canCancel ? <button className="recovery-retry" type="button" disabled={action.key === "cancel"} onClick={() => void cancelCampaign()}>{action.key === "cancel" ? "CANCELLING…" : "CANCEL + REFUND CAMPAIGN"}</button> : null}
          {action.notice ? <p className="form-message" role="status">{action.notice}</p> : null}
          {action.error ? <p className="form-message error" role="alert">{action.error}</p> : null}
          {Object.keys(recoveries).length ? <button className="recovery-retry" type="button" onClick={() => Object.keys(recoveries).forEach(clearRecovery)}>PRIOR TX FAILED — PREPARE A NEW ACTION</button> : null}
          {wallet.walletError ? <p className="form-message error" role="alert">{wallet.walletError}</p> : null}
          {wallet.hasSession ? <button className="wallet-signout" type="button" onClick={() => void wallet.signOut()}>SWITCH WALLET / SIGN OUT</button> : null}
        </aside>
      </div>
    </section>
  );
}

function ResolutionCriteria({ campaign }: { campaign: MarketplaceCampaign }) {
  return (
    <section className="campaign-detail-panel resolution-criteria-panel">
      <div className="detail-panel-head"><span>COMMITTED RESOLUTION CRITERIA</span><strong>GENLAYER INPUT</strong></div>
      <div className="semantic-brief"><span>SEMANTIC BRIEF</span><p>{campaign.semanticBrief}</p></div>
      <div className="criteria-columns">
        <div><span>REQUIRED PHRASES</span>{campaign.requiredPhrases.length ? <ul>{campaign.requiredPhrases.map((phrase) => <li key={phrase}>{phrase}</li>)}</ul> : <p>NONE SPECIFIED</p>}</div>
        <div><span>FORBIDDEN PHRASES</span>{campaign.forbiddenPhrases.length ? <ul>{campaign.forbiddenPhrases.map((phrase) => <li key={phrase}>{phrase}</li>)}</ul> : <p>NONE SPECIFIED</p>}</div>
      </div>
      <div className="ad-disclosure-rule"><span>AD DISCLOSURE</span><strong>{campaign.requireAdDisclosure ? "REQUIRED" : "NOT REQUIRED"}</strong></div>
    </section>
  );
}

function WalletIntro({ wallet }: { wallet: ReturnType<typeof useMarketplaceWallet> }) {
  return (
    <div className="action-intro">
      <h2>CONNECT YOUR WALLET</h2>
      <p>Use the StudioNet wallet linked to your InfluencedX creator or brand activity.</p>
      <button className="button" type="button" disabled={wallet.authenticating} onClick={() => void wallet.authenticate()}>{wallet.authenticating ? "SIGNING IN…" : "CONNECT + SIGN →"}</button>
      <Link href="/verify">NEED TO VERIFY? START HERE →</Link>
    </div>
  );
}

function ApplicationForm({ busy, contentSource, onSubmit }: { busy: boolean; contentSource: "X" | "FARCASTER"; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <form className="application-form" onSubmit={onSubmit}>
      <p className="card-index">CREATOR APPLICATION</p><h2>SET YOUR RATE.</h2>
      <p>Your requested GEN rate is visible to the brand. An active {contentSourceLabel(contentSource)} identity is required. Set the final rate yourself.</p>
      <label><span>REQUESTED RATE / TEST GEN</span><input name="requestedRateGen" inputMode="decimal" pattern="[0-9]+(?:\.[0-9]{1,18})?" placeholder="1200" required /></label>
      <label><span>WHY YOU FIT THIS BRIEF</span><textarea name="pitch" minLength={20} maxLength={1_500} rows={7} placeholder="Describe your audience, content angle, and relevant public work." required /></label>
      <button className="button" type="submit" disabled={busy}>{busy ? "WAITING FOR FINALITY…" : "APPLY ON GENLAYER →"}</button>
    </form>
  );
}

function CreatorApplication({ application, campaign, actionKey, loadedAt, onAccept, onDecline, onWithdraw, onSubmit, onResolve, onRefund }: {
  application: MarketplaceApplication;
  campaign: MarketplaceCampaign;
  actionKey: string | null;
  loadedAt: number;
  onAccept: (application: MarketplaceApplication) => Promise<void>;
  onDecline: (application: MarketplaceApplication) => Promise<void>;
  onWithdraw: (application: MarketplaceApplication) => Promise<void>;
  onSubmit: (application: MarketplaceApplication, event: FormEvent<HTMLFormElement>) => Promise<void>;
  onResolve: (application: MarketplaceApplication) => Promise<void>;
  onRefund: (application: MarketplaceApplication) => Promise<void>;
}) {
  const selected = application.status === "selected";
  const accepted = application.status === "accepted";
  const submitted = Boolean(application.submissionTxHash || application.contentId);
  return (
    <div className="creator-application-summary">
      <p className="card-index">YOUR APPLICATION / {application.status.toUpperCase()}</p>
      <h2>{submitted ? "WORK SUBMITTED." : accepted ? "CAMPAIGN ACTIVE." : selected ? "YOU WERE SELECTED." : "APPLICATION RECORDED."}</h2>
      <dl><div><dt>RATE</dt><dd>{genAtomsToDisplay(applicationRateAtoms(application))} TEST GEN</dd></div><div><dt>STATUS</dt><dd>{application.status.toUpperCase()}</dd></div></dl>
      <p>{application.pitch}</p>
      <Link className="profile-link" href={`/marketplace/creators/${application.creatorWallet}`}>VIEW PUBLIC PROFILE →</Link>
      {application.status === "applied" ? <button className="recovery-retry" type="button" disabled={actionKey === `withdraw:${application.id}`} onClick={() => void onWithdraw(application)}>WITHDRAW APPLICATION</button> : null}
      {selected ? <><button className="button" type="button" disabled={actionKey === `accept:${application.id}`} onClick={() => void onAccept(application)}>ACCEPT CAMPAIGN →</button><button className="recovery-retry" type="button" disabled={actionKey === `decline:${application.id}`} onClick={() => void onDecline(application)}>DECLINE ASSIGNMENT</button></> : null}
      {accepted && !submitted && campaign.status === "open" ? <EvidenceSubmissionForm application={application} campaign={campaign} busy={actionKey === `submit:${application.id}`} onSubmit={onSubmit} /> : null}
      {submitted || application.resolutionOutcome ? <ResolutionControl application={application} campaign={campaign} actionKey={actionKey} loadedAt={loadedAt} onResolve={onResolve} onRefund={onRefund} /> : null}
    </div>
  );
}

function BrandApplications({ applications, actionKey, onSelect, onResolve }: {
  applications: MarketplaceApplication[];
  actionKey: string | null;
  onSelect: (application: MarketplaceApplication) => Promise<void>;
  onResolve: (application: MarketplaceApplication) => Promise<void>;
}) {
  return (
    <section className="campaign-detail-panel application-list-panel">
      <div className="detail-panel-head"><span>PRIVATE BRAND VIEW</span><strong>{applications.length} APPLICATIONS</strong></div>
      {applications.length === 0 ? <p className="panel-empty">No creator applications have been submitted.</p> : null}
      {applications.map((application) => (
        <article className="brand-application" key={application.id}>
          <div><Link className="profile-link" href={`/marketplace/creators/${application.creatorWallet}`}>{application.creatorHandle ?? shortenAddress(application.creatorWallet)}</Link><strong>{genAtomsToDisplay(applicationRateAtoms(application))} TEST GEN</strong></div>
          <p>{application.pitch}</p>
          <div><small>{application.status.toUpperCase()} · {formatDate(application.createdAt)}</small>{application.status === "applied" ? <button className="verify-secondary" type="button" disabled={actionKey === `select:${application.id}`} onClick={() => void onSelect(application)}>{actionKey === `select:${application.id}` ? "WAITING FOR FINALITY…" : "SELECT CREATOR"}</button> : null}</div>
          {application.submissionTxHash ? <button className="verify-secondary" type="button" disabled={actionKey === `resolve:${application.id}`} onClick={() => void onResolve(application)}>REQUEST RESOLUTION</button> : null}
        </article>
      ))}
    </section>
  );
}

function SettlementControls({ campaign, wallet, onUpdated }: { campaign: MarketplaceCampaign; wallet: ReturnType<typeof useMarketplaceWallet>; onUpdated: (signal?: AbortSignal) => Promise<void> }) {
  const [settlement, setSettlement] = useState<MarketplaceSettlementStateDto | null>(null);
  const [phase, setPhase] = useState<"loading" | "idle" | "claiming" | "executing" | "refunding">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const basePath = `/api/marketplace/campaigns/${encodeURIComponent(campaign.id)}/settlement`;

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await marketplaceRequest<{ settlement: MarketplaceSettlementStateDto }>(basePath, { signal });
      setSettlement(response.settlement); setError(null); setPhase("idle");
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(marketplaceErrorMessage(loadError)); setPhase("idle");
    }
  }, [basePath]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  async function execute(kind: "claim" | "execute-claim" | "refund-unallocated") {
    setPhase(kind === "claim" ? "claiming" : kind === "execute-claim" ? "executing" : "refunding"); setMessage(null); setError(null);
    try {
      const actor = await wallet.authenticate();
      if (!wallet.isStudioNet) await wallet.switchToStudioNet();
      const preparePath = kind === "claim"
        ? `${basePath}/claim`
        : kind === "execute-claim"
          ? `${basePath}/claim/execute`
          : `/api/marketplace/campaigns/${encodeURIComponent(campaign.id)}/refund-unallocated`;
      const recoveryKey = settlementRecoveryStorageKey(campaign.id, kind);
      const recovery = readRecovery(recoveryKey);
      if (recovery) {
        setMessage("Reconciling the previously finalized StudioNet transaction…");
        await marketplaceRequest(`${preparePath}/confirm`, {
          method: "POST",
          body: JSON.stringify({ preparedId: recovery.preparedId, txHash: recovery.txHash }),
        });
        window.sessionStorage.removeItem(recoveryKey);
        setMessage(settlementSuccessMessage(kind));
        await load(); await onUpdated();
        return;
      }
      const prepared = await marketplaceRequest<PreparedMutation>(preparePath, { method: "POST", body: "{}" });
      const txHash = await broadcastMarketplaceTransaction(prepared.transaction, actor, {
        expectedFunctionName: kind === "claim"
          ? "request_withdrawal"
          : kind === "execute-claim"
            ? "execute_withdrawal"
            : "refund_unallocated",
        expectedValue: "0",
        onSubmitted: (hash) => window.sessionStorage.setItem(recoveryKey, JSON.stringify({ preparedId: prepared.preparedId, txHash: hash })),
        onStage: (stage) => setMessage(transactionNotice(stage)),
      });
      await marketplaceRequest(`${preparePath}/confirm`, { method: "POST", body: JSON.stringify({ preparedId: prepared.preparedId, txHash }) });
      window.sessionStorage.removeItem(recoveryKey);
      setMessage(settlementSuccessMessage(kind));
      await load(); await onUpdated();
    } catch (settlementError) { setError(marketplaceErrorMessage(settlementError)); }
    finally { setPhase("idle"); }
  }

  const view = settlement;
  const claimable = view?.claimableAtto ?? "0";
  const unallocated = view?.unallocatedAtto ?? "0";
  const busy = phase === "claiming" || phase === "executing" || phase === "refunding";
  return (
    <section className="settlement-controls" aria-live="polite">
      <span>GENLAYER BALANCES</span><strong>CLAIM OR REFUND NATIVE GEN.</strong>
      <p>Balances are shown only after finalized contract state is reconciled.</p>
      {view ? <dl><div><dt>CLAIMABLE</dt><dd>{genAtomsToDisplay(claimable)} TEST GEN</dd></div>{view.role === "brand" ? <div><dt>UNUSED BUDGET</dt><dd>{genAtomsToDisplay(unallocated)} TEST GEN</dd></div> : null}{view.withdrawalStatus ? <div><dt>WITHDRAWAL</dt><dd>{view.withdrawalStatus.replaceAll("_", " ")}</dd></div> : null}</dl> : null}
      {phase === "loading" ? <p>READING GENLAYER STATE…</p> : null}
      {view?.role === "brand" && unallocated !== "0" ? <button className="verify-secondary" type="button" disabled={busy || !view.canRefundUnallocated} onClick={() => void execute("refund-unallocated")}>{phase === "refunding" ? "WAITING FOR FINALITY…" : "REFUND UNUSED GEN"}</button> : null}
      {view?.withdrawalStatus === "PENDING" ? <button className="button" type="button" disabled={busy} onClick={() => void execute("execute-claim")}>{phase === "executing" ? "WAITING FOR FINALITY…" : "EXECUTE GEN WITHDRAWAL →"}</button> : null}
      {view?.withdrawalStatus === "EMITTED_UNCONFIRMED" ? <p className="form-message">TRANSFER EMITTED · AWAITING DELIVERY CONFIRMATION · NOT YET PAID</p> : null}
      {view?.withdrawalStatus === "CONFIRMED" ? <p className="form-message success">WITHDRAWAL DELIVERY CONFIRMED</p> : null}
      {(!view?.withdrawalStatus || view.withdrawalStatus === "RESTORED_FAILED") && (view?.canClaim || claimable !== "0") ? <button className="button" type="button" disabled={busy} onClick={() => void execute("claim")}>{phase === "claiming" ? "WAITING FOR FINALITY…" : "REQUEST GEN WITHDRAWAL →"}</button> : null}
      {message ? <p className="form-message success">{message}</p> : null}
      {error ? <><p className="form-message error" role="alert">{error}</p><button className="recovery-retry" type="button" disabled={busy} onClick={() => void load()}>REFRESH CONTRACT STATE</button></> : null}
    </section>
  );
}

function EvidenceSubmissionForm({ application, campaign, busy, onSubmit }: { application: MarketplaceApplication; campaign: MarketplaceCampaign; busy: boolean; onSubmit: (application: MarketplaceApplication, event: FormEvent<HTMLFormElement>) => Promise<void> }) {
  const source = campaignContentSource(campaign);
  const handle = application.creatorHandle?.replace(/^@/, "") ?? "";
  const contentId = application.contentId ?? "";
  const isFarcaster = source === "FARCASTER";
  return (
    <form className="evidence-form" onSubmit={(event) => void onSubmit(application, event)}>
      <span>PUBLIC TEXT-POST EVIDENCE</span><strong>SUBMIT YOUR {contentSourceLabel(source)} POST.</strong>
      <p>Enter the immutable {isFarcaster ? "cast hash" : "X post ID"} for one original public post from your verified @{handle || "handle"}. Its commitment is recorded on GenLayer.</p>
      <label>
        <span>{isFarcaster ? "FARCASTER CAST HASH" : "X POST ID"}</span>
        <input
          type="text"
          name="contentId"
          defaultValue={contentId}
          placeholder={isFarcaster ? `0x${"a".repeat(40)}` : "1890123456789012345"}
          pattern={isFarcaster ? "0x[0-9a-fA-F]{40}" : "[0-9]{5,25}"}
          inputMode={isFarcaster ? "text" : "numeric"}
          autoComplete="off"
          required
        />
        <small>{isFarcaster ? "Use the 0x-prefixed 20-byte cast hash." : "Use only the numeric ID from the canonical X status URL."}</small>
      </label>
      <button className="button" type="submit" disabled={busy}>{busy ? "WAITING FOR FINALITY…" : "SUBMIT ON GENLAYER →"}</button>
    </form>
  );
}

function ResolutionControl({ application, campaign, actionKey, loadedAt, onResolve, onRefund }: { application: MarketplaceApplication; campaign: MarketplaceCampaign; actionKey: string | null; loadedAt: number; onResolve: (application: MarketplaceApplication) => Promise<void>; onRefund: (application: MarketplaceApplication) => Promise<void> }) {
  const transaction = application.resolutionTxHash ?? application.genlayerTxHash;
  const transactionUrl = studioNetExplorerLink("tx", transaction);
  if (application.resolutionOutcome === "undetermined") {
    return <div className="resolution-control undetermined"><span>PREVIOUS ROUND</span><strong>UNDETERMINED.</strong><p>No payout or refund was assigned. Retry the same committed evidence, or refund after the contract retry ceiling.</p><ResolutionChecks application={application} />{transactionUrl ? <a href={transactionUrl} target="_blank" rel="noreferrer">VIEW STUDIONET TRANSACTION →</a> : null}<button className="verify-secondary" type="button" disabled={actionKey === `resolve:${application.id}`} onClick={() => void onResolve(application)}>RETRY RESOLUTION</button><button className="recovery-retry" type="button" disabled={actionKey === `refund:${application.id}`} onClick={() => void onRefund(application)}>REFUND AFTER RETRY CEILING</button></div>;
  }
  if (application.resolutionOutcome) {
    return <div className="resolution-control confirmed"><span>FINAL RESOLUTION</span><strong>{application.resolutionOutcome.toUpperCase()}</strong><p>Campaign state: {campaign.status.toUpperCase()}. The result below is the deterministic contract outcome; no generated narrative is shown.</p><ResolutionChecks application={application} />{transactionUrl ? <a href={transactionUrl} target="_blank" rel="noreferrer">VIEW FINAL TRANSACTION →</a> : null}</div>;
  }
  if (application.requestId || application.genlayerTxHash) {
    return <div className="resolution-control confirmed"><span>GENLAYER REQUEST</span><strong>{application.status.replaceAll("_", " ").toUpperCase()}</strong>{application.requestId ? <code>{application.requestId}</code> : null}{application.genlayerTxHash ? <code>{application.genlayerTxHash}</code> : null}</div>;
  }
  if (!application.submittedAt) return null;
  const availableAt = new Date(application.submittedAt).getTime() + Number(campaign.retentionSeconds) * 1_000;
  const ready = Number.isFinite(availableAt) && availableAt <= loadedAt;
  return <div className="resolution-control"><span>GENLAYER RESOLUTION</span><strong>{ready ? "READY TO RESOLVE." : "RETENTION WINDOW ACTIVE."}</strong><p>{ready ? "Either participant may request resolution of the frozen text-post evidence." : `Resolution unlocks ${formatDate(new Date(availableAt).toISOString())}.`}</p><button className="verify-secondary" type="button" disabled={!ready || actionKey === `resolve:${application.id}`} onClick={() => void onResolve(application)}>{actionKey === `resolve:${application.id}` ? "WAITING FOR FINALITY…" : "REQUEST RESOLUTION"}</button></div>;
}

function ResolutionChecks({ application }: { application: MarketplaceApplication }) {
  const checks = application.resolutionChecks;
  if (!checks) return null;
  const rows = [
    ["AUTHOR MATCH", checks.authorMatch],
    ["CONTENT ID MATCH", checks.postIdMatch],
    ...checks.requiredChecks.map((value, index) => [`REQUIRED PHRASE ${String(index + 1).padStart(2, "0")}`, value] as const),
    ...checks.forbiddenChecks.map((value, index) => [`FORBIDDEN PHRASE MATCH ${String(index + 1).padStart(2, "0")}`, value] as const),
    ["DISCLOSURE PRESENT", checks.disclosurePresent],
    ["SEMANTIC PASS", checks.semanticPass],
  ] as ReadonlyArray<readonly [string, boolean]>;
  return <dl className="resolution-checks" aria-label="Exact GenLayer resolution checks">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ? "TRUE" : "FALSE"}</dd></div>)}</dl>;
}

function applicationPath(campaignId: string, applicationId: string): string {
  return `/api/marketplace/campaigns/${encodeURIComponent(campaignId)}/applications/${encodeURIComponent(applicationId)}`;
}

function recoveryStorageKey(campaignId: string, actionKey: string): string {
  return `influencedx:studionet-action:${campaignId}:${actionKey}`;
}

function settlementRecoveryStorageKey(campaignId: string, kind: string): string {
  return `influencedx:studionet-settlement:${campaignId}:${kind}`;
}

function readRecovery(storageKey: string): Pick<Recovery, "preparedId" | "txHash"> | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null") as Partial<Recovery> | null;
    if (value && typeof value.preparedId === "string" && typeof value.txHash === "string" && /^0x[\da-f]{64}$/i.test(value.txHash)) {
      return { preparedId: value.preparedId, txHash: value.txHash };
    }
  } catch {
    window.sessionStorage.removeItem(storageKey);
  }
  return null;
}

function settlementSuccessMessage(kind: "claim" | "execute-claim" | "refund-unallocated"): string {
  if (kind === "claim") return "Withdrawal request finalized. Execute it to emit the GEN transfer.";
  if (kind === "execute-claim") return "Transfer emitted. It remains pending until owner reconciliation confirms delivery.";
  return "Unused GEN refund finalized and added to the brand's claimable balance.";
}

function loadRecoveries(campaignId: string): Record<string, Recovery> {
  if (typeof window === "undefined") return {};
  const prefix = `influencedx:studionet-action:${campaignId}:`;
  const recovered: Record<string, Recovery> = {};
  for (let index = 0; index < window.sessionStorage.length; index += 1) {
    const storageKey = window.sessionStorage.key(index);
    if (!storageKey?.startsWith(prefix)) continue;
    try {
      const value = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null") as Partial<Recovery> | null;
      if (value && typeof value.preparedId === "string" && typeof value.txHash === "string" && /^0x[\da-f]{64}$/i.test(value.txHash) && typeof value.confirmPath === "string") {
        recovered[storageKey.slice(prefix.length)] = value as Recovery;
      }
    } catch {
      window.sessionStorage.removeItem(storageKey);
    }
  }
  return recovered;
}

function transactionNotice(stage: GenLayerTransactionStage): string {
  if (stage === "wallet") return "Confirm the exact StudioNet action in your wallet…";
  if (stage === "submitted") return "Transaction submitted. Its hash is saved for recovery.";
  if (stage === "finality") return "Waiting for GenLayer validator finality…";
  return "StudioNet transaction finalized.";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "DATE UNAVAILABLE";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
