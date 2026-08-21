"use client";

import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { MarketplaceState } from "../../components/MarketplaceState";
import {
  matchingMarketplaceReadyRetry,
  marketplaceErrorMessage,
  marketplaceRequest,
  preparedMarketplaceRecovery,
  recordSubmittedMarketplaceTransaction,
} from "../../marketplace-api";
import {
  broadcastMarketplaceTransaction,
  isExplicitEip1193UserRejection,
  isTerminalMarketplaceTransactionError,
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
  transaction?: MarketplaceTransactionDto;
  recovery?: unknown;
  campaign?: MarketplaceCampaign;
  application?: MarketplaceApplication;
};

type Recovery = { preparedId: string; txHash: string; confirmPath: string };
type ReadyRetry = { actor: string; prepared: PreparedMutation; confirmPath: string; requestBody: string };
type SettlementActionKind = "claim" | "execute-claim" | "refund-unallocated";
type MarketplaceWallet = ReturnType<typeof useMarketplaceWallet>;

export function CampaignDetail({ campaignId }: { campaignId: string }) {
  const wallet = useMarketplaceWallet();
  const activeActor = wallet.authenticated
    && wallet.address
    && wallet.sessionWallet === wallet.address
    ? wallet.address.toLowerCase()
    : null;
  const sessionKey = [
    campaignId,
    wallet.authenticated ? "authenticated" : "anonymous",
    wallet.address ?? "disconnected",
    wallet.sessionWallet ?? "no-session",
  ].join(":");
  return (
    <CampaignDetailSession
      key={sessionKey}
      activeActor={activeActor}
      campaignId={campaignId}
      wallet={wallet}
    />
  );
}

function CampaignDetailSession({
  activeActor,
  campaignId,
  wallet,
}: {
  activeActor: string | null;
  campaignId: string;
  wallet: MarketplaceWallet;
}) {
  const [state, setState] = useState<DetailState>({ phase: "loading", detail: null, error: null });
  const [action, setAction] = useState<{ key: string | null; notice: string | null; error: string | null }>({ key: null, notice: null, error: null });
  const [recoveries, setRecoveries] = useState<Record<string, Recovery>>(
    () => activeActor ? loadRecoveries(campaignId, activeActor) : {},
  );
  const [fundingBusy, setFundingBusy] = useState(false);
  const [settlementBusy, setSettlementBusy] = useState(false);
  const readyRetries = useRef<Record<string, ReadyRetry>>({});

  const loadDetail = useCallback(async (signal?: AbortSignal) => {
    try {
      const detail = await marketplaceRequest<CampaignDetailResponse>(
        `/api/marketplace/campaigns/${encodeURIComponent(campaignId)}`,
        { signal },
      );
      const responseViewerApplication = detail.viewerApplication ?? null;
      const viewerApplication = activeActor
        && responseViewerApplication?.creatorWallet.toLowerCase() === activeActor
        ? responseViewerApplication
        : null;
      const viewerRecovery = viewerApplication ? detail.viewerRecovery ?? null : null;
      const applications = activeActor === detail.campaign.brandWallet.toLowerCase()
        && Array.isArray(detail.applications)
        ? detail.applications
        : [];
      if (activeActor && viewerApplication?.status === "pending_onchain" && viewerRecovery) {
        const recovery: Recovery = {
          preparedId: viewerRecovery.preparedId,
          txHash: viewerRecovery.txHash,
          confirmPath: `${applicationPath(campaignId, viewerApplication.id)}/apply/confirm`,
        };
        window.localStorage.setItem(
          recoveryStorageKey(campaignId, activeActor, "apply"),
          JSON.stringify(recovery),
        );
        setRecoveries((current) => ({ ...current, apply: recovery }));
      }
      setState({
        phase: "ready",
        detail: {
          ...detail,
          applications,
          viewerApplication,
          viewerRecovery,
        },
        loadedAt: Date.now(),
        error: null,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState({ phase: "error", detail: null, error: marketplaceErrorMessage(error) });
    }
  }, [activeActor, campaignId]);

  useEffect(() => {
    purgeLegacyRecoveryStorage(campaignId);
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadDetail(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [campaignId, loadDetail]);

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
    recoveryOnly?: boolean;
  }) {
    if (!activeActor) {
      setAction({ key: null, notice: null, error: "Connect and sign your wallet first." });
      return;
    }
    setAction({ key: input.key, notice: "Preparing transaction…", error: null });
    try {
      const actor = await wallet.authenticate();
      if (actor !== activeActor) {
        throw new Error("The authenticated wallet changed.");
      }
      if (!wallet.isStudioNet) await wallet.switchToStudioNet();
      const existing = activeActor === actor ? recoveries[input.key] : undefined;
      if (existing) {
        setAction({ key: input.key, notice: "Recovering submitted transaction…", error: null });
        await recordSubmittedMarketplaceTransaction(existing.preparedId, existing.txHash);
        await marketplaceRequest(existing.confirmPath, {
          method: "POST",
          body: JSON.stringify({ preparedId: existing.preparedId, txHash: existing.txHash }),
        });
        clearRecovery(actor, input.key);
        await loadDetail();
        setAction({ key: null, notice: "Transaction recovered.", error: null });
        return;
      }
      if (input.recoveryOnly) {
        throw new Error("The original submitted transaction hash is required.");
      }
      const requestBody = JSON.stringify(input.body ?? {});
      const readyRetry = readyRetries.current[input.key];
      const reusableReady = matchingMarketplaceReadyRetry(readyRetry, actor, requestBody);
      const prepared = reusableReady?.prepared ?? await marketplaceRequest<PreparedMutation>(input.preparePath, {
        method: "POST",
        body: requestBody,
      });
      const confirmPath = reusableReady?.confirmPath ?? (
        typeof input.confirmPath === "function"
          ? input.confirmPath(prepared)
          : input.confirmPath ?? `${input.preparePath}/confirm`
      );
      const submitted = preparedMarketplaceRecovery(prepared);
      if (submitted) {
        saveRecovery(actor, input.key, { ...submitted, confirmPath });
        await recordSubmittedMarketplaceTransaction(submitted.preparedId, submitted.txHash);
        await marketplaceRequest(confirmPath, {
          method: "POST",
          body: JSON.stringify(submitted),
        });
        clearRecovery(actor, input.key);
        await loadDetail();
        setAction({ key: null, notice: "Transaction recovered.", error: null });
        return;
      }
      if (!prepared.transaction) {
        throw new Error("The prepared marketplace transaction is unavailable.");
      }
      readyRetries.current[input.key] = { actor, prepared, confirmPath, requestBody };
      const txHash = await broadcastMarketplaceTransaction(prepared.transaction, actor, {
        expectedFunctionName: input.expectedFunctionName,
        expectedValue: "0",
        onSubmitted: async (hash) => {
          delete readyRetries.current[input.key];
          saveRecovery(actor, input.key, {
            preparedId: prepared.preparedId,
            txHash: hash,
            confirmPath,
          });
          await recordSubmittedMarketplaceTransaction(prepared.preparedId, hash);
        },
        onStage: (stage) => setAction({ key: input.key, notice: transactionNotice(stage), error: null }),
      });
      setAction({ key: input.key, notice: "Finality reached. Confirming state…", error: null });
      await marketplaceRequest(confirmPath, {
        method: "POST",
        body: JSON.stringify({ preparedId: prepared.preparedId, txHash }),
      });
      clearRecovery(actor, input.key);
      await loadDetail();
      setAction({ key: null, notice: "Transaction finalized.", error: null });
    } catch (error) {
      if (!isExplicitEip1193UserRejection(error)) {
        delete readyRetries.current[input.key];
      }
      if (activeActor && isTerminalMarketplaceTransactionError(error)) {
        clearRecovery(activeActor, input.key);
        await loadDetail();
      }
      setAction({ key: null, notice: null, error: marketplaceErrorMessage(error) });
    }
  }

  function saveRecovery(actor: string, key: string, recovery: Recovery) {
    const normalizedActor = actor.toLowerCase();
    window.localStorage.setItem(
      recoveryStorageKey(campaignId, normalizedActor, key),
      JSON.stringify(recovery),
    );
    if (activeActor === normalizedActor) {
      setRecoveries((current) => ({ ...current, [key]: recovery }));
    }
  }

  function clearRecovery(actor: string, key: string) {
    const normalizedActor = actor.toLowerCase();
    window.localStorage.removeItem(
      recoveryStorageKey(campaignId, normalizedActor, key),
    );
    if (activeActor === normalizedActor) {
      setRecoveries((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
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

  async function recoverPendingApplication(application: MarketplaceApplication) {
    await executePrepared({
      key: "apply",
      expectedFunctionName: "apply_to_campaign",
      preparePath: `${applicationPath(campaignId, application.id)}/apply/confirm`,
      confirmPath: `${applicationPath(campaignId, application.id)}/apply/confirm`,
      recoveryOnly: true,
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
    return <section className="marketplace-detail-shell"><MarketplaceState kind="loading" title="LOADING BRIEF" message="Loading campaign…" /></section>;
  }
  if (state.phase === "error") {
    return (
      <section className="marketplace-detail-shell">
        <MarketplaceState kind="error" title="BRIEF UNAVAILABLE" message={state.error} onRetry={() => void loadDetail()} />
      </section>
    );
  }

  const { campaign } = state.detail;
  const viewerApplication = activeActor
    && state.detail.viewerApplication?.creatorWallet.toLowerCase() === activeActor
    ? state.detail.viewerApplication
    : null;
  const applications = activeActor === campaign.brandWallet.toLowerCase()
    ? state.detail.applications
    : [];
  const contentSource = campaignContentSource(campaign);
  const isBrand = Boolean(activeActor && activeActor === campaign.brandWallet.toLowerCase());
  const canApply = Boolean(activeActor)
    && campaign.status === "open"
    && campaign.fundingStatus === "funded"
    && !isBrand
    && !viewerApplication;
  const canCancel = isBrand && ["funding", "open"].includes(campaign.status);
  const walletSwitchLocked = action.key !== null || fundingBusy || settlementBusy;

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
          {!activeActor ? <WalletIntro wallet={wallet} /> : null}
          {isBrand && activeActor && campaign.fundingStatus !== "funded" ? <CampaignFunding key={`funding:${activeActor}`} actor={activeActor} campaign={campaign} onFunded={loadDetail} onBusyChange={setFundingBusy} /> : null}
          {isBrand && campaign.fundingStatus === "funded" ? <div className="action-intro"><p className="card-index">BRAND VIEW</p><h2>APPLICATIONS</h2></div> : null}
          {activeActor && viewerApplication ? (
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
              hasPendingRecovery={Boolean(recoveries.apply)}
              onRecoverPending={recoverPendingApplication}
            />
          ) : null}
          {activeActor && canApply ? <ApplicationForm busy={action.key === "apply"} contentSource={contentSource} onSubmit={apply} /> : null}
          {activeActor && !isBrand && !viewerApplication && !canApply ? <div className="action-intro"><h2>APPLICATIONS CLOSED</h2><p>This campaign is not accepting applications.</p></div> : null}
          {activeActor && campaign.fundingStatus === "funded" && (isBrand || viewerApplication) ? <SettlementControls key={`settlement:${activeActor}`} actor={activeActor} campaign={campaign} wallet={wallet} onUpdated={loadDetail} onBusyChange={setSettlementBusy} /> : null}
          {canCancel ? <button className="recovery-retry" type="button" disabled={action.key === "cancel"} onClick={() => void cancelCampaign()}>{action.key === "cancel" ? "CANCELLING…" : "CANCEL + REFUND CAMPAIGN"}</button> : null}
          {action.notice ? <p className="form-message" role="status">{action.notice}</p> : null}
          {action.error ? <p className="form-message error" role="alert">{action.error}</p> : null}
          {wallet.walletError ? <p className="form-message error" role="alert">{wallet.walletError}</p> : null}
          {wallet.hasSession ? <button className="wallet-signout" type="button" disabled={walletSwitchLocked} onClick={() => void wallet.signOut()}>SWITCH WALLET</button> : null}
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
      <button className="button" type="button" disabled={wallet.authenticating} onClick={() => void wallet.authenticate()}>{wallet.authenticating ? "SIGNING IN…" : "CONNECT + SIGN →"}</button>
      <Link href="/verify">NEED TO VERIFY? START HERE →</Link>
    </div>
  );
}

function ApplicationForm({ busy, contentSource, onSubmit }: { busy: boolean; contentSource: "X" | "FARCASTER"; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <form className="application-form" onSubmit={onSubmit}>
      <p className="card-index">CREATOR APPLICATION</p><h2>SET YOUR RATE.</h2>
      <p>Your rate is visible to the brand. Active {contentSourceLabel(contentSource)} identity required.</p>
      <label><span>REQUESTED RATE / TEST GEN</span><input name="requestedRateGen" inputMode="decimal" pattern="[0-9]+(?:\.[0-9]{1,18})?" placeholder="1200" required /></label>
      <label><span>WHY YOU FIT THIS BRIEF</span><textarea name="pitch" minLength={20} maxLength={1_500} rows={7} placeholder="Describe your audience, content angle, and relevant public work." required /></label>
      <button className="button" type="submit" disabled={busy}>{busy ? "WAITING FOR FINALITY…" : "APPLY ON GENLAYER →"}</button>
    </form>
  );
}

function CreatorApplication({ application, campaign, actionKey, loadedAt, onAccept, onDecline, onWithdraw, onSubmit, onResolve, onRefund, hasPendingRecovery, onRecoverPending }: {
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
  hasPendingRecovery: boolean;
  onRecoverPending: (application: MarketplaceApplication) => Promise<void>;
}) {
  const pending = application.status === "pending_onchain";
  const selected = application.status === "selected";
  const accepted = application.status === "accepted";
  const submitted = Boolean(application.submissionTxHash || application.contentId);
  return (
    <div className="creator-application-summary">
      <p className="card-index">YOUR APPLICATION</p>
      <h2>{submitted ? "WORK SUBMITTED." : accepted ? "CAMPAIGN ACTIVE." : selected ? "YOU WERE SELECTED." : pending ? "FINISH APPLICATION." : "APPLICATION RECORDED."}</h2>
      <dl><div><dt>RATE</dt><dd>{genAtomsToDisplay(applicationRateAtoms(application))} TEST GEN</dd></div><div><dt>STATUS</dt><dd>{application.status.replaceAll("_", " ").toUpperCase()}</dd></div></dl>
      <p>{application.pitch}</p>
      <Link className="profile-link" href={`/marketplace/creators/${application.creatorWallet}`}>VIEW PUBLIC PROFILE →</Link>
      {pending && hasPendingRecovery ? <button className="button" type="button" disabled={actionKey === "apply"} onClick={() => void onRecoverPending(application)}>{actionKey === "apply" ? "CONFIRMING…" : "FINISH APPLICATION →"}</button> : null}
      {pending && !hasPendingRecovery ? <p className="form-message">ORIGINAL TRANSACTION REQUIRED.</p> : null}
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

function SettlementControls({ actor, campaign, wallet, onUpdated, onBusyChange }: { actor: string; campaign: MarketplaceCampaign; wallet: ReturnType<typeof useMarketplaceWallet>; onUpdated: (signal?: AbortSignal) => Promise<void>; onBusyChange: (busy: boolean) => void }) {
  const [settlement, setSettlement] = useState<MarketplaceSettlementStateDto | null>(null);
  const [phase, setPhase] = useState<"loading" | "idle" | "claiming" | "executing" | "refunding">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const basePath = `/api/marketplace/campaigns/${encodeURIComponent(campaign.id)}/settlement`;
  const readyRetries = useRef<Partial<Record<SettlementActionKind, PreparedMutation>>>({});

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await marketplaceRequest<{ settlement: MarketplaceSettlementStateDto }>(basePath, { signal });
      if (response.settlement.actorWallet.toLowerCase() !== actor) {
        throw new Error("The settlement wallet changed.");
      }
      setSettlement(response.settlement); setError(null); setPhase("idle");
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(marketplaceErrorMessage(loadError)); setPhase("idle");
    }
  }, [actor, basePath]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  useEffect(() => {
    if (
      settlement?.role !== "brand"
      || settlement.unallocatedAtto === "0"
      || settlement.canRefundUnallocated
    ) return;
    const deadlineMs = new Date(settlement.selectionDeadline).getTime();
    if (!Number.isFinite(deadlineMs)) return;
    const timer = window.setTimeout(
      () => void load(),
      Math.min(2_147_000_000, Math.max(15_000, deadlineMs - Date.now() + 250)),
    );
    return () => window.clearTimeout(timer);
  }, [load, settlement]);

  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  async function execute(kind: SettlementActionKind) {
    const recoveryKey = settlementRecoveryStorageKey(campaign.id, actor, kind);
    onBusyChange(true);
    setPhase(kind === "claim" ? "claiming" : kind === "execute-claim" ? "executing" : "refunding"); setMessage(null); setError(null);
    try {
      const authenticatedActor = await wallet.authenticate();
      if (authenticatedActor !== actor) {
        throw new Error("The authenticated wallet changed.");
      }
      if (!wallet.isStudioNet) await wallet.switchToStudioNet();
      const preparePath = kind === "claim"
        ? `${basePath}/claim`
        : kind === "execute-claim"
          ? `${basePath}/claim/execute`
          : `/api/marketplace/campaigns/${encodeURIComponent(campaign.id)}/refund-unallocated`;
      const recovery = readRecovery(recoveryKey);
      if (recovery) {
        setMessage("Recovering finalized transaction…");
        await recordSubmittedMarketplaceTransaction(recovery.preparedId, recovery.txHash);
        await marketplaceRequest(`${preparePath}/confirm`, {
          method: "POST",
          body: JSON.stringify({ preparedId: recovery.preparedId, txHash: recovery.txHash }),
        });
        window.localStorage.removeItem(recoveryKey);
        setMessage(settlementSuccessMessage(kind));
        await load(); await onUpdated();
        return;
      }
      const prepared = readyRetries.current[kind] ?? await marketplaceRequest<PreparedMutation>(preparePath, { method: "POST", body: "{}" });
      const submitted = preparedMarketplaceRecovery(prepared);
      if (submitted) {
        window.localStorage.setItem(recoveryKey, JSON.stringify(submitted));
        await recordSubmittedMarketplaceTransaction(submitted.preparedId, submitted.txHash);
        await marketplaceRequest(`${preparePath}/confirm`, {
          method: "POST",
          body: JSON.stringify(submitted),
        });
        window.localStorage.removeItem(recoveryKey);
        setMessage(settlementSuccessMessage(kind));
        await load(); await onUpdated();
        return;
      }
      if (!prepared.transaction) {
        throw new Error("The prepared marketplace transaction is unavailable.");
      }
      readyRetries.current[kind] = prepared;
      const txHash = await broadcastMarketplaceTransaction(prepared.transaction, authenticatedActor, {
        expectedFunctionName: kind === "claim"
          ? "request_withdrawal"
          : kind === "execute-claim"
            ? "execute_withdrawal"
            : "refund_unallocated",
        expectedValue: "0",
        onSubmitted: async (hash) => {
          delete readyRetries.current[kind];
          window.localStorage.setItem(
            recoveryKey,
            JSON.stringify({ preparedId: prepared.preparedId, txHash: hash }),
          );
          await recordSubmittedMarketplaceTransaction(prepared.preparedId, hash);
        },
        onStage: (stage) => setMessage(transactionNotice(stage)),
      });
      await marketplaceRequest(`${preparePath}/confirm`, { method: "POST", body: JSON.stringify({ preparedId: prepared.preparedId, txHash }) });
      window.localStorage.removeItem(recoveryKey);
      setMessage(settlementSuccessMessage(kind));
      await load(); await onUpdated();
    } catch (settlementError) {
      if (!isExplicitEip1193UserRejection(settlementError)) {
        delete readyRetries.current[kind];
      }
      if (isTerminalMarketplaceTransactionError(settlementError)) {
        window.localStorage.removeItem(recoveryKey);
        await Promise.allSettled([load(), onUpdated()]);
      }
      setError(marketplaceErrorMessage(settlementError));
    }
    finally { setPhase("idle"); onBusyChange(false); }
  }

  const view = settlement;
  const claimable = view?.claimableAtto ?? "0";
  const unallocated = view?.unallocatedAtto ?? "0";
  const busy = phase === "claiming" || phase === "executing" || phase === "refunding";
  return (
    <section className="settlement-controls" aria-live="polite">
      <span>GENLAYER BALANCES</span><strong>NATIVE GEN</strong>
      {view ? <dl><div><dt>CLAIMABLE</dt><dd>{genAtomsToDisplay(claimable)} TEST GEN</dd></div>{view.role === "brand" ? <div><dt>UNUSED BUDGET</dt><dd>{genAtomsToDisplay(unallocated)} TEST GEN</dd></div> : null}{view.withdrawalStatus ? <div><dt>WITHDRAWAL</dt><dd>{view.withdrawalStatus.replaceAll("_", " ")}</dd></div> : null}</dl> : null}
      {phase === "loading" ? <p>READING GENLAYER STATE…</p> : null}
      {view?.role === "brand" && unallocated !== "0" && view.canRefundUnallocated ? <button className="verify-secondary" type="button" disabled={busy} onClick={() => void execute("refund-unallocated")}>{phase === "refunding" ? "WAITING FOR FINALITY…" : "REFUND UNUSED GEN"}</button> : null}
      {view?.role === "brand" && unallocated !== "0" && !view.canRefundUnallocated ? <p className="form-message">REFUND UNLOCKS {formatDate(view.selectionDeadline).toUpperCase()}</p> : null}
      {view?.withdrawalStatus === "PENDING" ? <button className="button" type="button" disabled={busy} onClick={() => void execute("execute-claim")}>{phase === "executing" ? "WAITING FOR FINALITY…" : "EXECUTE GEN WITHDRAWAL →"}</button> : null}
      {view?.withdrawalStatus === "EMITTED_UNCONFIRMED" ? <p className="form-message">TRANSFER EMITTED · AWAITING DELIVERY CONFIRMATION · NOT YET PAID</p> : null}
      {view?.withdrawalStatus === "CONFIRMED" ? <p className="form-message success">WITHDRAWAL DELIVERY CONFIRMED</p> : null}
      {(!view?.withdrawalStatus || ["RESTORED_FAILED", "CONFIRMED"].includes(view.withdrawalStatus)) && (view?.canClaim || claimable !== "0") ? <button className="button" type="button" disabled={busy} onClick={() => void execute("claim")}>{phase === "claiming" ? "WAITING FOR FINALITY…" : "REQUEST GEN WITHDRAWAL →"}</button> : null}
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
      <p>Paste the public {isFarcaster ? "cast" : "post"} link from @{handle || "handle"}.</p>
      <label>
        <span>{isFarcaster ? "FARCASTER CAST URL" : "X POST URL"}</span>
        <input
          type="url"
          name="contentId"
          defaultValue={contentId}
          placeholder={isFarcaster ? "https://farcaster.xyz/username/0x…" : "https://x.com/username/status/…"}
          inputMode="url"
          autoComplete="off"
          required
        />
      </label>
      <button className="button" type="submit" disabled={busy}>{busy ? "WAITING FOR FINALITY…" : "SUBMIT ON GENLAYER →"}</button>
    </form>
  );
}

function ResolutionControl({ application, campaign, actionKey, loadedAt, onResolve, onRefund }: { application: MarketplaceApplication; campaign: MarketplaceCampaign; actionKey: string | null; loadedAt: number; onResolve: (application: MarketplaceApplication) => Promise<void>; onRefund: (application: MarketplaceApplication) => Promise<void> }) {
  const transaction = application.resolutionTxHash ?? application.genlayerTxHash;
  const transactionUrl = studioNetExplorerLink("tx", transaction);
  if (application.resolutionOutcome === "undetermined") {
    return <div className="resolution-control undetermined"><span>PREVIOUS ROUND</span><strong>UNDETERMINED.</strong><p>No payout or refund was assigned. Retry, or refund after the retry ceiling.</p><ResolutionChecks application={application} />{transactionUrl ? <a href={transactionUrl} target="_blank" rel="noreferrer">VIEW STUDIONET TRANSACTION →</a> : null}<button className="verify-secondary" type="button" disabled={actionKey === `resolve:${application.id}`} onClick={() => void onResolve(application)}>RETRY RESOLUTION</button><button className="recovery-retry" type="button" disabled={actionKey === `refund:${application.id}`} onClick={() => void onRefund(application)}>REFUND AFTER RETRY CEILING</button></div>;
  }
  if (application.resolutionOutcome) {
    return <div className="resolution-control confirmed"><span>FINAL RESOLUTION</span><strong>{application.resolutionOutcome.toUpperCase()}</strong><ResolutionChecks application={application} />{transactionUrl ? <a href={transactionUrl} target="_blank" rel="noreferrer">VIEW FINAL TRANSACTION →</a> : null}</div>;
  }
  if (application.requestId || application.genlayerTxHash) {
    return <div className="resolution-control confirmed"><span>GENLAYER REQUEST</span><strong>{application.status.replaceAll("_", " ").toUpperCase()}</strong>{application.requestId ? <code>{application.requestId}</code> : null}{application.genlayerTxHash ? <code>{application.genlayerTxHash}</code> : null}</div>;
  }
  if (!application.submittedAt) return null;
  const availableAt = new Date(application.submittedAt).getTime() + Number(campaign.retentionSeconds) * 1_000;
  const ready = Number.isFinite(availableAt) && availableAt <= loadedAt;
  return <div className="resolution-control"><span>GENLAYER RESOLUTION</span><strong>{ready ? "READY TO RESOLVE." : "RETENTION WINDOW ACTIVE."}</strong><p>{ready ? "Either participant may resolve." : `Unlocks ${formatDate(new Date(availableAt).toISOString())}.`}</p><button className="verify-secondary" type="button" disabled={!ready || actionKey === `resolve:${application.id}`} onClick={() => void onResolve(application)}>{actionKey === `resolve:${application.id}` ? "WAITING FOR FINALITY…" : "REQUEST RESOLUTION"}</button></div>;
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

function recoveryStorageKey(campaignId: string, actor: string, actionKey: string): string {
  return `influencedx:studionet-action:v2:${campaignId}:${actor}:${actionKey}`;
}

function settlementRecoveryStorageKey(campaignId: string, actor: string, kind: string): string {
  return `influencedx:studionet-settlement:v2:${campaignId}:${actor}:${kind}`;
}

function readRecovery(storageKey: string): Pick<Recovery, "preparedId" | "txHash"> | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as Partial<Recovery> | null;
    if (value && typeof value.preparedId === "string" && typeof value.txHash === "string" && /^0x[\da-f]{64}$/i.test(value.txHash)) {
      return { preparedId: value.preparedId, txHash: value.txHash };
    }
  } catch {
    window.localStorage.removeItem(storageKey);
  }
  return null;
}

function settlementSuccessMessage(kind: SettlementActionKind): string {
  if (kind === "claim") return "Withdrawal ready. Execute it to send GEN.";
  if (kind === "execute-claim") return "Transfer emitted. Awaiting delivery confirmation.";
  return "Unused GEN added to the brand balance.";
}

function loadRecoveries(campaignId: string, actor: string): Record<string, Recovery> {
  if (typeof window === "undefined") return {};
  const prefix = `influencedx:studionet-action:v2:${campaignId}:${actor}:`;
  const recovered: Record<string, Recovery> = {};
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const storageKey = window.localStorage.key(index);
    if (!storageKey?.startsWith(prefix)) continue;
    try {
      const value = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as Partial<Recovery> | null;
      if (value && typeof value.preparedId === "string" && typeof value.txHash === "string" && /^0x[\da-f]{64}$/i.test(value.txHash) && typeof value.confirmPath === "string") {
        recovered[storageKey.slice(prefix.length)] = value as Recovery;
      }
    } catch {
      window.localStorage.removeItem(storageKey);
    }
  }
  return recovered;
}

function purgeLegacyRecoveryStorage(campaignId: string): void {
  if (typeof window === "undefined") return;
  const legacyPrefixes = [
    `influencedx:studionet-action:${campaignId}:`,
    `influencedx:studionet-settlement:${campaignId}:`,
  ];
  const legacyExact = `influencedx:studionet-funding:${campaignId}`;
  for (const storage of [window.sessionStorage, window.localStorage]) {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key === legacyExact || legacyPrefixes.some((prefix) => key?.startsWith(prefix))) {
        storage.removeItem(key!);
      }
    }
  }
}

function transactionNotice(stage: GenLayerTransactionStage): string {
  if (stage === "wallet") return "Confirm in your wallet…";
  if (stage === "submitted") return "Submitted. Transaction saved for recovery.";
  if (stage === "finality") return "Waiting for GenLayer finality…";
  return "Transaction finalized.";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "DATE UNAVAILABLE";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
