"use client";

import { useState } from "react";
import { marketplaceErrorMessage, marketplaceRequest } from "../../marketplace-api";
import { broadcastMarketplaceTransaction, type GenLayerTransactionStage } from "../../marketplace-transaction";
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
type PreparedFundingResponse = CampaignMutationResponse & { preparedId: string; transaction: MarketplaceTransactionDto };

export function CampaignFunding({ campaign, onFunded }: { campaign: MarketplaceCampaign; onFunded: () => Promise<void> }) {
  const wallet = useMarketplaceWallet();
  const [phase, setPhase] = useState<FundingPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const recoveryKey = `influencedx:studionet-funding:${campaign.id}`;
  const [submitted, setSubmitted] = useState<{ preparedId: string; txHash: string } | null>(() => {
    if (typeof window === "undefined") return null;
    const value = window.sessionStorage.getItem(recoveryKey);
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

  async function confirm(preparedId: string, txHash: string) {
    setPhase("recording");
    setMessage("Recording finalized funding…");
    await marketplaceRequest<CampaignMutationResponse>(
      `/api/marketplace/campaigns/${encodeURIComponent(campaign.id)}/funding`,
      { method: "POST", body: JSON.stringify({ preparedId, txHash }) },
    );
    window.sessionStorage.removeItem(recoveryKey);
    setSubmitted(null);
    await onFunded();
    setPhase("idle");
    setMessage(null);
  }

  async function fund() {
    setPhase("preparing");
    setMessage("Preparing funding…");
    try {
      const brand = await wallet.authenticate();
      if (brand !== campaign.brandWallet.toLowerCase()) {
        throw new Error("Connect the brand wallet that created this campaign.");
      }
      if (submitted) {
        await confirm(submitted.preparedId, submitted.txHash);
        return;
      }
      if (!wallet.isStudioNet) await wallet.switchToStudioNet();
      const prepared = await marketplaceRequest<PreparedFundingResponse>(
        `/api/marketplace/campaigns/${encodeURIComponent(campaign.id)}/funding/prepare`,
        { method: "POST", body: JSON.stringify({ brandWallet: brand }) },
      );
      const txHash = await broadcastMarketplaceTransaction(prepared.transaction, brand, {
        expectedFunctionName: "create_campaign",
        expectedValue: campaignBudgetAtoms(campaign),
        onSubmitted: (hash) => {
          const recovery = { preparedId: prepared.preparedId, txHash: hash };
          window.sessionStorage.setItem(recoveryKey, JSON.stringify(recovery));
          setSubmitted(recovery);
        },
        onStage: (stage) => setFundingStage(stage, setPhase, setMessage),
      });
      setPhase("recording");
      setMessage("Recording finalized funding…");
      await marketplaceRequest<CampaignMutationResponse>(
        `/api/marketplace/campaigns/${encodeURIComponent(campaign.id)}/funding`,
        { method: "POST", body: JSON.stringify({ preparedId: prepared.preparedId, txHash }) },
      );
      window.sessionStorage.removeItem(recoveryKey);
      setSubmitted(null);
      await onFunded();
      setPhase("idle");
      setMessage(null);
    } catch (error) {
      setPhase("error");
      setMessage(marketplaceErrorMessage(error));
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
