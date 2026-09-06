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
  | { phase: "ready"; detail: CampaignDetailResponse; error: null }
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
  const [actionClock, setActionClock] = useState<number | null>(null);
  const readyRetries = useRef<Record<string, ReadyRetry>>({});
  const latestObservedAt = useRef(-1);
  const loadSequence = useRef(0);

  const loadDetail = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++loadSequence.current;
    try {
      const detail = await marketplaceRequest<CampaignDetailResponse>(
        `/api/marketplace/campaigns/${encodeURIComponent(campaignId)}`,
        { signal },
      );
      if (sequence !== loadSequence.current) return;
      const responseObservedAt = observedAtMs(detail.observedAt);
      if (responseObservedAt === null) throw new Error("The campaign clock is unavailable.");
      if (responseObservedAt < latestObservedAt.current) return;
      latestObservedAt.current = responseObservedAt;
      setActionClock((current) => current === null
        ? responseObservedAt
        : Math.max(current, responseObservedAt));
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
      setState((current) => {
        const currentObservedAt = current.phase === "ready"
          ? observedAtMs(current.detail.observedAt)
          : null;
        if (currentObservedAt !== null && responseObservedAt < currentObservedAt) return current;
        return {
          phase: "ready",
          detail: {
            ...detail,
            applications,
            viewerApplication,
            viewerRecovery,
          },
          error: null,
        };
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (sequence !== loadSequence.current) return;
      setState((current) => current.phase === "ready"
        ? current
        : { phase: "error", detail: null, error: marketplaceErrorMessage(error) });
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
    const refreshVisibleState = () => {
      if (document.visibilityState !== "visible") return;
      setActionClock(null);
      void loadDetail();
    };
    document.addEventListener("visibilitychange", refreshVisibleState);
    window.addEventListener("focus", refreshVisibleState);
    return () => {
      document.removeEventListener("visibilitychange", refreshVisibleState);
      window.removeEventListener("focus", refreshVisibleState);
    };
  }, [loadDetail]);

  const shouldPoll = state.phase === "ready"
    && ["funding", "open"].includes(state.detail.campaign.status);
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(() => void loadDetail(), 12_000);
    return () => window.clearInterval(timer);
  }, [loadDetail, shouldPoll]);

  const nextActionBoundary = state.phase === "ready"
    ? nextCampaignActionBoundary(state.detail, actionClock)
    : null;
  useEffect(() => {
    if (nextActionBoundary === null || actionClock === null) return;
    const remaining = nextActionBoundary - actionClock;
    const capped = remaining > 2_147_000_000;
    const delay = capped ? 2_147_000_000 : Math.max(0, remaining + 250);
    const advanceTo = capped ? actionClock + 2_147_000_000 : nextActionBoundary;
    const timer = window.setTimeout(
      () => {
        setActionClock((current) => current === null ? null : Math.max(current, advanceTo));
        void loadDetail();
      },
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [actionClock, loadDetail, nextActionBoundary]);

  async function executePrepared(input: {
    key: string;
    expectedFunctionName: UserMarketplaceFunctionName;
    preparePath: string;
    confirmPath?: string | ((prepared: PreparedMutation) => string);
    body?: Record<string, unknown>;
    recoveryOnly?: boolean;
    serverRecoveryOnly?: boolean;
  }) {
    if (!activeActor) {
      setAction({ key: null, notice: null, error: "Connect and sign your wallet first." });
      return;
    }
    setAction({ key: input.key, notice: input.serverRecoveryOnly ? "Checking pending transaction…" : "Preparing transaction…", error: null });
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
      const readyRetry = input.serverRecoveryOnly
        ? undefined
        : readyRetries.current[input.key];
      const reusableReady = matchingMarketplaceReadyRetry(readyRetry, actor, requestBody);
      const prepared = reusableReady?.prepared ?? await marketplaceRequest<PreparedMutation>(input.preparePath, {
        method: "POST",
        body: requestBody,
        ...(input.serverRecoveryOnly ? { headers: { "x-marketplace-recovery-only": "1" } } : {}),
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
      if (input.serverRecoveryOnly) {
        throw new Error("No submitted transaction is pending.");
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
      if (!input.serverRecoveryOnly && !isExplicitEip1193UserRejection(error)) {
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

  async function select(application: MarketplaceApplication, serverRecoveryOnly = false) {
    const basePath = applicationPath(campaignId, application.id);
    await executePrepared({ key: `select:${application.id}`, expectedFunctionName: "select_creator", preparePath: `${basePath}/select`, confirmPath: `${basePath}/selection`, serverRecoveryOnly });
  }

  async function accept(application: MarketplaceApplication, serverRecoveryOnly = false) {
    const basePath = applicationPath(campaignId, application.id);
    await executePrepared({ key: `accept:${application.id}`, expectedFunctionName: "accept_assignment", preparePath: `${basePath}/accept`, confirmPath: `${basePath}/acceptance`, serverRecoveryOnly });
  }

  async function decline(application: MarketplaceApplication) {
    const basePath = applicationPath(campaignId, application.id);
    await executePrepared({ key: `decline:${application.id}`, expectedFunctionName: "decline_assignment", preparePath: `${basePath}/decline` });
  }

  async function withdrawApplication(application: MarketplaceApplication, serverRecoveryOnly = false) {
    const basePath = applicationPath(campaignId, application.id);
    await executePrepared({ key: `withdraw:${application.id}`, expectedFunctionName: "withdraw_application", preparePath: `${basePath}/withdraw`, serverRecoveryOnly });
  }

  async function submitEvidence(application: MarketplaceApplication, event: FormEvent<HTMLFormElement>, serverRecoveryOnly = false) {
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
      serverRecoveryOnly,
    });
  }

  async function recoverSubmission(application: MarketplaceApplication) {
    const basePath = `${applicationPath(campaignId, application.id)}/submission`;
    await executePrepared({
      key: `submit:${application.id}`,
      expectedFunctionName: "submit_evidence",
      preparePath: basePath,
      recoveryOnly: true,
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

  async function cancelCampaign(serverRecoveryOnly = false) {
    const basePath = `/api/marketplace/campaigns/${encodeURIComponent(campaignId)}/cancel`;
    await executePrepared({ key: "cancel", expectedFunctionName: "cancel_campaign", preparePath: basePath, serverRecoveryOnly });
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
  const observedAt = actionClock;
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
    && contractBefore(campaign.deadline, observedAt)
    && !isBrand
    && !viewerApplication;
  const canCancel = isBrand
    && state.detail.canCancel
    && contractBefore(campaign.deadline, observedAt);
  const hasCancelRecovery = Boolean(recoveries.cancel);
  const canCheckServerCancel = isBrand
    && observedAt !== null
    && campaign.status === "open"
    && campaign.fundingStatus === "funded"
    && !canCancel;
  const transactionLocked = action.key !== null || fundingBusy || settlementBusy;

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
          <div><span>APPLICATIONS CLOSE</span><strong>{observedAt === null ? "DATE UNAVAILABLE" : deadlineLabel(campaign.deadline, observedAt)}</strong><small>{formatDate(campaign.deadline)}</small></div>
          <div><span>APPLICATIONS</span><strong>{campaign.applicationCount}</strong></div>
          <div><span>BRAND</span><strong>{campaign.brandName ?? shortenAddress(campaign.brandWallet)}</strong><small>{shortenAddress(campaign.brandWallet)}</small></div>
        </aside>
      </div>

      <CampaignTimeline campaign={campaign} />

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
              campaign={campaign}
              observedAt={observedAt}
              recoveries={recoveries}
              transactionLocked={transactionLocked}
              onSelect={select}
              onResolve={requestResolution}
              onRefund={refundUndetermined}
            />
          ) : null}
        </div>

        <aside className="campaign-action-panel">
          <div className="detail-panel-head"><span>YOUR ACTION</span><strong>{wallet.address ? shortenAddress(wallet.address) : "WALLET REQUIRED"}</strong></div>
          {!activeActor ? <WalletIntro wallet={wallet} /> : null}
          {isBrand && activeActor && campaign.fundingStatus !== "funded" ? <fieldset className="transaction-lock" disabled={transactionLocked}><CampaignFunding key={`funding:${activeActor}`} actor={activeActor} campaign={campaign} onFunded={loadDetail} onBusyChange={setFundingBusy} /></fieldset> : null}
          {isBrand && campaign.fundingStatus === "funded" ? <div className="action-intro"><p className="card-index">BRAND VIEW</p><h2>APPLICATIONS</h2></div> : null}
          {activeActor && viewerApplication ? (
            <CreatorApplication
              application={viewerApplication as MarketplaceApplication}
              campaign={campaign}
              actionKey={action.key}
              observedAt={observedAt}
              recoveries={recoveries}
              transactionLocked={transactionLocked}
              onAccept={accept}
              onDecline={decline}
              onWithdraw={withdrawApplication}
              onSubmit={submitEvidence}
              onRecoverSubmission={recoverSubmission}
              onResolve={requestResolution}
              onRefund={refundUndetermined}
              hasPendingRecovery={Boolean(recoveries.apply)}
              onRecoverPending={recoverPendingApplication}
            />
          ) : null}
          {activeActor && canApply ? <ApplicationForm busy={action.key === "apply"} disabled={transactionLocked} contentSource={contentSource} onSubmit={apply} /> : null}
          {activeActor && !isBrand && !viewerApplication && !canApply ? <div className="action-intro"><h2>APPLICATIONS CLOSED</h2><p>This campaign is not accepting applications.</p></div> : null}
          {activeActor && campaign.fundingStatus === "funded" && (isBrand || viewerApplication) ? <fieldset className="transaction-lock" disabled={transactionLocked}><SettlementControls key={`settlement:${activeActor}`} actor={activeActor} campaign={campaign} observedAt={observedAt} wallet={wallet} onUpdated={loadDetail} onBusyChange={setSettlementBusy} /></fieldset> : null}
          {hasCancelRecovery ? <button className="recovery-retry" type="button" disabled={transactionLocked} onClick={() => void cancelCampaign()}>{action.key === "cancel" ? "CHECKING…" : "CHECK PENDING TX"}</button> : canCancel ? <button className="recovery-retry" type="button" disabled={transactionLocked} onClick={() => void cancelCampaign()}>{action.key === "cancel" ? "CANCELLING…" : "CANCEL + REFUND CAMPAIGN"}</button> : canCheckServerCancel ? <button className="recovery-retry" type="button" disabled={transactionLocked} onClick={() => void cancelCampaign(true)}>{action.key === "cancel" ? "CHECKING…" : "CHECK PENDING TX"}</button> : null}
          {action.notice ? <p className="form-message" role="status">{action.notice}</p> : null}
          {action.error ? <p className="form-message error" role="alert">{action.error}</p> : null}
          {wallet.walletError ? <p className="form-message error" role="alert">{wallet.walletError}</p> : null}
          {wallet.walletNotice ? <p className="form-message" role="status">{wallet.walletNotice}</p> : null}
          {wallet.hasSession ? <button className="wallet-signout" type="button" disabled={transactionLocked || wallet.authenticating || wallet.disconnecting} onClick={() => void wallet.signOut().catch(() => undefined)}>{wallet.disconnecting ? "DISCONNECTING…" : "DISCONNECT WALLET"}</button> : null}
        </aside>
      </div>
    </section>
  );
}

function CampaignTimeline({ campaign }: { campaign: MarketplaceCampaign }) {
  return (
    <section className="campaign-detail-panel campaign-timing-panel" aria-label="Campaign timing">
      <div className="detail-panel-head"><span>CAMPAIGN TIMING</span><strong>CONTRACT TERMS</strong></div>
      <div className="campaign-timing-grid">
        <div><span>APPLICATIONS CLOSE</span><strong>{formatDate(campaign.deadline)}</strong></div>
        <div><span>SELECT BY / UNUSED FUNDS AVAILABLE</span><strong>{formatDate(campaign.selectionDeadline)}</strong></div>
        <div><span>WORK DUE</span><strong>{formatDate(campaign.submissionDeadline)}</strong></div>
        <div><span>RESOLUTION</span><strong>{formatDurationSeconds(campaign.retentionSeconds)} AFTER POST · {campaign.maxUndeterminedRetries} ATTEMPTS MAX</strong></div>
      </div>
      <p className="campaign-cancel-rule">SELECTED CREATORS: UP TO 24H TO ACCEPT · CANCEL BEFORE APPLICATIONS CLOSE · NO RESERVED CREATOR FUNDS</p>
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
      <h2>{wallet.restoring ? "RESTORING YOUR SESSION" : "CONNECT YOUR WALLET"}</h2>
      <button className="button" type="button" disabled={wallet.restoring || wallet.authenticating} onClick={() => void wallet.authenticate()}>{wallet.restoring ? "RESTORING…" : wallet.authenticating ? "SIGNING IN…" : "CONNECT + SIGN →"}</button>
      <Link href="/verify">NEED TO VERIFY? START HERE →</Link>
    </div>
  );
}

function ApplicationForm({ busy, disabled, contentSource, onSubmit }: { busy: boolean; disabled: boolean; contentSource: "X" | "FARCASTER"; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <form className="application-form" onSubmit={onSubmit}>
      <p className="card-index">CREATOR APPLICATION</p><h2>SET YOUR RATE.</h2>
      <p>Your rate is visible to the brand. Active {contentSourceLabel(contentSource)} identity required.</p>
      <label><span>REQUESTED RATE / TEST GEN</span><input name="requestedRateGen" inputMode="decimal" pattern="[0-9]+(?:\.[0-9]{1,18})?" placeholder="1200" required /></label>
      <label><span>WHY YOU FIT THIS BRIEF</span><textarea name="pitch" minLength={20} maxLength={1_500} rows={7} placeholder="Describe your audience, content angle, and relevant public work." required /></label>
      <button className="button" type="submit" disabled={disabled}>{busy ? "WAITING FOR FINALITY…" : "APPLY ON GENLAYER →"}</button>
    </form>
  );
}

function CreatorApplication({ application, campaign, actionKey, observedAt, recoveries, transactionLocked, onAccept, onDecline, onWithdraw, onSubmit, onRecoverSubmission, onResolve, onRefund, hasPendingRecovery, onRecoverPending }: {
  application: MarketplaceApplication;
  campaign: MarketplaceCampaign;
  actionKey: string | null;
  observedAt: number | null;
  recoveries: Readonly<Record<string, Recovery>>;
  transactionLocked: boolean;
  onAccept: (application: MarketplaceApplication, serverRecoveryOnly?: boolean) => Promise<void>;
  onDecline: (application: MarketplaceApplication) => Promise<void>;
  onWithdraw: (application: MarketplaceApplication, serverRecoveryOnly?: boolean) => Promise<void>;
  onSubmit: (application: MarketplaceApplication, event: FormEvent<HTMLFormElement>, serverRecoveryOnly?: boolean) => Promise<void>;
  onRecoverSubmission: (application: MarketplaceApplication) => Promise<void>;
  onResolve: (application: MarketplaceApplication) => Promise<void>;
  onRefund: (application: MarketplaceApplication) => Promise<void>;
  hasPendingRecovery: boolean;
  onRecoverPending: (application: MarketplaceApplication) => Promise<void>;
}) {
  const pending = application.status === "pending_onchain";
  const selected = application.status === "selected";
  const accepted = application.status === "accepted";
  const submitted = Boolean(application.submissionTxHash || application.contentId);
  const canWithdraw = application.status === "applied"
    && contractBefore(campaign.selectionDeadline, observedAt);
  const canAccept = selected
    && contractAtOrBefore(application.acceptanceDeadline, observedAt);
  const canSubmit = accepted
    && !submitted
    && campaign.status === "open"
    && contractAtOrBefore(campaign.submissionDeadline, observedAt);
  const withdrawKey = `withdraw:${application.id}`;
  const acceptKey = `accept:${application.id}`;
  const submitKey = `submit:${application.id}`;
  const hasWithdrawRecovery = Boolean(recoveries[withdrawKey]);
  const hasAcceptRecovery = Boolean(recoveries[acceptKey]);
  const hasSubmitRecovery = Boolean(recoveries[submitKey]);
  const canCheckServerWithdraw = application.status === "applied"
    && observedAt !== null
    && !contractBefore(campaign.selectionDeadline, observedAt);
  const canCheckServerAccept = selected
    && observedAt !== null
    && !contractAtOrBefore(application.acceptanceDeadline, observedAt);
  const canCheckServerSubmit = accepted
    && !submitted
    && observedAt !== null
    && !canSubmit;
  return (
    <div className="creator-application-summary">
      <p className="card-index">YOUR APPLICATION</p>
      <h2>{submitted ? "WORK SUBMITTED." : accepted ? "CAMPAIGN ACTIVE." : selected ? "YOU WERE SELECTED." : pending ? "FINISH APPLICATION." : "APPLICATION RECORDED."}</h2>
      <dl><div><dt>RATE</dt><dd>{genAtomsToDisplay(applicationRateAtoms(application))} TEST GEN</dd></div><div><dt>STATUS</dt><dd>{application.status.replaceAll("_", " ").toUpperCase()}</dd></div></dl>
      <p>{application.pitch}</p>
      {selected && application.acceptanceDeadline ? <p>ACCEPT BY {formatDate(application.acceptanceDeadline).toUpperCase()}</p> : null}
      <Link className="profile-link" href={`/marketplace/creators/${application.creatorWallet}`}>VIEW PUBLIC PROFILE →</Link>
      {pending && hasPendingRecovery ? <button className="button" type="button" disabled={transactionLocked} onClick={() => void onRecoverPending(application)}>{actionKey === "apply" ? "CONFIRMING…" : "FINISH APPLICATION →"}</button> : null}
      {pending && !hasPendingRecovery ? <p className="form-message">ORIGINAL TRANSACTION REQUIRED.</p> : null}
      {hasWithdrawRecovery ? <button className="recovery-retry" type="button" disabled={transactionLocked} onClick={() => void onWithdraw(application)}>{actionKey === withdrawKey ? "CHECKING…" : "CHECK PENDING TX"}</button> : canWithdraw ? <button className="recovery-retry" type="button" disabled={transactionLocked} onClick={() => void onWithdraw(application)}>WITHDRAW APPLICATION</button> : canCheckServerWithdraw ? <button className="recovery-retry" type="button" disabled={transactionLocked} onClick={() => void onWithdraw(application, true)}>{actionKey === withdrawKey ? "CHECKING…" : "CHECK PENDING TX"}</button> : null}
      {hasAcceptRecovery ? <button className="button" type="button" disabled={transactionLocked} onClick={() => void onAccept(application)}>{actionKey === acceptKey ? "CHECKING…" : "CHECK PENDING TX"}</button> : selected ? <>{canAccept ? <button className="button" type="button" disabled={transactionLocked} onClick={() => void onAccept(application)}>ACCEPT CAMPAIGN →</button> : canCheckServerAccept ? <button className="button" type="button" disabled={transactionLocked} onClick={() => void onAccept(application, true)}>{actionKey === acceptKey ? "CHECKING…" : "CHECK PENDING TX"}</button> : null}<button className="recovery-retry" type="button" disabled={transactionLocked} onClick={() => void onDecline(application)}>DECLINE ASSIGNMENT</button></> : null}
      {hasSubmitRecovery ? <button className="button" type="button" disabled={transactionLocked} onClick={() => void onRecoverSubmission(application)}>{actionKey === submitKey ? "CHECKING…" : "CHECK PENDING TX"}</button> : canSubmit ? <EvidenceSubmissionForm application={application} campaign={campaign} busy={actionKey === submitKey} disabled={transactionLocked} onSubmit={onSubmit} /> : canCheckServerSubmit ? <EvidenceSubmissionForm application={application} campaign={campaign} busy={actionKey === submitKey} disabled={transactionLocked} recoveryCheck onSubmit={onSubmit} /> : null}
      {submitted || application.resolutionOutcome ? <ResolutionControl application={application} campaign={campaign} actionKey={actionKey} observedAt={observedAt} transactionLocked={transactionLocked} onResolve={onResolve} onRefund={onRefund} /> : null}
    </div>
  );
}

function BrandApplications({ applications, actionKey, campaign, observedAt, recoveries, transactionLocked, onSelect, onResolve, onRefund }: {
  applications: MarketplaceApplication[];
  actionKey: string | null;
  campaign: MarketplaceCampaign;
  observedAt: number | null;
  recoveries: Readonly<Record<string, Recovery>>;
  transactionLocked: boolean;
  onSelect: (application: MarketplaceApplication, serverRecoveryOnly?: boolean) => Promise<void>;
  onResolve: (application: MarketplaceApplication) => Promise<void>;
  onRefund: (application: MarketplaceApplication) => Promise<void>;
}) {
  return (
    <section className="campaign-detail-panel application-list-panel">
      <div className="detail-panel-head"><span>PRIVATE BRAND VIEW</span><strong>{applications.length} APPLICATIONS</strong></div>
      {applications.length === 0 ? <p className="panel-empty">No creator applications have been submitted.</p> : null}
      {applications.map((application) => {
        const timing = resolutionTiming(application, campaign, observedAt);
        const canSelect = campaign.status === "open"
          && application.status === "applied"
          && contractBefore(campaign.selectionDeadline, observedAt);
        const selectKey = `select:${application.id}`;
        const hasSelectRecovery = Boolean(recoveries[selectKey]);
        const canCheckServerSelect = application.status === "applied"
          && observedAt !== null
          && !contractBefore(campaign.selectionDeadline, observedAt);
        return (
          <article className="brand-application" key={application.id}>
            <div><Link className="profile-link" href={`/marketplace/creators/${application.creatorWallet}`}>{application.creatorHandle ?? shortenAddress(application.creatorWallet)}</Link><strong>{genAtomsToDisplay(applicationRateAtoms(application))} TEST GEN</strong></div>
            <p>{application.pitch}</p>
            <div><small>{application.status.toUpperCase()} · {application.status === "selected" && application.acceptanceDeadline ? `ACCEPT BY ${formatDate(application.acceptanceDeadline)}` : formatDate(application.createdAt)}</small>{hasSelectRecovery ? <button className="verify-secondary" type="button" disabled={transactionLocked} onClick={() => void onSelect(application)}>{actionKey === selectKey ? "CHECKING…" : "CHECK PENDING TX"}</button> : canSelect ? <button className="verify-secondary" type="button" disabled={transactionLocked} onClick={() => void onSelect(application)}>{actionKey === selectKey ? "WAITING FOR FINALITY…" : "SELECT CREATOR"}</button> : canCheckServerSelect ? <button className="verify-secondary" type="button" disabled={transactionLocked} onClick={() => void onSelect(application, true)}>{actionKey === selectKey ? "CHECKING…" : "CHECK PENDING TX"}</button> : null}</div>
            {timing.canResolve ? <button className="verify-secondary" type="button" disabled={transactionLocked} onClick={() => void onResolve(application)}>REQUEST RESOLUTION</button> : null}
            {timing.waiting ? <small>CAN RESOLVE {formatDate(timing.unlocksAt!)}</small> : null}
            {timing.canRefund ? <button className="recovery-retry" type="button" disabled={transactionLocked} onClick={() => void onRefund(application)}>REFUND</button> : null}
            {timing.refundWaiting ? <small>REFUND UNLOCKS {formatDate(timing.refundUnlocksAt!)}</small> : null}
          </article>
        );
      })}
    </section>
  );
}

function SettlementControls({ actor, campaign, observedAt, wallet, onUpdated, onBusyChange }: { actor: string; campaign: MarketplaceCampaign; observedAt: number | null; wallet: ReturnType<typeof useMarketplaceWallet>; onUpdated: (signal?: AbortSignal) => Promise<void>; onBusyChange: (busy: boolean) => void }) {
  const [settlement, setSettlement] = useState<MarketplaceSettlementStateDto | null>(null);
  const [phase, setPhase] = useState<"loading" | "idle" | "claiming" | "executing" | "refunding">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const basePath = `/api/marketplace/campaigns/${encodeURIComponent(campaign.id)}/settlement`;
  const refundRecoveryKey = settlementRecoveryStorageKey(campaign.id, actor, "refund-unallocated");
  const [hasRefundRecovery, setHasRefundRecovery] = useState(false);
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
    const timer = window.setTimeout(() => {
      setHasRefundRecovery(Boolean(readRecovery(refundRecoveryKey)));
      void load(controller.signal);
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load, refundRecoveryKey]);

  const refundDeadlineReached = contractAtOrAfter(settlement?.selectionDeadline, observedAt);
  const settlementRole = settlement?.role;
  const settlementUnallocated = settlement?.unallocatedAtto;
  const settlementCanRefund = settlement?.canRefundUnallocated;
  useEffect(() => {
    if (
      !refundDeadlineReached
      || settlementRole !== "brand"
      || settlementUnallocated === "0"
      || settlementCanRefund
    ) return;
    let cancelled = false;
    let timer: number | null = null;
    const recheck = async () => {
      await load();
      if (cancelled) return;
      timer = window.setTimeout(() => void recheck(), 15_000);
    };
    void recheck();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [load, refundDeadlineReached, settlementCanRefund, settlementRole, settlementUnallocated]);

  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  async function execute(kind: SettlementActionKind, serverRecoveryOnly = false) {
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
        if (kind === "refund-unallocated") setHasRefundRecovery(false);
        setMessage(settlementSuccessMessage(kind));
        await load(); await onUpdated();
        return;
      }
      const prepared = (serverRecoveryOnly ? undefined : readyRetries.current[kind])
        ?? await marketplaceRequest<PreparedMutation>(preparePath, {
          method: "POST",
          body: "{}",
          ...(serverRecoveryOnly ? { headers: { "x-marketplace-recovery-only": "1" } } : {}),
        });
      const submitted = preparedMarketplaceRecovery(prepared);
      if (submitted) {
        window.localStorage.setItem(recoveryKey, JSON.stringify(submitted));
        if (kind === "refund-unallocated") setHasRefundRecovery(true);
        await recordSubmittedMarketplaceTransaction(submitted.preparedId, submitted.txHash);
        await marketplaceRequest(`${preparePath}/confirm`, {
          method: "POST",
          body: JSON.stringify(submitted),
        });
        window.localStorage.removeItem(recoveryKey);
        if (kind === "refund-unallocated") setHasRefundRecovery(false);
        setMessage(settlementSuccessMessage(kind));
        await load(); await onUpdated();
        return;
      }
      if (serverRecoveryOnly) {
        throw new Error("No submitted transaction is pending.");
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
          if (kind === "refund-unallocated") setHasRefundRecovery(true);
          await recordSubmittedMarketplaceTransaction(prepared.preparedId, hash);
        },
        onStage: (stage) => setMessage(transactionNotice(stage)),
      });
      await marketplaceRequest(`${preparePath}/confirm`, { method: "POST", body: JSON.stringify({ preparedId: prepared.preparedId, txHash }) });
      window.localStorage.removeItem(recoveryKey);
      if (kind === "refund-unallocated") setHasRefundRecovery(false);
      setMessage(settlementSuccessMessage(kind));
      await load(); await onUpdated();
    } catch (settlementError) {
      if (!serverRecoveryOnly && !isExplicitEip1193UserRejection(settlementError)) {
        delete readyRetries.current[kind];
      }
      if (isTerminalMarketplaceTransactionError(settlementError)) {
        window.localStorage.removeItem(recoveryKey);
        if (kind === "refund-unallocated") setHasRefundRecovery(false);
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
  const isBrandActor = actor === campaign.brandWallet.toLowerCase();
  const canCheckServerRefund = view?.role === "brand"
    && unallocated === "0"
    && /^\d+$/.test(campaign.availableAtto)
    && BigInt(campaign.availableAtto) > 0n;
  return (
    <section className="settlement-controls" aria-live="polite">
      <span>GENLAYER BALANCES</span><strong>NATIVE GEN</strong>
      {view ? <dl><div><dt>CLAIMABLE</dt><dd>{genAtomsToDisplay(claimable)} TEST GEN</dd></div>{view.role === "brand" ? <div><dt>UNUSED BUDGET</dt><dd>{genAtomsToDisplay(unallocated)} TEST GEN</dd></div> : null}{view.withdrawalStatus ? <div><dt>WITHDRAWAL</dt><dd>{view.withdrawalStatus.replaceAll("_", " ")}</dd></div> : null}</dl> : null}
      {phase === "loading" ? <p>READING GENLAYER STATE…</p> : null}
      {isBrandActor && hasRefundRecovery ? <button className="verify-secondary" type="button" disabled={busy} onClick={() => void execute("refund-unallocated")}>{phase === "refunding" ? "CHECKING…" : "CHECK PENDING TX"}</button> : view?.role === "brand" && unallocated !== "0" && view.canRefundUnallocated ? <button className="verify-secondary" type="button" disabled={busy} onClick={() => void execute("refund-unallocated")}>{phase === "refunding" ? "WAITING FOR FINALITY…" : "REFUND UNUSED GEN"}</button> : canCheckServerRefund ? <button className="verify-secondary" type="button" disabled={busy} onClick={() => void execute("refund-unallocated", true)}>{phase === "refunding" ? "CHECKING…" : "CHECK PENDING TX"}</button> : null}
      {view?.role === "brand" && unallocated !== "0" && !view.canRefundUnallocated ? <p className="form-message">UNUSED BUDGET REFUND AVAILABLE {formatDate(view.selectionDeadline).toUpperCase()}</p> : null}
      {view?.withdrawalStatus === "PENDING" ? <button className="button" type="button" disabled={busy} onClick={() => void execute("execute-claim")}>{phase === "executing" ? "WAITING FOR FINALITY…" : "EXECUTE GEN WITHDRAWAL →"}</button> : null}
      {view?.withdrawalStatus === "EMITTED_UNCONFIRMED" ? <p className="form-message">TRANSFER EMITTED · AWAITING DELIVERY CONFIRMATION · NOT YET PAID</p> : null}
      {view?.withdrawalStatus === "CONFIRMED" ? <p className="form-message success">WITHDRAWAL DELIVERY CONFIRMED</p> : null}
      {(!view?.withdrawalStatus || ["RESTORED_FAILED", "CONFIRMED"].includes(view.withdrawalStatus)) && (view?.canClaim || claimable !== "0") ? <button className="button" type="button" disabled={busy} onClick={() => void execute("claim")}>{phase === "claiming" ? "WAITING FOR FINALITY…" : "REQUEST GEN WITHDRAWAL →"}</button> : null}
      {message ? <p className="form-message success">{message}</p> : null}
      {error ? <><p className="form-message error" role="alert">{error}</p><button className="recovery-retry" type="button" disabled={busy} onClick={() => void load()}>REFRESH CONTRACT STATE</button></> : null}
    </section>
  );
}

function EvidenceSubmissionForm({ application, campaign, busy, disabled, recoveryCheck = false, onSubmit }: { application: MarketplaceApplication; campaign: MarketplaceCampaign; busy: boolean; disabled: boolean; recoveryCheck?: boolean; onSubmit: (application: MarketplaceApplication, event: FormEvent<HTMLFormElement>, serverRecoveryOnly?: boolean) => Promise<void> }) {
  const source = campaignContentSource(campaign);
  const handle = application.creatorHandle?.replace(/^@/, "") ?? "";
  const contentId = application.contentId ?? "";
  const isFarcaster = source === "FARCASTER";
  return (
    <form className="evidence-form" onSubmit={(event) => void onSubmit(application, event, recoveryCheck)}>
      <span>PUBLIC TEXT-POST EVIDENCE</span><strong>{recoveryCheck ? "CHECK PENDING SUBMISSION." : `SUBMIT YOUR ${contentSourceLabel(source)} POST.`}</strong>
      <p>{recoveryCheck ? "Paste the same link." : `Paste the public ${isFarcaster ? "cast" : "post"} link from @${handle || "handle"}.`}</p>
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
      <button className="button" type="submit" disabled={disabled}>{busy ? (recoveryCheck ? "CHECKING…" : "WAITING FOR FINALITY…") : recoveryCheck ? "CHECK PENDING TX" : "SUBMIT ON GENLAYER →"}</button>
    </form>
  );
}

function ResolutionControl({ application, campaign, actionKey, observedAt, transactionLocked, onResolve, onRefund }: { application: MarketplaceApplication; campaign: MarketplaceCampaign; actionKey: string | null; observedAt: number | null; transactionLocked: boolean; onResolve: (application: MarketplaceApplication) => Promise<void>; onRefund: (application: MarketplaceApplication) => Promise<void> }) {
  const transaction = application.resolutionTxHash ?? application.genlayerTxHash;
  const transactionUrl = studioNetExplorerLink("tx", transaction);
  const timing = resolutionTiming(application, campaign, observedAt);
  if (application.status === "undetermined" && application.resolutionOutcome === "undetermined") {
    const status = timing.retriesExhausted
      ? timing.canRefund ? "REFUND READY." : "REFUND LOCKED."
      : "UNDETERMINED.";
    const message = timing.retriesExhausted
      ? timing.canRefund
        ? "Refund ready."
        : timing.refundWaiting
          ? `Refund unlocks ${formatDate(timing.refundUnlocksAt!)}.`
          : "Refund unavailable."
      : timing.canResolve
        ? "Retry ready."
        : timing.waiting
          ? `Retry unlocks ${formatDate(timing.unlocksAt!)}.`
          : "Retry unavailable.";
    return <div className="resolution-control undetermined"><span>PREVIOUS ROUND</span><strong>{status}</strong><p>{message}</p><ResolutionChecks application={application} />{transactionUrl ? <a href={transactionUrl} target="_blank" rel="noreferrer">VIEW STUDIONET TRANSACTION →</a> : null}{!timing.retriesExhausted ? <button className="verify-secondary" type="button" disabled={!timing.canResolve || transactionLocked} onClick={() => void onResolve(application)}>RETRY RESOLUTION</button> : null}{timing.canRefund ? <button className="recovery-retry" type="button" disabled={transactionLocked} onClick={() => void onRefund(application)}>REFUND</button> : null}</div>;
  }
  if (application.resolutionOutcome) {
    const outcome = application.status === "refunded"
      ? "REFUNDED"
      : application.resolutionOutcome.toUpperCase();
    return <div className="resolution-control confirmed"><span>FINAL RESOLUTION</span><strong>{outcome}</strong><ResolutionChecks application={application} />{transactionUrl ? <a href={transactionUrl} target="_blank" rel="noreferrer">VIEW FINAL TRANSACTION →</a> : null}</div>;
  }
  if (!application.submittedAt) return null;
  return <div className="resolution-control"><span>GENLAYER RESOLUTION</span><strong>{timing.canResolve ? "READY." : "WAITING."}</strong><p>{timing.canResolve ? "Ready to resolve." : timing.waiting ? `Can resolve ${formatDate(timing.unlocksAt!)}.` : "Resolution unavailable."}</p><button className="verify-secondary" type="button" disabled={!timing.canResolve || transactionLocked} onClick={() => void onResolve(application)}>{actionKey === `resolve:${application.id}` ? "WAITING FOR FINALITY…" : "REQUEST RESOLUTION"}</button></div>;
}

function resolutionTiming(
  application: MarketplaceApplication,
  campaign: MarketplaceCampaign,
  observedAt: number | null,
): Readonly<{
  canResolve: boolean;
  retriesExhausted: boolean;
  waiting: boolean;
  unlocksAt: string | null;
  canRefund: boolean;
  refundWaiting: boolean;
  refundUnlocksAt: string | null;
}> {
  const unlocksAt = application.resolutionEligibleAt;
  const refundUnlocksAt = application.undeterminedRefundEligibleAt;
  const resolvableState = ["submitted", "undetermined"].includes(application.status);
  const retriesExhausted = application.status === "undetermined"
    && application.resolutionAttempts >= campaign.maxUndeterminedRetries;
  const timingKnown = contractEpoch(unlocksAt) !== null;
  const refundTimingKnown = contractEpoch(refundUnlocksAt) !== null;
  const canResolve = resolvableState
    && !retriesExhausted
    && timingKnown
    && contractAtOrAfter(unlocksAt, observedAt);
  const canRefund = retriesExhausted
    && refundTimingKnown
    && contractAtOrAfter(refundUnlocksAt, observedAt);
  return {
    canResolve,
    retriesExhausted,
    waiting: resolvableState && !retriesExhausted && timingKnown && !canResolve,
    unlocksAt,
    canRefund,
    refundWaiting: retriesExhausted && refundTimingKnown && !canRefund,
    refundUnlocksAt,
  };
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

function contractEpoch(value: string | null | undefined): number | null {
  const milliseconds = Date.parse(value ?? "");
  if (!Number.isFinite(milliseconds)) return null;
  return Math.floor(milliseconds / 1_000);
}

function observedAtMs(value: string | null | undefined): number | null {
  const milliseconds = Date.parse(value ?? "");
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function contractBefore(value: string | null | undefined, nowMs: number | null): boolean {
  const deadline = contractEpoch(value);
  return deadline !== null && nowMs !== null && Math.floor(nowMs / 1_000) < deadline;
}

function contractAtOrBefore(value: string | null | undefined, nowMs: number | null): boolean {
  const deadline = contractEpoch(value);
  return deadline !== null && nowMs !== null && Math.floor(nowMs / 1_000) <= deadline;
}

function contractAtOrAfter(value: string | null | undefined, nowMs: number | null): boolean {
  const deadline = contractEpoch(value);
  return deadline !== null && nowMs !== null && Math.floor(nowMs / 1_000) >= deadline;
}

function nextCampaignActionBoundary(
  detail: CampaignDetailResponse,
  snapshotMs: number | null,
): number | null {
  if (snapshotMs === null) return null;
  const candidates: number[] = [];
  const addBoundary = (value: string | null | undefined, closesAfterEquality = false) => {
    const epoch = contractEpoch(value);
    if (epoch === null) return;
    const boundary = (epoch + (closesAfterEquality ? 1 : 0)) * 1_000;
    if (boundary > snapshotMs) candidates.push(boundary);
  };
  addBoundary(detail.campaign.deadline);
  addBoundary(detail.campaign.selectionDeadline);
  addBoundary(detail.campaign.submissionDeadline, true);
  const applications = detail.viewerApplication
    ? [...detail.applications, detail.viewerApplication]
    : detail.applications;
  for (const application of applications) {
    if (application.status === "selected") {
      addBoundary(application.acceptanceDeadline, true);
    }
    if (["submitted", "undetermined"].includes(application.status)) {
      addBoundary(application.resolutionEligibleAt);
    }
    if (
      application.status === "undetermined"
      && application.resolutionAttempts >= detail.campaign.maxUndeterminedRetries
    ) {
      addBoundary(application.undeterminedRefundEligibleAt);
    }
  }
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function formatDurationSeconds(value: string): string {
  if (!/^\d+$/.test(value)) return "TIMED";
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return "TIMED";
  if (seconds <= 48 * 60 * 60 && seconds % (60 * 60) === 0) return `${seconds / (60 * 60)}H`;
  if (seconds % (24 * 60 * 60) === 0) return `${seconds / (24 * 60 * 60)}D`;
  if (seconds % (60 * 60) === 0) return `${seconds / (60 * 60)}H`;
  return `${Math.ceil(seconds / 60)}M`;
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
