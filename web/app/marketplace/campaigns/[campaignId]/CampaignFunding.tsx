"use client";

import { useState } from "react";
import { marketplaceErrorMessage, marketplaceRequest } from "../../marketplace-api";
import {
  type CampaignMutationResponse,
  type MarketplaceCampaign,
  shortenAddress,
  usdcAtomsToDisplay,
} from "../../marketplace-types";
import { useMarketplaceWallet } from "../../use-marketplace-wallet";

type FundingPhase = "idle" | "checking" | "approving" | "funding" | "recording" | "error";

export function CampaignFunding({ campaign, onFunded }: { campaign: MarketplaceCampaign; onFunded: () => Promise<void> }) {
  const wallet = useMarketplaceWallet();
  const [phase, setPhase] = useState<FundingPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const recoveryKey = `influencedx:campaign-funding:${campaign.id}`;
  const [confirmedFundingHash, setConfirmedFundingHash] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const value =
      window.sessionStorage.getItem(recoveryKey) ??
      new URL(window.location.href).searchParams.get("fundingTxHash");
    return value && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : null;
  });

  async function recordConfirmedFunding(txHash: string) {
    setPhase("recording");
    setMessage("Base confirmed funding. Recording the verified receipt…");
    await marketplaceRequest<CampaignMutationResponse>(
      `/api/marketplace/campaigns/${encodeURIComponent(campaign.id)}/funding`,
      { method: "POST", body: JSON.stringify({ txHash }) },
    );
    window.sessionStorage.removeItem(recoveryKey);
    setConfirmedFundingHash(null);
    await onFunded();
    setPhase("idle");
    setMessage(null);
  }

  async function fund() {
    setPhase("checking");
    setMessage("Checking your test-USDC balance and allowance…");
    try {
      const brand = await wallet.authenticate();
      if (brand !== campaign.brandWallet.toLowerCase()) {
        throw new Error("Connect the brand wallet that created this campaign.");
      }
      if (confirmedFundingHash) {
        await recordConfirmedFunding(confirmedFundingHash);
        return;
      }
      if (!wallet.isBaseSepolia) await wallet.switchToBaseSepolia();

      const [{ createPublicClient, createWalletClient, custom, decodeFunctionResult, formatUnits }, { baseSepolia }, chain] = await Promise.all([
        import("viem"),
        import("viem/chains"),
        import("@/lib/marketplace-chain"),
      ]);
      if (!window.ethereum) throw new Error("No browser wallet is available.");
      const transport = custom(window.ethereum);
      const publicClient = createPublicClient({ chain: baseSepolia, transport });
      const walletClient = createWalletClient({ chain: baseSepolia, transport });
      const budgetHuman = formatUnits(BigInt(campaign.budgetUsdc), 6);
      const plan = chain.prepareCampaignFunding({
        chainId: campaign.chainId,
        brand,
        termsDocument: campaign.termsDocument,
        budgetUsdc: budgetHuman,
        applicationDeadline: campaign.termsDocument.applicationDeadline,
        selectionDeadline: campaign.termsDocument.selectionDeadline,
        submissionDeadline: campaign.termsDocument.submissionDeadline,
        retentionSeconds: campaign.termsDocument.retentionSeconds,
        nowSeconds: Math.floor(Date.now() / 1_000),
      });
      if (plan.termsHash.toLowerCase() !== campaign.termsHash.toLowerCase()) {
        throw new Error("The saved campaign terms do not match the funding transaction. Funding was stopped.");
      }

      const [balanceCall, allowanceCall] = await Promise.all([
        publicClient.call({ account: plan.brand, to: plan.balanceRead.address, data: plan.balanceRead.data }),
        publicClient.call({ account: plan.brand, to: plan.allowanceRead.address, data: plan.allowanceRead.data }),
      ]);
      if (!balanceCall.data || !allowanceCall.data) throw new Error("Base Sepolia did not return token balances.");
      const balance = decodeFunctionResult({
        abi: chain.nativeUsdcAbi,
        functionName: "balanceOf",
        data: balanceCall.data,
      });
      const allowance = decodeFunctionResult({
        abi: chain.nativeUsdcAbi,
        functionName: "allowance",
        data: allowanceCall.data,
      });
      if (balance < plan.budgetAtoms) {
        throw new Error(`This wallet needs ${usdcAtomsToDisplay(campaign.budgetUsdc)} test USDC to fund the campaign.`);
      }

      if (allowance < plan.budgetAtoms) {
        setPhase("approving");
        setMessage("Approve the exact test-USDC campaign budget in your wallet…");
        await publicClient.call({ account: plan.brand, to: plan.approvalCall.address, data: plan.approvalCall.data });
        const approvalHash = await walletClient.sendTransaction({
          account: plan.brand,
          chain: baseSepolia,
          to: plan.approvalCall.address,
          data: plan.approvalCall.data,
          value: 0n,
        });
        const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash });
        if (approvalReceipt.status !== "success") throw new Error("The test-USDC approval transaction failed.");
      }

      setPhase("funding");
      setMessage("Approve the escrow campaign transaction in your wallet…");
      await publicClient.call({ account: plan.brand, to: plan.createCampaignCall.address, data: plan.createCampaignCall.data });
      const fundingHash = await walletClient.sendTransaction({
        account: plan.brand,
        chain: baseSepolia,
        to: plan.createCampaignCall.address,
        data: plan.createCampaignCall.data,
        value: 0n,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: fundingHash });
      chain.extractCampaignCreated({
        receiptStatus: receipt.status,
        logs: receipt.logs,
        expectedBrand: plan.brand,
        expectedTermsHash: plan.termsHash,
        expectedDeposited: plan.budgetAtoms,
      });

      window.sessionStorage.setItem(recoveryKey, fundingHash);
      setConfirmedFundingHash(fundingHash);
      await recordConfirmedFunding(fundingHash);
    } catch (error) {
      setPhase("error");
      setMessage(marketplaceErrorMessage(error));
    }
  }

  if (campaign.fundingStatus === "funded") {
    return (
      <div className="funding-panel confirmed">
        <span>BASE FUNDING</span>
        <strong>FUNDED</strong>
        <p>{usdcAtomsToDisplay(campaign.budgetUsdc)} test USDC is recorded against escrow campaign {campaign.escrowCampaignId ?? "—"}.</p>
        {campaign.fundingTxHash ? (
          <a href={`https://sepolia.basescan.org/tx/${campaign.fundingTxHash}`} target="_blank" rel="noreferrer">
            VIEW TRANSACTION →
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <div className="funding-panel">
      <span>BASE FUNDING / {campaign.fundingStatus.toUpperCase()}</span>
      <strong>FUND THE ESCROW.</strong>
      <p>
        Deposit {usdcAtomsToDisplay(campaign.budgetUsdc)} Base Sepolia test USDC from {shortenAddress(campaign.brandWallet)}.
        The campaign opens only after the receipt matches these saved terms.
      </p>
      {message ? <p className={phase === "error" ? "form-message error" : "form-message"} role={phase === "error" ? "alert" : "status"}>{message}</p> : null}
      <button className="button" type="button" disabled={!(["idle", "error"] as FundingPhase[]).includes(phase)} onClick={() => void fund()}>
        {phase === "idle" || phase === "error"
          ? confirmedFundingHash
            ? "RECORD CONFIRMED FUNDING →"
            : "FUND WITH TEST USDC →"
          : "TRANSACTION IN PROGRESS…"}
      </button>
    </div>
  );
}
