"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import {
  DEFAULT_MAX_CAMPAIGN_DURATION_MS,
  DEFAULT_MAX_UNDETERMINED_RETRIES,
  DEFAULT_RETENTION_SECONDS,
  DEFAULT_SELECTION_WINDOW_MS,
  DEFAULT_SUBMISSION_WINDOW_MS,
  MIN_APPLICATION_WINDOW_MS,
  deriveDefaultCampaignSchedule,
} from "@/lib/marketplace-types";
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
  const [applicationDeadline, setApplicationDeadline] = useState("");
  const [deadlineBounds, setDeadlineBounds] = useState<{ min: string; max: string } | null>(null);
  const [submission, setSubmission] = useState<SubmissionState>({ phase: "idle", message: null });

  useEffect(() => {
    const timer = window.setTimeout(() => setDeadlineBounds(deadlineInputBounds(Date.now())), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function submitCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setSubmission({ phase: "submitting", message: "Creating draft…" });
    try {
      const deliverables = String(values.get("deliverables") ?? "")
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean);
      if (deliverables.length === 0) throw new Error("Add at least one measurable deliverable.");
      const description = String(values.get("description") ?? "").trim();
      const requiredPhrases = phraseList(values.get("requiredPhrases"), "required phrases");
      const forbiddenPhrases = phraseList(values.get("forbiddenPhrases"), "forbidden phrases");
      const semanticBrief = String(values.get("semanticBrief") ?? "").trim() || description;
      const nowMs = Date.now();
      const deadline = new Date(String(values.get("deadline") ?? ""));
      if (Number.isNaN(deadline.getTime()) || deadline.getTime() < nowMs + MIN_APPLICATION_WINDOW_MS) {
        throw new Error("Applications must stay open for at least one hour.");
      }
      const schedule = deriveDefaultCampaignSchedule(deadline.getTime());
      if (schedule.submissionDeadlineMs > nowMs + DEFAULT_MAX_CAMPAIGN_DURATION_MS) {
        throw new Error("Choose an earlier application deadline. Work must be due within 90 days.");
      }
      const budgetGen = genInputToAtoms(String(values.get("budgetGen") ?? ""));
      const brandWallet = await wallet.authenticate();

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
          budgetGen,
          deadline: deadline.toISOString(),
          selectionDeadline: new Date(schedule.selectionDeadlineMs).toISOString(),
          submissionDeadline: new Date(schedule.submissionDeadlineMs).toISOString(),
          retentionSeconds: schedule.retentionSeconds,
          maxUndeterminedRetries: schedule.maxUndeterminedRetries,
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
          <strong>{wallet.restoring ? "RESTORING SESSION" : wallet.authenticated && wallet.address ? shortenAddress(wallet.address) : wallet.address ? "SIGN-IN REQUIRED" : "NOT CONNECTED"}</strong>
        </div>
        <button className="verify-secondary" type="button" disabled={wallet.restoring || wallet.authenticating || wallet.disconnecting} onClick={() => void wallet.authenticate().catch(() => undefined)}>
          {wallet.restoring ? "RESTORING…" : wallet.authenticating ? "SIGNING IN…" : wallet.authenticated ? "AUTHORIZED" : "CONNECT + SIGN"}
        </button>
        {wallet.hasSession || wallet.address || wallet.authenticating ? (
          <button className="verify-secondary" type="button" disabled={wallet.disconnecting} onClick={() => void wallet.signOut().catch(() => undefined)}>{wallet.disconnecting ? "DISCONNECTING…" : "DISCONNECT WALLET"}</button>
        ) : null}
        {wallet.address && !wallet.isStudioNet ? (
          <button className="verify-secondary" type="button" onClick={() => void wallet.switchToStudioNet()}>
            SWITCH TO STUDIONET
          </button>
        ) : null}
      </div>
      {wallet.walletError ? <p className="form-message error" role="alert">{wallet.walletError}</p> : null}
      {wallet.walletNotice ? <p className="form-message" role="status">{wallet.walletNotice}</p> : null}
      <p className="marketplace-auth-note">
        Creators need an active identity for the selected source. <Link href="/verify">VERIFY A CREATOR →</Link>
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
          <small id="format-note">One original public text post.</small>
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
          <small>Requires a verified identity on this source.</small>
        </label>
        <label>
          <span>BUDGET / TEST GEN</span>
          <input name="budgetGen" inputMode="decimal" placeholder="1200" pattern="[0-9]+(?:\.[0-9]{1,18})?" required />
        </label>
        <label>
          <span>APPLICATIONS CLOSE</span>
          <input
            name="deadline"
            type="datetime-local"
            min={deadlineBounds?.min}
            max={deadlineBounds?.max}
            value={applicationDeadline}
            onChange={(event) => setApplicationDeadline(event.target.value)}
            required
          />
        </label>
        <CampaignTimingPreview applicationDeadline={applicationDeadline} />
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
          <p>Used to resolve submitted work.</p>
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
          <span>SEMANTIC BRIEF</span>
          <textarea name="semanticBrief" maxLength={2_000} rows={4} placeholder="Leave blank to use the public brief above." />
        </label>
        <label className="field-wide resolution-checkbox">
          <input name="requireAdDisclosure" type="checkbox" defaultChecked />
          <span>REQUIRE A CLEAR ADVERTISEMENT / SPONSORSHIP DISCLOSURE</span>
        </label>
      </div>

      <div className="marketplace-disclosure">
        <strong>TESTNET SAFETY</strong>
        <p>Funding is a separate StudioNet transaction that locks test GEN. Use the Studio faucet for this wallet if needed. <a href={STUDIONET_FUNDING_GUIDE_URL} target="_blank" rel="noreferrer">OFFICIAL INSTRUCTIONS ↗</a></p>
      </div>
      {submission.phase === "error" ? <p className="form-message error" role="alert">{submission.message}</p> : null}
      {submission.phase === "submitting" ? <p className="form-message" role="status">{submission.message}</p> : null}
      <button className="button marketplace-submit" type="submit" disabled={submission.phase === "submitting"}>
        {submission.phase === "submitting" ? "CREATING DRAFT…" : "CREATE DRAFT →"}
      </button>
    </form>
  );
}

function CampaignTimingPreview({ applicationDeadline }: { applicationDeadline: string }) {
  const applicationCloseMs = new Date(applicationDeadline).getTime();
  const schedule = previewSchedule(applicationCloseMs);
  return (
    <section className="campaign-timing-preview field-wide" aria-label="Campaign timing preview" aria-live="polite">
      <div className="campaign-timing-grid">
        <div><span>APPLICATIONS CLOSE</span><strong>{previewDate(applicationCloseMs)}</strong></div>
        <div><span>SELECT BY / UNUSED FUNDS AVAILABLE</span><strong>{schedule ? previewDate(schedule.selectionDeadlineMs) : `${durationDays(DEFAULT_SELECTION_WINDOW_MS)}D AFTER APPS CLOSE`}</strong></div>
        <div><span>WORK DUE</span><strong>{schedule ? previewDate(schedule.submissionDeadlineMs) : `+${durationDays(DEFAULT_SUBMISSION_WINDOW_MS)}D AFTER SELECT`}</strong></div>
        <div><span>RESOLUTION</span><strong>{DEFAULT_RETENTION_SECONDS / 3_600}H AFTER POST · {DEFAULT_MAX_UNDETERMINED_RETRIES} ATTEMPTS MAX</strong></div>
      </div>
      <p className="campaign-cancel-rule">SELECTED CREATORS: UP TO 24H TO ACCEPT · CANCEL BEFORE APPLICATIONS CLOSE · NO RESERVED CREATOR FUNDS</p>
    </section>
  );
}

function previewSchedule(value: number): ReturnType<typeof deriveDefaultCampaignSchedule> | null {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  try {
    return deriveDefaultCampaignSchedule(value);
  } catch {
    return null;
  }
}

function previewDate(value: number): string {
  if (!Number.isFinite(value)) return "CHOOSE ABOVE";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function durationDays(value: number): number {
  return value / (24 * 60 * 60 * 1_000);
}

function deadlineInputBounds(nowMs: number): { min: string; max: string } {
  const minuteMs = 60_000;
  const minMs = Math.ceil((nowMs + MIN_APPLICATION_WINDOW_MS) / minuteMs) * minuteMs;
  const maxMs = Math.floor(
    (nowMs + DEFAULT_MAX_CAMPAIGN_DURATION_MS - DEFAULT_SELECTION_WINDOW_MS - DEFAULT_SUBMISSION_WINDOW_MS) / minuteMs,
  ) * minuteMs;
  return { min: datetimeLocalValue(minMs), max: datetimeLocalValue(maxMs) };
}

function datetimeLocalValue(value: number): string {
  const date = new Date(value);
  return new Date(value - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
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
