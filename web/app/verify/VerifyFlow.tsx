"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import {
  baseRelayPresentation,
  shouldPollVerificationStatus,
  type BaseRelayStatus,
} from "@/lib/base-relay-status";
import { selectVerificationWallet } from "@/lib/verification-wallet";
import { typedDataForWalletRpc } from "@/lib/wallet-typed-data";

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

type VerificationStatus =
  | "WALLET_CHALLENGE_PENDING"
  | "WALLET_AUTHORIZED"
  | "X_CHALLENGE_ISSUED"
  | "INTENT_PREPARED"
  | "READY_FOR_GENLAYER"
  | "EXPIRED";

type SubmissionStatus =
  | "NOT_SUBMITTED"
  | "DISPATCHING"
  | "DISPATCH_UNKNOWN"
  | "QUEUED"
  | "PRECHECKING"
  | "PRECHECK_FAILED"
  | "BROADCASTING"
  | "SUBMITTED"
  | "POLLING"
  | "FINALIZED"
  | "EXECUTION_FAILED"
  | "NETWORK_TERMINATED"
  | "RECONCILIATION_REQUIRED"
  | "POLLING_EXHAUSTED"
  | "POISONED";

type VerificationRequest = {
  id: string;
  status: VerificationStatus;
  wallet: string;
  walletChallengeExpiresAt: string;
  walletAuthorizedAt: string | null;
  handle: string | null;
  tweetText: string | null;
  xChallengeIssuedAt: string | null;
  xChallengeExpiresAt: string | null;
  credentialExpiresAt: string | null;
  normalizedVerificationPostUrl: string | null;
  verificationPostId: string | null;
  verificationPostCreatedAt: string | null;
  finalizedRequestId: string | null;
  intentSignatureStatus: string | null;
  intentPreparedAt: string | null;
  readyForGenLayerAt: string | null;
  submissionStatus: SubmissionStatus;
  submissionStatusUpdatedAt: string | null;
  submissionAttempts: number;
  genlayerTxHash: string | null;
  genlayerOutcome: "VERIFIED" | "REJECTED" | "UNDETERMINED" | null;
  genlayerErrorCode: string | null;
  genlayerSubmittedAt: string | null;
  genlayerLastPolledAt: string | null;
  genlayerFinalizedAt: string | null;
  baseRelayStatus: BaseRelayStatus;
  baseRelayTxHash: string | null;
  baseRelayUpdatedAt: string | null;
  baseConfirmedAt: string | null;
  baseRelayErrorCode: string | null;
  baseRegistryAddress: string | null;
  baseProfileId: string | null;
  baseProfileIdentityHash: string | null;
  baseProfileHandleHash: string | null;
  baseProfileVerificationPostHash: string | null;
  baseProfileExpiresAt: string | null;
  baseProfileActive: boolean | null;
  baseProfileVerified: boolean | null;
  createdAt: string;
  updatedAt: string;
};

type WalletChallenge = {
  message: string;
  expiresAt: string;
};

type OwnershipTypedData = {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

type ApiErrorBody = {
  error?: string | { code?: string; message?: string };
  code?: string;
  message?: string;
};

const BASE_SEPOLIA_HEX_CHAIN_ID = "0x14a34";
const ACTIVE_STEPS = [
  ["01", "CONNECT + SIGN"],
  ["02", "CHECK X ACCOUNT"],
  ["03", "PUBLISH PROOF"],
  ["04", "FINALIZE ON BASE"],
] as const;

function getProvider(): EthereumProvider {
  if (!window.ethereum) {
    throw new Error("No browser wallet found. Install a wallet that supports Base Sepolia, then try again.");
  }
  return window.ethereum;
}

function messageToHex(message: string): `0x${string}` {
  return `0x${Array.from(new TextEncoder().encode(message), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function shorten(value: string | null, start = 7, end = 5): string {
  if (!value || value.length <= start + end + 1) return value ?? "—";
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function baseExplorerLink(kind: "address" | "tx", value: string | null): string | null {
  const pattern = kind === "address" ? /^0x[\da-f]{40}$/i : /^0x[\da-f]{64}$/i;
  return value && pattern.test(value)
    ? `https://sepolia.basescan.org/${kind}/${value}`
    : null;
}

function epochLabel(value: string | number | null): string {
  if (!value) return "—";
  const date = typeof value === "number"
    ? new Date(value > 10_000_000_000 ? value : value * 1_000)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function statusStep(status: VerificationStatus | null): number {
  if (!status || status === "WALLET_CHALLENGE_PENDING" || status === "EXPIRED") return 1;
  if (status === "WALLET_AUTHORIZED") return 2;
  if (status === "X_CHALLENGE_ISSUED") return 3;
  return 4;
}

function errorMessage(body: ApiErrorBody, fallback: string): string {
  if (typeof body.error === "string") return body.error;
  if (body.error && typeof body.error.message === "string") return body.error.message;
  if (typeof body.message === "string") return body.message;
  return fallback;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as ApiErrorBody & T;
  if (!response.ok) {
    const error = new Error(errorMessage(body, `InfluencedX request failed (${response.status}).`));
    Object.assign(error, { status: response.status, code: body.code });
    throw error;
  }
  return body;
}

function requestBody(value: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(value) };
}

export default function VerifyFlow() {
  const [request, setRequest] = useState<VerificationRequest | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [walletChallenge, setWalletChallenge] = useState<WalletChallenge | null>(null);
  const [typedData, setTypedData] = useState<OwnershipTypedData | null>(null);
  const [evidenceToken, setEvidenceToken] = useState<string | null>(null);
  const [handle, setHandle] = useState("");
  const [postUrl, setPostUrl] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const activeStep = statusStep(request?.status ?? null);
  // A resumed verification is cryptographically bound to its saved wallet.
  // Never let another tab's or provider's current account replace that binding.
  const effectiveWallet = selectVerificationWallet(request?.wallet, wallet);
  const expired = request?.status === "EXPIRED";
  const pollingRequestId = request?.id ?? null;
  const pollingSubmissionStatus = request?.submissionStatus ?? null;
  const pollingGenlayerOutcome = request?.genlayerOutcome ?? null;
  const pollingBaseRelayStatus = request?.baseRelayStatus ?? "NOT_STARTED";

  useEffect(() => {
    let active = true;
    void api<{ request: VerificationRequest | null }>("/api/verification/status")
      .then(async (result) => {
        if (!active) return;
        let currentRequest = result.request;
        if (
          currentRequest?.status === "INTENT_PREPARED" ||
          currentRequest?.status === "READY_FOR_GENLAYER"
        ) {
          const resumed = await api<{
            request: VerificationRequest;
            typedData: OwnershipTypedData | null;
            evidenceToken: string;
          }>(
            "/api/verification/intent",
            requestBody({ action: "resume", requestId: currentRequest.id }),
          );
          if (!active) return;
          currentRequest = resumed.request;
          setTypedData(resumed.typedData);
          setEvidenceToken(resumed.evidenceToken);
        }
        setRequest(currentRequest);
        if (currentRequest?.handle) setHandle(currentRequest.handle);
        if (currentRequest?.normalizedVerificationPostUrl) {
          setPostUrl(currentRequest.normalizedVerificationPostUrl);
        }
      })
      .catch((statusError: unknown) => {
        if (!active) return;
        if ((statusError as Error & { status?: number }).status === 401) {
          setRequest(null);
          return;
        }
        setError(statusError instanceof Error ? statusError.message : "Could not load verification status.");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!pollingRequestId || !pollingSubmissionStatus || pollingSubmissionStatus === "NOT_SUBMITTED") return;
    if (!shouldPollVerificationStatus({
      submissionStatus: pollingSubmissionStatus,
      genlayerOutcome: pollingGenlayerOutcome,
      baseRelayStatus: pollingBaseRelayStatus,
    })) return;
    let active = true;
    const refresh = async () => {
      try {
        const result = await api<{ request: VerificationRequest }>(
          `/api/verification/submission-status?requestId=${encodeURIComponent(pollingRequestId)}`,
        );
        if (active) setRequest(result.request);
      } catch {
        // The last durable state remains visible; the next DB-only poll retries.
      }
    };
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [
    pollingBaseRelayStatus,
    pollingGenlayerOutcome,
    pollingRequestId,
    pollingSubmissionStatus,
  ]);

  useEffect(() => {
    if (!window.ethereum?.on) return;
    const accountsChanged = (...args: unknown[]) => {
      const accounts = Array.isArray(args[0]) ? args[0] : [];
      const nextWallet = typeof accounts[0] === "string" ? accounts[0] : null;
      setWallet(nextWallet);
      if (request?.wallet && nextWallet?.toLowerCase() !== request.wallet.toLowerCase()) {
        setError(`Reconnect ${shorten(request.wallet)} to continue this verification.`);
      }
    };
    window.ethereum.on("accountsChanged", accountsChanged);
    return () => window.ethereum?.removeListener?.("accountsChanged", accountsChanged);
  }, [request?.wallet]);

  const progress = ACTIVE_STEPS.map(([number, label], index) => ({
    number,
    label,
    state: index + 1 < activeStep ? "complete" : index + 1 === activeStep ? "active" : "future",
  }));

  async function ensureBaseSepolia(provider: EthereumProvider) {
    const chainId = String(await provider.request({ method: "eth_chainId" })).toLowerCase();
    if (chainId === BASE_SEPOLIA_HEX_CHAIN_ID) return;
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BASE_SEPOLIA_HEX_CHAIN_ID }],
      });
    } catch (switchError) {
      const code = (switchError as { code?: number }).code;
      if (code !== 4902) throw switchError;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: BASE_SEPOLIA_HEX_CHAIN_ID,
          chainName: "Base Sepolia",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://sepolia.base.org"],
          blockExplorerUrls: ["https://sepolia-explorer.base.org"],
        }],
      });
    }
  }

  async function connectWallet() {
    setBusy("connect");
    setError(null);
    setNotice(null);
    try {
      const provider = getProvider();
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      if (!accounts[0]) throw new Error("The wallet did not return an account.");
      await ensureBaseSepolia(provider);
      const connectedWallet = accounts[0];
      if (request?.wallet && connectedWallet.toLowerCase() !== request.wallet.toLowerCase()) {
        throw new Error(`This run belongs to ${shorten(request.wallet)}. Reconnect that wallet to continue.`);
      }
      setWallet(connectedWallet);
      const result = await api<{
        request: VerificationRequest;
        walletChallenge: WalletChallenge;
      }>("/api/verification/challenge", requestBody({ wallet: connectedWallet }));
      setRequest(result.request);
      setWalletChallenge(result.walletChallenge);
      setNotice("Wallet connected. Sign the one-time message to prove control; this costs no gas.");
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "Could not connect the wallet.");
    } finally {
      setBusy(null);
    }
  }

  async function signWalletChallenge() {
    if (!request || !effectiveWallet || !walletChallenge) {
      setError("Reconnect the wallet to retrieve a fresh signing message.");
      return;
    }
    setBusy("wallet-sign");
    setError(null);
    try {
      const provider = getProvider();
      const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
      if (!accounts.some((account) => account.toLowerCase() === effectiveWallet.toLowerCase())) {
        throw new Error(`Reconnect ${shorten(effectiveWallet)} to sign this wallet challenge.`);
      }
      const signature = await provider.request({
        method: "personal_sign",
        params: [messageToHex(walletChallenge.message), effectiveWallet],
      });
      if (typeof signature !== "string") throw new Error("The wallet did not return a signature.");
      const result = await api<{
        request: VerificationRequest;
        evidenceToken: string;
      }>(
        "/api/verification/authorize",
        requestBody({ requestId: request.id, signature }),
      );
      setRequest(result.request);
      setWalletChallenge(null);
      setNotice("Wallet ownership proved. Now choose the public X account you use for creator work.");
    } catch (signError) {
      setError(signError instanceof Error ? signError.message : "Wallet signature failed.");
    } finally {
      setBusy(null);
    }
  }

  async function createXChallenge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request || !consent) return;
    setBusy("x-challenge");
    setError(null);
    setNotice(null);
    try {
      const result = await api<{
        request: VerificationRequest;
        xChallenge: {
          handle: string;
          tweetText: string;
          issuedAt: string;
          expiresAt: string;
          credentialExpiresAt: string;
        };
      }>("/api/verification/x-challenge", requestBody({ requestId: request.id, handle }));
      setRequest(result.request);
      setHandle(result.xChallenge.handle);
      setNotice("Challenge created. Publish the exact text from the matching public X account.");
    } catch (challengeError) {
      setError(challengeError instanceof Error ? challengeError.message : "Could not create the X challenge.");
    } finally {
      setBusy(null);
    }
  }

  async function prepareIntent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request) return;
    setBusy("intent-prepare");
    setError(null);
    setNotice(null);
    try {
      const result = await api<{
        request: VerificationRequest;
        typedData: OwnershipTypedData;
        evidenceToken: string;
      }>("/api/verification/intent", requestBody({
        action: "prepare",
        requestId: request.id,
        verificationPostUrl: postUrl,
      }));
      setRequest(result.request);
      setTypedData(result.typedData);
      setEvidenceToken(result.evidenceToken);
      setNotice("Post accepted structurally. Sign the final Base ownership intent to bind every proof field.");
    } catch (intentError) {
      const status = (intentError as Error & { status?: number }).status;
      if (status === 503) {
        setError(
          "Final authorization is temporarily unavailable because the public contract configuration could not be loaded.",
        );
      } else {
        setError(intentError instanceof Error ? intentError.message : "Could not prepare the ownership intent.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function authorizeIntent() {
    if (!request || !effectiveWallet || !typedData) return;
    setBusy("intent-sign");
    setError(null);
    try {
      const provider = getProvider();
      const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
      if (!accounts.some((account) => account.toLowerCase() === effectiveWallet.toLowerCase())) {
        throw new Error(`Reconnect ${shorten(effectiveWallet)} before signing the final ownership intent.`);
      }
      const signature = await provider.request({
        method: "eth_signTypedData_v4",
        params: [effectiveWallet, JSON.stringify(typedDataForWalletRpc(typedData))],
      });
      if (typeof signature !== "string") throw new Error("The wallet did not return an ownership signature.");
      const result = await api<{
        request: VerificationRequest;
        evidenceToken: string;
      }>(
        "/api/verification/intent",
        requestBody({
          action: "authorize",
          requestId: request.id,
          signature,
          evidenceToken,
        }),
      );
      setRequest(result.request);
      setEvidenceToken(result.evidenceToken);
      setTypedData(null);
      setNotice("Ownership intent authorized. Submit the exact sealed proof to the dedicated GenLayer service.");
    } catch (intentError) {
      setError(intentError instanceof Error ? intentError.message : "Ownership authorization failed.");
    } finally {
      setBusy(null);
    }
  }

  async function submitToGenLayer() {
    if (!request || request.status !== "READY_FOR_GENLAYER") return;
    setBusy("genlayer-submit");
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ request: VerificationRequest }>(
        "/api/verification/submit",
        requestBody({ requestId: request.id, evidenceToken }),
      );
      setRequest(result.request);
      setNotice(
        "Submission accepted for StudioNet processing. Finality is tracked asynchronously; this is not yet a Base attestation.",
      );
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "The GenLayer submitter could not accept this proof.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function copyTweet() {
    if (!request?.tweetText) return;
    try {
      await navigator.clipboard.writeText(request.tweetText);
      setNotice("Exact challenge text copied.");
    } catch {
      setError("Clipboard access was blocked. Select and copy the text manually.");
    }
  }

  const genlayerStarted = request?.submissionStatus !== "NOT_SUBMITTED";
  const genlayerRetryable =
    request?.submissionStatus === "DISPATCH_UNKNOWN" ||
    request?.submissionStatus === "PRECHECK_FAILED";
  const genlayerFinal = request?.submissionStatus === "FINALIZED";
  const genlayerVerified = genlayerFinal && request?.genlayerOutcome === "VERIFIED";
  const genlayerDidNotVerify = genlayerFinal && !genlayerVerified;
  const genlayerFailed = Boolean(
    request && [
      "EXECUTION_FAILED",
      "NETWORK_TERMINATED",
      "RECONCILIATION_REQUIRED",
      "POLLING_EXHAUSTED",
      "POISONED",
    ].includes(request.submissionStatus),
  );
  const effectiveBaseRelayStatus = request?.baseRelayStatus ?? "NOT_STARTED";
  const baseRelay = baseRelayPresentation({
    status: effectiveBaseRelayStatus,
    genlayerVerified,
    profileId: request?.baseProfileId ?? null,
    profileActive: request?.baseProfileActive ?? null,
    profileVerified: request?.baseProfileVerified ?? null,
    profileExpiresAt: request?.baseProfileExpiresAt ?? null,
  });
  const baseProfileCurrent = baseRelay.currentProfile;
  const baseRelayNeedsReview = baseRelay.needsReview;
  const baseTxUrl = baseExplorerLink("tx", request?.baseRelayTxHash ?? null);
  const baseRegistryUrl = baseExplorerLink("address", request?.baseRegistryAddress ?? null);
  const baseRelayErrorCode = request?.baseRelayErrorCode && /^[A-Z][A-Z0-9_]{0,63}$/.test(request.baseRelayErrorCode)
    ? request.baseRelayErrorCode
    : null;
  const resultRows = [
    ["POST SUBMITTED", request?.verificationPostId ? "complete" : "future", request?.verificationPostId ? shorten(request.verificationPostId, 8, 6) : "PUBLIC URL REQUIRED"],
    ["WALLET INTENT", request?.status === "READY_FOR_GENLAYER" ? "complete" : request?.status === "INTENT_PREPARED" ? "pending" : "future", request?.intentSignatureStatus ?? "NOT SIGNED"],
    ["GENLAYER", genlayerFinal ? (genlayerVerified ? "complete" : "pending") : genlayerStarted ? "pending" : "future", genlayerFinal ? request?.genlayerOutcome ?? "NO OUTCOME" : request?.submissionStatus ?? "NOT SUBMITTED"],
    ["BASE RELAY", baseRelay.boardState, baseRelay.detail],
  ] as const;

  return (
    <main className="verify-page">
      <header className="site-header verify-header">
        <Link className="brand" href="/" aria-label="InfluencedX home">
          <span className="brand-name">INFLUENCEDX</span>
        </Link>
        <nav className="main-nav verify-nav" aria-label="Verification navigation">
          <Link href="/">MARKET</Link>
          <Link href="/#proof">HOW IT WORKS</Link>
          <Link aria-current="page" href="/verify">VERIFY X</Link>
        </nav>
        <div className="header-actions verify-header-status">
          <span className="network-label"><i /> BASE SEPOLIA</span>
          <span className="verify-run-id">{request ? shorten(request.id, 9, 5) : "NEW RUN"}</span>
        </div>
      </header>

      <section className="verify-layout">
        <aside className="verify-overview">
          <Link className="verify-back" href="/">← MARKET</Link>
          <p className="eyebrow"><span /> CREATOR IDENTITY / PUBLIC PROOF</p>
          <h1>PROVE<br /><em>YOUR X.</em></h1>
          <p className="verify-lead">
            Bind one public X account to your Base wallet. No X password, OAuth, or posting access.
          </p>

          <ol className="verify-progress" aria-label="Verification progress">
            {progress.map((item) => (
              <li className={item.state} aria-current={item.state === "active" ? "step" : undefined} key={item.number}>
                <strong>{item.number}</strong>
                <span>{item.label}</span>
                <em>{item.state === "complete" ? "DONE" : item.state === "active" ? "ACTIVE" : "LOCKED"}</em>
              </li>
            ))}
          </ol>

          <div className="verify-trust-strip">
            <span>PUBLIC ACCOUNTS ONLY</span>
            <span>15 MIN CHALLENGE</span>
            <span>30 DAY CREDENTIAL</span>
            <span>BASE SEPOLIA</span>
          </div>
        </aside>

        <section className="verify-workspace" aria-labelledby="verify-workspace-title">
          <div className="verify-workspace-head">
            <div>
              <span>VERIFICATION RUN</span>
              <strong id="verify-workspace-title">STEP {String(activeStep).padStart(2, "0")} / 04</strong>
            </div>
            <span className={request?.status === "EXPIRED" ? "run-state error" : "run-state"}>
              <i /> {request?.status?.replaceAll("_", " ") ?? "READY"}
            </span>
          </div>

          <div className="security-gate" role="note">
            <span>SECURITY GATE</span>
            <p>
              InfluencedX sends only the fixed APV2 ownership call through an authenticated submitter. GenLayer finality and
              Base watcher quorum are separate stages; a submitted post is never presented as verified.
            </p>
          </div>

          <div className="verify-announcer" aria-live="polite">
            {notice ? <p className="verify-notice">{notice}</p> : null}
            {error ? <p className="verify-error" role="alert">{error}</p> : null}
          </div>

          {activeStep === 1 ? (
            <div className="verify-card">
              <p className="card-index">01 / WALLET PROOF</p>
              <h2>{expired ? "CREATE A NEW CHALLENGE" : effectiveWallet ? "SIGN TO CONTINUE" : "CONNECT YOUR BASE WALLET"}</h2>
              <p>
                Use the wallet you will use to apply for campaigns. Connecting selects an address; signing proves you control it.
              </p>
              {effectiveWallet ? (
                <div className="connected-wallet">
                  <span>WALLET CONNECTED</span>
                  <strong title={effectiveWallet}>{shorten(effectiveWallet)}</strong>
                  <small>BASE SEPOLIA · SIGNATURE COSTS NO GAS</small>
                </div>
              ) : null}
              <button className="button verify-primary" type="button" disabled={Boolean(busy)} onClick={!effectiveWallet || expired ? connectWallet : signWalletChallenge}>
                {busy === "connect" ? "CHECK YOUR WALLET…" : busy === "wallet-sign" ? "SIGNING…" : expired ? "START NEW VERIFICATION →" : effectiveWallet ? "SIGN TO CONTINUE →" : "CONNECT WALLET →"}
              </button>
              {effectiveWallet && !walletChallenge && !expired ? (
                <button className="verify-secondary" type="button" disabled={Boolean(busy)} onClick={connectWallet}>
                  REFRESH SIGNING MESSAGE
                </button>
              ) : null}
            </div>
          ) : null}

          {activeStep === 2 ? (
            <form className="verify-card" onSubmit={createXChallenge}>
              <p className="card-index">02 / PUBLIC ACCOUNT</p>
              <h2>CHECK YOUR X ACCOUNT</h2>
              <p>Enter the public account you use for creator work. Protected accounts cannot be verified by independent validators.</p>
              <label className="verify-field">
                <span>X HANDLE</span>
                <input
                  autoComplete="off"
                  inputMode="text"
                  maxLength={16}
                  name="handle"
                  onChange={(event) => setHandle(event.target.value)}
                  placeholder="@handle"
                  required
                  value={handle}
                />
                <small>Only public profile and post evidence is used. X OAuth is not requested.</small>
              </label>
              <label className="consent-row">
                <input checked={consent} onChange={(event) => setConsent(event.target.checked)} type="checkbox" />
                <span>I authorize InfluencedX to verify this public account and store a hashed identity commitment.</span>
              </label>
              <button className="button verify-primary" type="submit" disabled={!consent || Boolean(busy)}>
                {busy === "x-challenge" ? "CREATING CHALLENGE…" : "CREATE CHALLENGE →"}
              </button>
            </form>
          ) : null}

          {activeStep === 3 ? (
            <form className="verify-card" onSubmit={prepareIntent}>
              <p className="card-index">03 / PUBLIC POST</p>
              <h2>PUBLISH THE CHALLENGE</h2>
              <p>
                Publish this exact text from @{request?.handle}. Use a new original public post before {epochLabel(request?.xChallengeExpiresAt ?? null)}.
              </p>
              <div className="tweet-proof">
                <div>
                  <span>EXACT POST TEXT</span>
                  <strong>@{request?.handle}</strong>
                </div>
                <pre>{request?.tweetText}</pre>
              </div>
              <div className="tweet-actions">
                <button className="verify-secondary" type="button" onClick={copyTweet}>COPY EXACT TEXT</button>
                <a
                  className="button button-small"
                  href={`https://x.com/intent/post?text=${encodeURIComponent(request?.tweetText ?? "")}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  OPEN X TO POST →
                </a>
              </div>
              <label className="verify-field">
                <span>PUBLIC POST URL</span>
                <input
                  inputMode="url"
                  name="postUrl"
                  onChange={(event) => setPostUrl(event.target.value)}
                  placeholder="https://x.com/handle/status/…"
                  required
                  type="url"
                  value={postUrl}
                />
                <small>Submitting a URL does not mean ownership is verified.</small>
              </label>
              <button className="button verify-primary" type="submit" disabled={Boolean(busy)}>
                {busy === "intent-prepare" ? "CHECKING POST…" : "PREPARE OWNERSHIP INTENT →"}
              </button>
            </form>
          ) : null}

          {activeStep === 4 ? (
            <div className="verify-card">
              <p className="card-index">04 / CONSENSUS + BASE</p>
              <h2>{request?.status === "READY_FOR_GENLAYER" ? "READY FOR VALIDATORS" : "AUTHORIZE THE FINAL PROOF"}</h2>
              <p>
                The final wallet signature binds the exact X post, handle, challenge, GenLayer resolver, and credential expiry. It costs no gas.
              </p>
              <div className="resolution-board">
                {resultRows.map(([label, state, detail]) => (
                  <div className={state} key={label}>
                    <span><i /> {label}</span>
                    <strong>{detail}</strong>
                  </div>
                ))}
              </div>
              {request?.finalizedRequestId ? (
                <div className="request-commitment">
                  <span>POST-BOUND REQUEST ID</span>
                  <code title={request.finalizedRequestId}>{shorten(request.finalizedRequestId, 13, 9)}</code>
                </div>
              ) : null}
              {request?.status === "INTENT_PREPARED" ? (
                <button className="button verify-primary" type="button" disabled={!typedData || Boolean(busy)} onClick={authorizeIntent}>
                  {busy === "intent-sign" ? "CHECK YOUR WALLET…" : "SIGN OWNERSHIP INTENT →"}
                </button>
              ) : null}
              {request?.status === "READY_FOR_GENLAYER" ? (
                <div className={`ready-gate${baseRelayNeedsReview || genlayerDidNotVerify || genlayerFailed ? " needs-review" : ""}`}>
                  <strong>
                    {baseProfileCurrent
                      ? "BASE SEPOLIA PROFILE ACTIVE"
                      : baseRelayNeedsReview
                        ? "BASE RELAY NEEDS REVIEW"
                        : genlayerDidNotVerify
                          ? "GENLAYER DID NOT VERIFY"
                          : genlayerFailed
                            ? "GENLAYER RESOLUTION NEEDS REVIEW"
                            : genlayerVerified
                              ? "GENLAYER VERIFIED / BASE PENDING"
                      : genlayerStarted
                        ? "GENLAYER PROCESSING"
                        : "AUTHORIZATION COMPLETE"}
                  </strong>
                  <p>
                    {baseProfileCurrent
                      ? `The registry profile is active until ${epochLabel(request.baseProfileExpiresAt)}. This wallet can now use its InfluencedX creator credential on Base Sepolia.`
                      : baseRelayNeedsReview
                        ? `The Base record is not a current verified profile${baseRelayErrorCode ? ` (${baseRelayErrorCode})` : ""}. InfluencedX will not present it as active.`
                        : genlayerDidNotVerify
                          ? `StudioNet finalized this request as ${request.genlayerOutcome ?? "UNDETERMINED"}. Nothing was relayed to Base.`
                          : genlayerFailed
                            ? `Durable state: ${request.submissionStatus.replaceAll("_", " ")}. Nothing is presented as verified on Base.`
                            : genlayerVerified
                              ? "Validator consensus is final. The creator credential is not active on Base until watcher quorum relays it to the receiver."
                      : genlayerStarted
                        ? `Durable state: ${request.submissionStatus.replaceAll("_", " ")}. You can leave this page and return later.`
                        : "Submit the sealed proof to StudioNet. The submitter cannot choose another contract, method, or argument set."}
                  </p>
                  {!genlayerStarted || genlayerRetryable ? (
                    <button
                      className="button verify-primary"
                      type="button"
                      disabled={!evidenceToken || Boolean(busy)}
                      onClick={submitToGenLayer}
                    >
                      {busy === "genlayer-submit"
                        ? "SUBMITTING…"
                        : genlayerRetryable
                          ? "RETRY EXACT REQUEST →"
                          : "SUBMIT TO GENLAYER →"}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {request && (genlayerVerified || effectiveBaseRelayStatus !== "NOT_STARTED") ? (
                <div className="base-proof-details" aria-label="Base Sepolia relay and profile details">
                  <div>
                    <span>BASE RELAY STATE</span>
                    <strong>{effectiveBaseRelayStatus.replaceAll("_", " ")}</strong>
                  </div>
                  <div>
                    <span>RELAY TRANSACTION</span>
                    {baseTxUrl ? (
                      <a href={baseTxUrl} rel="noreferrer" target="_blank">
                        {shorten(request.baseRelayTxHash, 10, 8)} ↗
                      </a>
                    ) : <strong>NOT BROADCAST</strong>}
                  </div>
                  <div>
                    <span>REGISTRY PROFILE</span>
                    <strong>{request.baseProfileId ? `#${request.baseProfileId}` : "NOT RECORDED"}</strong>
                  </div>
                  <div>
                    <span>CREDENTIAL EXPIRY</span>
                    <strong>{epochLabel(request.baseProfileExpiresAt)}</strong>
                  </div>
                  {request.baseProfileIdentityHash ? (
                    <div>
                      <span>IDENTITY COMMITMENT</span>
                      <code title={request.baseProfileIdentityHash}>{shorten(request.baseProfileIdentityHash, 12, 10)}</code>
                    </div>
                  ) : null}
                  {baseRegistryUrl ? (
                    <div>
                      <span>CREATOR REGISTRY</span>
                      <a href={baseRegistryUrl} rel="noreferrer" target="_blank">
                        {shorten(request.baseRegistryAddress, 10, 8)} ↗
                      </a>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="verify-footnote">
            <span>NO X OAUTH</span>
            <span>NO GAS FOR SIGNATURES</span>
            <span>PUBLIC EVIDENCE ONLY</span>
          </div>
        </section>
      </section>
    </main>
  );
}
