"use client";

import { useEffect, useRef, useState } from "react";
import {
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
} from "../../marketplace-transaction";
import {
  campaignBudgetAtoms,
  type CampaignMutationResponse,
  genAtomsToDisplay,
  type MarketplaceCampaign,
  type MarketplaceTransactionDto,
  shortenAddress,
  STUDIONET_FUNDING_GUIDE_URL,
  studioNetExplorerLink,
} from "../../marketplace-types";
import { useMarketplaceWallet } from "../../use-marketplace-wallet";

type FundingPhase = "idle" | "preparing" | "wallet" | "submitted" | "finality" | "recording" | "error";
type PreparedFundingResponse = CampaignMutationResponse & { preparedId: string; transaction?: MarketplaceTransactionDto; recovery?: unknown };

export function CampaignFunding({ actor, campaign, onFunded, onBusyChange }: { actor: string; campaign: MarketplaceCampaign; onFunded: () => Promise<void>; onBusyChange: (busy: boolean) => void }) {
  const wallet = useMarketplaceWallet();
  const [phase, setPhase] = useState<FundingPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const recoveryKey = `influencedx:studionet-funding:v2:${campaign.id}:${actor}`;
  const readyRetry = useRef<PreparedFundingResponse | null>(null);
  const [submitted, setSubmitted] = useState<{ preparedId: string; txHash: string } | null>(() => {
    if (typeof window === "undefined") return null;
    const value = window.localStorage.getItem(recoveryKey);
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as { preparedId?: unknown; txHash?: unknown };
      return typeof parsed.preparedId === "string"
        && typeof parsed.txHash === "string"
        && /^0x[0-9a-fA-F]{64}$/.test(parsed.txHash)
        ? { preparedId: parsed.preparedId, txHash: parsed.txHash }
        : null;
    } catch {
      return null;
    }
  });

  useEffect(() => () => {
    readyRetry.current = null;
    onBusyChange(false);
  }, [onBusyChange]);

  async function confirm(preparedId: string, txHash: string) {
    setPhase("recording");
    setMessage("Recording finalized funding…");
    await recordSubmittedMarketplaceTransaction(preparedId, txHash);
    await marketplaceRequest<CampaignMutationResponse>(
      `/api/marketplace/campaigns/${encodeURIComponent(campaign.id)}/funding`,
      { method: "POST", body: JSON.stringify({ preparedId, txHash }) },
    );
    window.localStorage.removeItem(recoveryKey);
    setSubmitted(null);
    await onFunded();
    setPhase("idle");
    setMessage(null);
  }

  async function fund() {
    onBusyChange(true);
    setPhase("preparing");
    setMessage("Preparing funding…");
    try {
      const brand = await wallet.authenticate();
      if (brand !== actor || brand !== campaign.brandWallet.toLowerCase()) {
        throw new Error("Connect the brand wallet that created this campaign.");
      }
      if (submitted) {
        await confirm(submitted.preparedId, submitted.txHash);
        return;
      }
      if (!wallet.isStudioNet) await wallet.switchToStudioNet();
      const prepared = readyRetry.current ?? await marketplaceRequest<PreparedFundingResponse>(
        `/api/marketplace/campaigns/${encodeURIComponent(campaign.id)}/funding/prepare`,
        { method: "POST", body: JSON.stringify({ brandWallet: brand }) },
      );
      const reusable = preparedMarketplaceRecovery(prepared);
      if (reusable) {
        window.localStorage.setItem(recoveryKey, JSON.stringify(reusable));
        setSubmitted(reusable);
        await confirm(reusable.preparedId, reusable.txHash);
        return;
      }
      if (!prepared.transaction) {
        throw new Error("The prepared marketplace transaction is unavailable.");
      }
      readyRetry.current = prepared;
      const txHash = await broadcastMarketplaceTransaction(prepared.transaction, brand, {
        expectedFunctionName: "create_campaign",
        expectedValue: campaignBudgetAtoms(campaign),
        onSubmitted: async (hash) => {
          const recovery = { preparedId: prepared.preparedId, txHash: hash };
          readyRetry.current = null;
          window.localStorage.setItem(recoveryKey, JSON.stringify(recovery));
          setSubmitted(recovery);
          await recordSubmittedMarketplaceTransaction(prepared.preparedId, hash);
        },
        onStage: (stage) => setFundingStage(stage, setPhase, setMessage),
      });
      setPhase("recording");
      setMessage("Recording finalized funding…");
      await marketplaceRequest<CampaignMutationResponse>(
        `/api/marketplace/campaigns/${encodeURIComponent(campaign.id)}/funding`,
        { method: "POST", body: JSON.stringify({ preparedId: prepared.preparedId, txHash }) },
      );
      window.localStorage.removeItem(recoveryKey);
      setSubmitted(null);
      await onFunded();
      setPhase("idle");
      setMessage(null);
    } catch (error) {
      if (!isExplicitEip1193UserRejection(error)) {
        readyRetry.current = null;
      }
      if (isTerminalMarketplaceTransactionError(error)) {
        window.localStorage.removeItem(recoveryKey);
        setSubmitted(null);
        await onFunded();
      }
      setPhase("error");
      setMessage(marketplaceErrorMessage(error));
    } finally {
      onBusyChange(false);
    }
  }

  const fundingTxUrl = studioNetExplorerLink("tx", campaign.fundingTxHash);
  if (campaign.fundingStatus === "funded") {
    return (
      <div className="funding-panel confirmed">
        <span>CAMPAIGN BALANCE</span>
        <strong>{genAtomsToDisplay(campaignBudgetAtoms(campaign))} TEST GEN</strong>
        <p>FUNDED + FINALIZED · CAMPAIGN {campaign.genlayerCampaignId ?? "—"}</p>
        {fundingTxUrl ? <a href={fundingTxUrl} target="_blank" rel="noreferrer">VIEW STUDIONET TRANSACTION →</a> : null}
      </div>
    );
  }

  const submittedTxUrl = studioNetExplorerLink("tx", submitted?.txHash);
  const busy = !(["idle", "error"] as FundingPhase[]).includes(phase);
  return (
    <div className="funding-panel" aria-live="polite">
      <span>GENLAYER FUNDING / {campaign.fundingStatus.toUpperCase()}</span>
      <strong>LOCK THE CAMPAIGN BUDGET.</strong>
      <p>
        Lock {genAtomsToDisplay(campaignBudgetAtoms(campaign))} test GEN from {shortenAddress(campaign.brandWallet)}. The campaign opens after finality.
      </p>
      <p>Need test GEN? Use the built-in 💧 faucet for this wallet. <a href={STUDIONET_FUNDING_GUIDE_URL} target="_blank" rel="noreferrer">OFFICIAL INSTRUCTIONS ↗</a></p>
      {message ? <p className={phase === "error" ? "form-message error" : "form-message"} role={phase === "error" ? "alert" : "status"}>{message}</p> : null}
      {submittedTxUrl ? <a href={submittedTxUrl} target="_blank" rel="noreferrer">VIEW SUBMITTED TRANSACTION →</a> : null}
      <button className="button" type="button" disabled={busy} onClick={() => void fund()}>
        {submitted ? "RECONCILE SUBMITTED TRANSACTION →" : phase === "error" ? "RETRY FUNDING →" : "FUND WITH TEST GEN →"}
      </button>
    </div>
  );
}

function setFundingStage(
  stage: GenLayerTransactionStage,
  setPhase: (phase: FundingPhase) => void,
  setMessage: (message: string) => void,
): void {
  if (stage === "wallet") {
    setPhase("wallet");
    setMessage("Confirm the GEN deposit in your wallet…");
  } else if (stage === "submitted") {
    setPhase("submitted");
    setMessage("Submitted. Transaction saved for recovery.");
  } else if (stage === "finality") {
    setPhase("finality");
    setMessage("Waiting for GenLayer finality…");
  }
}
