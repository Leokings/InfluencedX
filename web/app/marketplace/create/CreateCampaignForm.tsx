"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { marketplaceErrorMessage, marketplaceRequest } from "../marketplace-api";
import {
  type ContentSource,
  type CampaignMutationResponse,
  genInputToAtoms,
  shortenAddress,
  STUDIONET_FUNDING_GUIDE_URL,
} from "../marketplace-types";
import { useMarketplaceWallet } from "../use-marketplace-wallet";

type SubmissionState =
  | { phase: "idle"; message: null }
  | { phase: "submitting"; message: string }
  | { phase: "error"; message: string };

export function CreateCampaignForm() {
  const router = useRouter();
  const wallet = useMarketplaceWallet();
  const [contentSource, setContentSource] = useState<ContentSource>("X");
  const [submission, setSubmission] = useState<SubmissionState>({ phase: "idle", message: null });

  async function submitCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setSubmission({ phase: "submitting", message: "Creating the campaign draft…" });
    try {
      const brandWallet = await wallet.authenticate();
      const deliverables = String(values.get("deliverables") ?? "")
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean);
      if (deliverables.length === 0) throw new Error("Add at least one measurable deliverable.");
      const description = String(values.get("description") ?? "").trim();
      const requiredPhrases = phraseList(values.get("requiredPhrases"), "required phrases");
      const forbiddenPhrases = phraseList(values.get("forbiddenPhrases"), "forbidden phrases");
      const semanticBrief = String(values.get("semanticBrief") ?? "").trim() || description;
      const deadline = new Date(String(values.get("deadline") ?? ""));
      if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now()) {
        throw new Error("Choose a campaign deadline in the future.");
      }

      const result = await marketplaceRequest<CampaignMutationResponse>("/api/marketplace/campaigns", {
        method: "POST",
        body: JSON.stringify({
          brandWallet,
          brandName: String(values.get("brandName") ?? "").trim() || undefined,
          title: String(values.get("title") ?? "").trim(),
          description,
          category: String(values.get("category") ?? "").trim(),
          contentSource,
          format: "Post",
          deliverables,
          requiredPhrases,
          forbiddenPhrases,
          requireAdDisclosure: values.get("requireAdDisclosure") === "on",
          semanticBrief,
          budgetGen: genInputToAtoms(String(values.get("budgetGen") ?? "")),
          deadline: deadline.toISOString(),
        }),
      });
      router.push(`/marketplace/campaigns/${encodeURIComponent(result.campaign.id)}`);
    } catch (error) {
      setSubmission({ phase: "error", message: marketplaceErrorMessage(error) });
    }
  }

  return (
    <form className="marketplace-form" onSubmit={submitCampaign}>
      <div className="marketplace-form-head">
        <div><span>CAMPAIGN RECORD</span><strong>NEW / UNFUNDED</strong></div>
        <span className="run-state"><i /> GENLAYER STUDIONET</span>
      </div>

      <div className="marketplace-wallet-panel">
        <div>
          <span>AUTHORIZED BRAND WALLET</span>
          <strong>{wallet.authenticated && wallet.address ? shortenAddress(wallet.address) : wallet.address ? "SIGN-IN REQUIRED" : "NOT CONNECTED"}</strong>
        </div>
        <button className="verify-secondary" type="button" disabled={wallet.authenticating} onClick={() => void wallet.authenticate()}>
          {wallet.authenticating ? "SIGNING IN…" : wallet.authenticated ? "AUTHORIZED" : "CONNECT + SIGN"}
        </button>
        {wallet.hasSession ? (
          <button className="verify-secondary" type="button" onClick={() => void wallet.signOut()}>SWITCH WALLET</button>
        ) : null}
        {wallet.address && !wallet.isStudioNet ? (
          <button className="verify-secondary" type="button" onClick={() => void wallet.switchToStudioNet()}>
            SWITCH TO STUDIONET
          </button>
        ) : null}
      </div>
      {wallet.walletError ? <p className="form-message error" role="alert">{wallet.walletError}</p> : null}
      <p className="marketplace-auth-note">
        The brand signs a one-time, gasless wallet challenge to create an HttpOnly session. Creators need an active identity for the campaign&apos;s selected source. <Link href="/verify">Verify a creator wallet →</Link>
      </p>

      <div className="marketplace-form-fields">
        <label>
          <span>BRAND NAME / OPTIONAL</span>
          <input name="brandName" maxLength={80} placeholder="Your brand" autoComplete="organization" />
        </label>
        <label>
          <span>CAMPAIGN TITLE</span>
          <input name="title" maxLength={100} minLength={3} placeholder="CREATOR LAUNCH SPRINT" required />
        </label>
        <label className="field-wide">
          <span>PUBLIC BRIEF</span>
          <textarea name="description" maxLength={2_000} minLength={20} rows={5} placeholder="Describe the product, audience, message, and what a strong submission looks like." required />
        </label>
        <label>
          <span>CATEGORY</span>
          <select name="category" defaultValue="Crypto" required>
            <option>Crypto</option>
            <option>Dev tools</option>
            <option>Consumer</option>
            <option>AI</option>
            <option>Finance</option>
            <option>Other</option>
          </select>
        </label>
        <label>
          <span>CONTENT FORMAT</span>
          <input name="format" value="Post" readOnly aria-describedby="format-note" />
          <small id="format-note">The current MVP verifies one original public text post.</small>
        </label>
        <label>
          <span>CONTENT SOURCE</span>
          <select
            name="contentSource"
            value={contentSource}
            onChange={(event) => setContentSource(event.target.value as ContentSource)}
            required
          >
            <option value="X">X</option>
            <option value="FARCASTER">Farcaster</option>
          </select>
          <small>Applicants must verify an identity on this exact source.</small>
        </label>
        <label>
          <span>BUDGET / TEST GEN</span>
          <input name="budgetGen" inputMode="decimal" placeholder="1200" pattern="[0-9]+(?:\.[0-9]{1,18})?" required />
        </label>
        <label>
          <span>APPLICATION DEADLINE</span>
          <input name="deadline" type="datetime-local" required />
        </label>
        <label className="field-wide">
          <span>DELIVERABLES / ONE PER LINE</span>
          <textarea
            name="deliverables"
            maxLength={2_000}
            rows={5}
            placeholder={`One original public ${contentSource === "FARCASTER" ? "Farcaster cast" : "X post"}\nMention @brand and include #ad\nKeep the post public for 14 days`}
            required
          />
        </label>
        <div className="field-wide resolution-criteria-head">
          <span>GENLAYER RESOLUTION CRITERIA</span>
          <p>These exact criteria become part of the campaign terms hash used during resolution.</p>
        </div>
        <label>
          <span>REQUIRED PHRASES / ONE PER LINE</span>
          <textarea name="requiredPhrases" maxLength={3_220} rows={4} placeholder={"InfluencedX\nGenLayer"} />
        </label>
        <label>
          <span>FORBIDDEN PHRASES / ONE PER LINE</span>
          <textarea name="forbiddenPhrases" maxLength={3_220} rows={4} placeholder="Competitor claims" />
        </label>
        <label className="field-wide">
          <span>SEMANTIC BRIEF / WHAT MUST THE POST COMMUNICATE?</span>
          <textarea name="semanticBrief" maxLength={2_000} rows={4} placeholder="Leave blank to use the public brief above." />
        </label>
        <label className="field-wide resolution-checkbox">
          <input name="requireAdDisclosure" type="checkbox" defaultChecked />
          <span>REQUIRE A CLEAR ADVERTISEMENT / SPONSORSHIP DISCLOSURE</span>
        </label>
      </div>

      <div className="marketplace-disclosure">
        <strong>TESTNET SAFETY</strong>
        <p>This creates a draft. Funding is a separate payable StudioNet transaction that locks native test GEN in the InfluencedX contract. Need GEN? Use GenLayer Studio&apos;s built-in 💧 faucet and confirm it funded the same wallet address. <a href={STUDIONET_FUNDING_GUIDE_URL} target="_blank" rel="noreferrer">OFFICIAL INSTRUCTIONS ↗</a></p>
      </div>
      {submission.phase === "error" ? <p className="form-message error" role="alert">{submission.message}</p> : null}
      {submission.phase === "submitting" ? <p className="form-message" role="status">{submission.message}</p> : null}
      <button className="button marketplace-submit" type="submit" disabled={submission.phase === "submitting"}>
        {submission.phase === "submitting" ? "CREATING DRAFT…" : "CREATE CAMPAIGN DRAFT →"}
      </button>
    </form>
  );
}

function phraseList(value: FormDataEntryValue | null, label: string): string[] {
  const phrases = String(value ?? "")
    .split("\n")
    .map((phrase) => phrase.trim())
    .filter(Boolean);
  if (phrases.length > 20) throw new Error(`Use no more than 20 ${label}.`);
  if (phrases.some((phrase) => phrase.length > 160)) {
    throw new Error(`Each ${label} entry must contain no more than 160 characters.`);
  }
  return [...new Set(phrases)];
}
