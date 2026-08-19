"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { broadcastMarketplaceTransaction, type GenLayerTransactionStage } from "../marketplace/marketplace-transaction";
import {
  STUDIONET_CHAIN_ID_HEX,
  STUDIONET_EXPLORER_URL,
  STUDIONET_FUNDING_GUIDE_URL,
  STUDIONET_RPC_URL,
  type ContentSource,
  type MarketplaceTransactionDto,
  studioNetExplorerLink,
} from "../marketplace/marketplace-types";
import { selectVerificationWallet } from "@/lib/verification-wallet";

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
  | "FARCASTER_CHALLENGE_ISSUED"
  | "ACTIVATION_PREPARED"
  | "READY_FOR_GENLAYER"
  | "PROFILE_ACTIVE"
  | "EXPIRED";

type VerificationRequest = {
  id: string;
  status: VerificationStatus;
  wallet: string;
  walletChallengeExpiresAt: string;
  walletAuthorizedAt: string | null;
  source?: ContentSource | null;
  handle: string | null;
  tweetText: string | null;
  xChallengeIssuedAt: string | null;
  xChallengeExpiresAt: string | null;
  credentialExpiresAt: string | null;
  normalizedVerificationPostUrl: string | null;
  verificationPostId: string | null;
  farcasterUsername?: string | null;
  farcasterFid?: string | number | null;
  farcasterCastText?: string | null;
  farcasterCastHash?: string | null;
  farcasterChallengeIssuedAt?: string | null;
  farcasterChallengeExpiresAt?: string | null;
  genlayerTxHash?: string | null;
  genlayerOutcome?: "VERIFIED" | "REJECTED" | "UNDETERMINED" | null;
  genlayerRetryable?: boolean | null;
  genlayerProfileId?: string | null;
  genlayerProfileActive?: boolean | null;
  genlayerProfileExpiresAt?: string | null;
  activationTxHash?: string | null;
  createdAt: string;
  updatedAt: string;
};

type WalletChallenge = { message: string; expiresAt: string };
type PreparedActivation = { request?: VerificationRequest; preparedId: string; transaction: MarketplaceTransactionDto };
type GenLayerProfile = {
  id?: string;
  profileId?: string;
  active: boolean;
  credentialExpiresAt?: string;
  expiresAt?: string;
  transactionHash?: string;
  outcome?: "VERIFIED" | "REJECTED" | "UNDETERMINED";
  retryable?: boolean;
};
type ActivationConfirmation = { request: VerificationRequest; profile: GenLayerProfile };
type ActivationRecovery = { preparedId: string; txHash: string; requestId: string; source: ContentSource };
type ApiErrorBody = { error?: string | { code?: string; message?: string }; code?: string; message?: string };

const ACTIVE_STEPS = [
  ["01", "CONNECT + SIGN"],
  ["02", "CHOOSE IDENTITY"],
  ["03", "PUBLISH PROOF"],
  ["04", "ACTIVATE ON GENLAYER"],
] as const;

export default function VerifyFlow() {
  const [request, setRequest] = useState<VerificationRequest | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [walletChallenge, setWalletChallenge] = useState<WalletChallenge | null>(null);
  const [handle, setHandle] = useState("");
  const [postUrl, setPostUrl] = useState("");
  const [identitySource, setIdentitySource] = useState<ContentSource>("X");
  const [farcasterUsername, setFarcasterUsername] = useState("");
  const [farcasterFid, setFarcasterFid] = useState("");
  const [farcasterCastHash, setFarcasterCastHash] = useState("");
  const [farcasterCastText, setFarcasterCastText] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [profile, setProfile] = useState<GenLayerProfile | null>(null);
  const [recovery, setRecovery] = useState<ActivationRecovery | null>(() => loadRecovery());

  const activeStep = statusStep(request, profile);
  const effectiveWallet = selectVerificationWallet(request?.wallet, wallet);
  const expired = request?.status === "EXPIRED";
  const profileActive = Boolean(profile?.active || request?.genlayerProfileActive || request?.status === "PROFILE_ACTIVE");
  const activationTxHash = profile?.transactionHash ?? request?.activationTxHash ?? request?.genlayerTxHash ?? recovery?.txHash ?? null;
  const activeSource = request?.source ?? recovery?.source ?? identitySource;

  useEffect(() => {
    let active = true;
    void api<{ request: VerificationRequest | null }>("/api/verification/status")
      .then((result) => {
        if (!active) return;
        setRequest(result.request);
        if (result.request?.source) setIdentitySource(result.request.source);
        if (result.request?.handle) setHandle(result.request.handle);
        if (result.request?.normalizedVerificationPostUrl) setPostUrl(result.request.normalizedVerificationPostUrl);
        if (result.request?.farcasterUsername) setFarcasterUsername(result.request.farcasterUsername);
        if (result.request?.farcasterFid !== null && result.request?.farcasterFid !== undefined) setFarcasterFid(String(result.request.farcasterFid));
        if (result.request?.farcasterCastHash) setFarcasterCastHash(result.request.farcasterCastHash);
        if (result.request?.farcasterCastText) setFarcasterCastText(result.request.farcasterCastText);
        if (result.request?.genlayerOutcome === "UNDETERMINED" && result.request.genlayerRetryable) {
          setNotice("GenLayer returned UNDETERMINED. Reuse the same published proof and retry activation before the challenge expires; do not publish again.");
        }
      })
      .catch((statusError: unknown) => {
        if (!active) return;
        if ((statusError as Error & { status?: number }).status !== 401) {
          setError(statusError instanceof Error ? statusError.message : "Could not load verification status.");
        }
      });
    return () => { active = false; };
  }, []);

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

  async function connectWallet() {
    setBusy("connect"); setError(null); setNotice(null);
    try {
      const provider = getProvider();
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const connectedWallet = firstAddress(accounts);
      if (!connectedWallet) throw new Error("The wallet did not return an account.");
      await ensureStudioNet(provider);
      if (request?.wallet && connectedWallet.toLowerCase() !== request.wallet.toLowerCase()) {
        throw new Error(`This run belongs to ${shorten(request.wallet)}. Reconnect that wallet to continue.`);
      }
      setWallet(connectedWallet);
      const result = await api<{ request: VerificationRequest; walletChallenge: WalletChallenge | null }>(
        "/api/verification/challenge",
        requestBody({ wallet: connectedWallet }),
      );
      setRequest(result.request); setWalletChallenge(result.walletChallenge);
      setNotice(result.walletChallenge
        ? "Wallet connected. Sign the one-time message to prove control; this costs no gas."
        : "Wallet ownership is already proved for this browser session.");
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "Could not connect the wallet.");
    } finally { setBusy(null); }
  }

  async function signWalletChallenge() {
    if (!request || !effectiveWallet || !walletChallenge) {
      setError("Reconnect the wallet to retrieve a fresh signing message.");
      return;
    }
    setBusy("wallet-sign"); setError(null);
    try {
      const provider = getProvider();
      requireSelectedAccount(await provider.request({ method: "eth_accounts" }), effectiveWallet);
      const signature = await provider.request({ method: "personal_sign", params: [messageToHex(walletChallenge.message), effectiveWallet] });
      if (typeof signature !== "string") throw new Error("The wallet did not return a signature.");
      const result = await api<{ request: VerificationRequest }>("/api/verification/authorize", requestBody({ requestId: request.id, signature }));
      setRequest(result.request); setWalletChallenge(null);
      setNotice("Wallet ownership proved. Choose the public identity you use for creator work.");
    } catch (signError) {
      setError(signError instanceof Error ? signError.message : "Wallet signature failed.");
    } finally { setBusy(null); }
  }

  async function createIdentityChallenge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request || !consent) return;
    setBusy("identity-challenge"); setError(null); setNotice(null);
    try {
      if (identitySource === "X") {
        const result = await api<{ request: VerificationRequest; xChallenge: { handle: string; tweetText?: string } }>(
          "/api/verification/x-challenge",
          requestBody({ requestId: request.id, handle }),
        );
        setRequest({ ...result.request, source: "X" });
        setHandle(result.xChallenge.handle);
        setNotice("Challenge created. Publish the exact text from the matching public X account.");
      } else {
        const username = normalizeFarcasterUsername(farcasterUsername);
        const fid = parseFarcasterFid(farcasterFid);
        const result = await api<{
          request: VerificationRequest;
          farcasterChallenge: {
            username: string;
            fid: string | number;
            castText: string;
            issuedAt: string;
            expiresAt: string;
            credentialExpiresAt: string;
          };
        }>(
          "/api/verification/farcaster-challenge",
          requestBody({ requestId: request.id, username, fid }),
        );
        setRequest({
          ...result.request,
          source: "FARCASTER",
          farcasterUsername: result.farcasterChallenge.username,
          farcasterFid: result.farcasterChallenge.fid,
          farcasterCastText: result.farcasterChallenge.castText,
          farcasterChallengeIssuedAt: result.farcasterChallenge.issuedAt,
          farcasterChallengeExpiresAt: result.farcasterChallenge.expiresAt,
        });
        setFarcasterUsername(result.farcasterChallenge.username);
        setFarcasterFid(String(result.farcasterChallenge.fid));
        setFarcasterCastText(result.farcasterChallenge.castText);
        setNotice("Challenge created. Publish the exact cast from the matching Farcaster account.");
      }
    } catch (challengeError) {
      setError(challengeError instanceof Error ? challengeError.message : "Could not create the identity challenge.");
    } finally { setBusy(null); }
  }

  async function activateProfile(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!request || !effectiveWallet) return;
    setBusy("activation"); setError(null); setNotice(null);
    try {
      const provider = getProvider();
      await ensureStudioNet(provider);
      requireSelectedAccount(await provider.request({ method: "eth_accounts" }), effectiveWallet);
      if (recovery) {
        if (recovery.requestId !== request.id) {
          throw new Error("A saved activation belongs to another verification run. Reopen that run or clear the saved browser session before preparing a new activation.");
        }
        await confirmActivation(recovery);
        return;
      }
      const source = request.source ?? identitySource;
      if (source === "FARCASTER" && !/^0x[0-9a-fA-F]{40}$/.test(farcasterCastHash.trim())) {
        throw new Error("Enter the 0x-prefixed 20-byte hash of your Farcaster challenge cast.");
      }
      setNotice(`Inspecting the public ${source === "FARCASTER" ? "cast" : "post"} and preparing the exact creator activation…`);
      const prepared = await api<PreparedActivation>(
        "/api/verification/activation",
        requestBody(source === "FARCASTER"
          ? { requestId: request.id, source, castHash: farcasterCastHash.trim().toLowerCase() }
          : { requestId: request.id, source, verificationPostUrl: postUrl.trim() }),
      );
      if (prepared.request) setRequest(prepared.request);
      const txHash = await broadcastMarketplaceTransaction(prepared.transaction, effectiveWallet, {
        expectedFunctionName: source === "FARCASTER" ? "activate_farcaster_creator" : "activate_creator",
        expectedValue: "0",
        onSubmitted: (hash) => {
          const value = { preparedId: prepared.preparedId, txHash: hash, requestId: request.id, source };
          saveRecovery(value); setRecovery(value);
        },
        onStage: (stage) => setNotice(activationNotice(stage)),
      });
      await confirmActivation({ preparedId: prepared.preparedId, txHash, requestId: request.id, source });
    } catch (activationError) {
      setError(activationError instanceof Error ? activationError.message : "Creator activation failed.");
    } finally { setBusy(null); }
  }

  async function confirmActivation(value: ActivationRecovery) {
    setNotice("Validator finality reached. Verifying the creator profile from contract state…");
    const confirmed = await api<ActivationConfirmation>(
      "/api/verification/activation/confirm",
      requestBody({ preparedId: value.preparedId, txHash: value.txHash }),
    );
    setRequest(confirmed.request); setProfile({ ...confirmed.profile, transactionHash: value.txHash });
    setRecovery(null); clearRecovery();
    const outcome = confirmed.profile.outcome ?? confirmed.request.genlayerOutcome;
    if (outcome === "UNDETERMINED") {
      if (confirmed.profile.retryable || confirmed.request.genlayerRetryable) {
        const expiry = value.source === "FARCASTER"
          ? confirmed.request.farcasterChallengeExpiresAt
          : confirmed.request.xChallengeExpiresAt;
        setNotice(`GenLayer returned UNDETERMINED. Retry a fresh activation with this same published proof before ${epochLabel(expiry ?? null)}; do not publish again.`);
        return;
      }
      throw new Error("GenLayer returned UNDETERMINED, but this challenge can no longer be retried. Start a new verification challenge and publish its new proof.");
    }
    if (outcome === "REJECTED" || !confirmed.profile.active) {
      throw new Error("GenLayer rejected this public proof. Do not retry the finalized transaction; start a new verification challenge with a new post or cast.");
    }
    setNotice(`${value.source === "FARCASTER" ? "Farcaster" : "X"} creator identity active on GenLayer StudioNet.`);
  }

  async function copyChallengeText() {
    const text = identitySource === "FARCASTER" ? farcasterCastText ?? request?.farcasterCastText : request?.tweetText;
    if (!text) return;
    try { await navigator.clipboard.writeText(text); setNotice("Exact challenge text copied."); }
    catch { setError("Could not copy automatically. Select the exact text and copy it manually."); }
  }

  const contentId = activeSource === "FARCASTER"
    ? farcasterCastHash || request?.farcasterCastHash || null
    : request?.verificationPostId ?? null;
  const resultRows = [
    ["PUBLIC CONTENT", contentId || request?.normalizedVerificationPostUrl ? "complete" : "future", contentId ? shorten(contentId, 8, 6) : activeSource === "FARCASTER" ? "CAST HASH REQUIRED" : "URL REQUIRED"],
    ["WALLET AUTHORITY", request?.walletAuthorizedAt ? "complete" : "future", request?.walletAuthorizedAt ? "SIGNED" : "NOT SIGNED"],
    ["GENLAYER TRANSACTION", activationTxHash ? profileActive ? "complete" : "pending" : "future", activationTxHash ? shorten(activationTxHash, 10, 8) : "NOT SUBMITTED"],
    ["CREATOR PROFILE", profileActive ? "complete" : "future", profileActive ? "ACTIVE" : "AWAITING FINALITY"],
  ] as const;
  const activationTxUrl = studioNetExplorerLink("tx", activationTxHash);
  const challengeText = activeSource === "FARCASTER"
    ? farcasterCastText ?? request?.farcasterCastText ?? ""
    : request?.tweetText ?? "";
  const challengeExpiry = activeSource === "FARCASTER"
    ? request?.farcasterChallengeExpiresAt ?? null
    : request?.xChallengeExpiresAt ?? null;
  const retryableUndetermined = request?.genlayerOutcome === "UNDETERMINED"
    && Boolean(request.genlayerRetryable)
    && !expired
    && Boolean(challengeExpiry);
  const challengeHandle = activeSource === "FARCASTER"
    ? farcasterUsername || request?.farcasterUsername || ""
    : request?.handle ?? handle;
  const composeUrl = activeSource === "FARCASTER"
    ? `https://farcaster.xyz/~/compose?text=${encodeURIComponent(challengeText)}`
    : `https://x.com/intent/post?text=${encodeURIComponent(challengeText)}`;

  return (
    <main className="verify-page">
      <header className="site-header verify-header">
        <Link className="brand" href="/" aria-label="InfluencedX home"><span className="brand-name">INFLUENCEDX</span></Link>
        <nav className="main-nav verify-nav" aria-label="Verification navigation"><Link href="/">MARKET</Link><Link href="/#proof">HOW IT WORKS</Link><Link aria-current="page" href="/verify">VERIFY IDENTITY</Link></nav>
        <div className="header-actions verify-header-status"><span className="network-label"><i /> GENLAYER STUDIONET</span><span className="verify-run-id">{request ? shorten(request.id, 9, 5) : "NEW RUN"}</span></div>
      </header>

      <section className="verify-layout">
        <aside className="verify-overview">
          <Link className="verify-back" href="/">← MARKET</Link><p className="eyebrow"><span /> CREATOR IDENTITY / PUBLIC PROOF</p><h1>PROVE<br /><em>YOUR ID.</em></h1>
          <p className="verify-lead">Bind a public X or Farcaster account to your StudioNet wallet. InfluencedX never asks for a social-account password.</p>
          <ol className="verify-progress" aria-label="Verification progress">{progress.map((item) => <li className={item.state} aria-current={item.state === "active" ? "step" : undefined} key={item.number}><strong>{item.number}</strong><span>{item.label}</span><em>{item.state === "complete" ? "DONE" : item.state === "active" ? "ACTIVE" : "LOCKED"}</em></li>)}</ol>
          <div className="verify-trust-strip"><span>PUBLIC ACCOUNTS ONLY</span><span>15 MIN CHALLENGE</span><span>30 DAY CREDENTIAL</span><span>GENLAYER STUDIONET</span></div>
        </aside>

        <section className="verify-workspace" aria-labelledby="verify-workspace-title">
          <div className="verify-workspace-head"><div><span>VERIFICATION RUN</span><strong id="verify-workspace-title">STEP {String(activeStep).padStart(2, "0")} / 04</strong></div><span className={expired ? "run-state error" : "run-state"}><i /> {request?.status?.replaceAll("_", " ") ?? "READY"}</span></div>
          <div className="security-gate" role="note"><span>SECURITY GATE</span><p>Your wallet signs the exact <code>{activeSource === "FARCASTER" ? "activate_farcaster_creator" : "activate_creator"}</code> transaction. InfluencedX verifies finality and the source-keyed GenLayer identity before showing it as active.</p></div>
          <div className="verify-announcer" aria-live="polite">{notice ? <p className="verify-notice">{notice}</p> : null}{error ? <p className="verify-error" role="alert">{error}</p> : null}</div>

          {activeStep === 1 ? <div className="verify-card"><p className="card-index">01 / WALLET PROOF</p><h2>{expired ? "CREATE A NEW CHALLENGE" : effectiveWallet ? "SIGN TO CONTINUE" : "CONNECT YOUR STUDIONET WALLET"}</h2><p>Connecting selects an address; the one-time message proves you control it.</p>{effectiveWallet ? <div className="connected-wallet"><span>WALLET CONNECTED</span><strong title={effectiveWallet}>{shorten(effectiveWallet)}</strong><small>STUDIONET · SIGN-IN COSTS NO GAS</small></div> : null}<button className="button verify-primary" type="button" disabled={Boolean(busy)} onClick={!effectiveWallet || expired ? connectWallet : signWalletChallenge}>{busy === "connect" ? "CHECK YOUR WALLET…" : busy === "wallet-sign" ? "SIGNING…" : expired ? "START NEW VERIFICATION →" : effectiveWallet ? "SIGN TO CONTINUE →" : "CONNECT WALLET →"}</button>{effectiveWallet && !walletChallenge && !expired ? <button className="verify-secondary" type="button" disabled={Boolean(busy)} onClick={connectWallet}>REFRESH SIGNING MESSAGE</button> : null}</div> : null}

          {activeStep === 2 ? (
            <form className="verify-card" onSubmit={createIdentityChallenge}>
              <p className="card-index">02 / PUBLIC ACCOUNT</p>
              <h2>CHOOSE YOUR IDENTITY SOURCE</h2>
              <p>The campaign contract keeps X and Farcaster identities separate. You can verify both against the same wallet.</p>
              <label className="verify-field">
                <span>IDENTITY SOURCE</span>
                <select value={identitySource} onChange={(event) => setIdentitySource(event.target.value as ContentSource)}>
                  <option value="X">X</option>
                  <option value="FARCASTER">Farcaster</option>
                </select>
                <small>Campaigns require an active identity for their selected source.</small>
              </label>
              {identitySource === "X" ? (
                <label className="verify-field">
                  <span>X HANDLE</span>
                  <input autoComplete="off" maxLength={16} name="handle" onChange={(event) => setHandle(event.target.value)} placeholder="@handle" required value={handle} />
                  <small>Only public profile and post evidence is used. X OAuth is not requested.</small>
                </label>
              ) : (
                <>
                  <label className="verify-field">
                    <span>FARCASTER USERNAME</span>
                    <input autoComplete="off" maxLength={16} name="farcasterUsername" onChange={(event) => setFarcasterUsername(event.target.value)} pattern="[a-z0-9][a-z0-9-]{0,15}" placeholder="username" required value={farcasterUsername} />
                    <small>Use the public primary username without @.</small>
                  </label>
                  <label className="verify-field">
                    <span>FARCASTER FID</span>
                    <input autoComplete="off" inputMode="numeric" name="farcasterFid" onChange={(event) => setFarcasterFid(event.target.value)} pattern="[1-9][0-9]*" placeholder="12345" required value={farcasterFid} />
                    <small>Use the numeric FID shown in your Farcaster profile details. It stays stable if your username changes.</small>
                  </label>
                </>
              )}
              <label className="consent-row"><input checked={consent} onChange={(event) => setConsent(event.target.checked)} type="checkbox" /><span>I authorize verification of this public account and its hashed identity commitment.</span></label>
              <button className="button verify-primary" type="submit" disabled={!consent || Boolean(busy)}>{busy === "identity-challenge" ? "CREATING CHALLENGE…" : "CREATE CHALLENGE →"}</button>
            </form>
          ) : null}

          {activeStep === 3 ? (
            <form className="verify-card" onSubmit={activateProfile}>
              <p className="card-index">03 / PUBLIC POST</p>
              <h2>{retryableUndetermined ? "RETRY THE ACTIVATION" : "PUBLISH THE CHALLENGE"}</h2>
              <p>{retryableUndetermined
                ? `Your published ${activeSource === "FARCASTER" ? "cast" : "post"} is still valid until ${epochLabel(challengeExpiry)}. Do not publish again; submit a fresh activation transaction with the same proof.`
                : `Publish this exact text from @${challengeHandle} on ${activeSource === "FARCASTER" ? "Farcaster" : "X"} before ${epochLabel(challengeExpiry)}.`}</p>
              <div className="tweet-proof"><div><span>EXACT POST TEXT</span><strong>@{challengeHandle}</strong></div><pre>{challengeText}</pre></div>
              <div className="tweet-actions"><button className="verify-secondary" type="button" onClick={copyChallengeText}>COPY EXACT TEXT</button><a className="button button-small" href={composeUrl} rel="noreferrer" target="_blank">OPEN {activeSource === "FARCASTER" ? "FARCASTER" : "X"} TO POST →</a></div>
              {activeSource === "FARCASTER" ? (
                <label className="verify-field">
                  <span>FARCASTER CAST HASH</span>
                  <input autoComplete="off" name="castHash" onChange={(event) => setFarcasterCastHash(event.target.value)} pattern="0x[0-9a-fA-F]{40}" placeholder={`0x${"a".repeat(40)}`} required type="text" value={farcasterCastHash} />
                  <small>After publishing, open the cast details and copy its full canonical 0x-prefixed 20-byte hash. A client URL or shortened hash is not accepted.</small>
                </label>
              ) : (
                <label className="verify-field"><span>PUBLIC TEXT-POST URL</span><input inputMode="url" name="postUrl" onChange={(event) => setPostUrl(event.target.value)} placeholder="https://x.com/handle/status/…" required type="url" value={postUrl} /><small>The URL is inspected and its numeric post ID is frozen before your wallet sees the activation call.</small></label>
              )}
              <button className="button verify-primary" type="submit" disabled={Boolean(busy)}>{busy === "activation" ? "WAITING FOR FINALITY…" : retryableUndetermined ? `RETRY ${activeSource} ACTIVATION →` : `VERIFY ${activeSource} + ACTIVATE ON GENLAYER →`}</button>
            </form>
          ) : null}

          {activeStep === 4 ? <div className="verify-card"><p className="card-index">04 / GENLAYER FINALITY</p><h2>{profileActive ? "CREATOR PROFILE ACTIVE." : recovery ? "RECONCILE YOUR TRANSACTION" : "AUTHORIZE THE FINAL PROOF"}</h2><p>The payable value is zero. Your wallet signs the exact public-proof activation, then validators evaluate it and finalize the profile.</p><div className="resolution-board">{resultRows.map(([label, rowState, detail]) => <div className={rowState} key={label}><span><i /> {label}</span><strong>{detail}</strong></div>)}</div>{request?.id ? <div className="request-commitment"><span>REQUEST ID</span><code title={request.id}>{shorten(request.id, 13, 9)}</code></div> : null}{!profileActive ? <button className="button verify-primary" type="button" disabled={Boolean(busy)} onClick={() => void activateProfile()}>{busy === "activation" ? "WAITING FOR FINALITY…" : recovery ? "RECONCILE FINALIZED TX →" : "ACTIVATE ON GENLAYER →"}</button> : <Link className="button verify-primary" href={`/marketplace/creators/${encodeURIComponent(effectiveWallet ?? request?.wallet ?? "")}`}>VIEW CREATOR PROFILE →</Link>}{activationTxUrl ? <div className="chain-proof-details"><div><span>STUDIONET TRANSACTION</span><a href={activationTxUrl} rel="noreferrer" target="_blank">{shorten(activationTxHash, 10, 8)} ↗</a></div><div><span>PROFILE EXPIRY</span><strong>{epochLabel(profile?.credentialExpiresAt ?? profile?.expiresAt ?? request?.genlayerProfileExpiresAt ?? request?.credentialExpiresAt ?? null)}</strong></div></div> : null}</div> : null}

          <div className="verify-footnote"><span>NO SOCIAL PASSWORDS</span><span>USER-SIGNED TRANSACTION</span><a href={STUDIONET_FUNDING_GUIDE_URL} target="_blank" rel="noreferrer">NEED TEST GEN? OFFICIAL GUIDE ↗</a></div>
        </section>
      </section>
    </main>
  );
}

function getProvider(): EthereumProvider {
  if (!window.ethereum) throw new Error("No browser wallet found. Install a wallet that supports GenLayer StudioNet.");
  return window.ethereum;
}

async function ensureStudioNet(provider: EthereumProvider): Promise<void> {
  const chainId = String(await provider.request({ method: "eth_chainId" })).toLowerCase();
  if (chainId === STUDIONET_CHAIN_ID_HEX) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: STUDIONET_CHAIN_ID_HEX }] });
  } catch (switchError) {
    if ((switchError as { code?: number }).code !== 4_902) throw switchError;
    await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: STUDIONET_CHAIN_ID_HEX, chainName: "GenLayer StudioNet", nativeCurrency: { name: "GEN Token", symbol: "GEN", decimals: 18 }, rpcUrls: [STUDIONET_RPC_URL], blockExplorerUrls: [STUDIONET_EXPLORER_URL] }] });
  }
}

function statusStep(request: VerificationRequest | null, profile: GenLayerProfile | null): number {
  if (profile?.active || request?.status === "PROFILE_ACTIVE" || request?.genlayerProfileActive) return 4;
  if (!request || request.status === "WALLET_CHALLENGE_PENDING" || request.status === "EXPIRED") return 1;
  if (!request.walletAuthorizedAt || request.status === "WALLET_AUTHORIZED") return 2;
  if (request.status === "X_CHALLENGE_ISSUED" || request.status === "FARCASTER_CHALLENGE_ISSUED") return 3;
  return 4;
}

function activationNotice(stage: GenLayerTransactionStage): string {
  if (stage === "wallet") return "Confirm the exact source-specific activation call in your wallet…";
  if (stage === "submitted") return "Activation submitted. Its hash is saved for safe recovery.";
  if (stage === "finality") return "Waiting for GenLayer validators to reach finality…";
  return "Activation finalized.";
}

function requireSelectedAccount(accounts: unknown, expected: string): void {
  if (!Array.isArray(accounts) || !accounts.some((account) => typeof account === "string" && account.toLowerCase() === expected.toLowerCase())) {
    throw new Error(`Reconnect ${shorten(expected)} before signing.`);
  }
}

function firstAddress(value: unknown): string | null {
  if (!Array.isArray(value) || typeof value[0] !== "string") return null;
  return /^0x[\da-f]{40}$/i.test(value[0]) ? value[0].toLowerCase() : null;
}

function messageToHex(message: string): `0x${string}` {
  return `0x${Array.from(new TextEncoder().encode(message), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function normalizeFarcasterUsername(value: string): string {
  const normalized = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,15}$/.test(normalized)) {
    throw new Error("Enter a valid Farcaster username with letters, numbers, or hyphens.");
  }
  return normalized;
}

function parseFarcasterFid(value: string): string {
  const normalized = value.trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new Error("Enter a positive numeric Farcaster FID.");
  if (normalized.length > 78 || BigInt(normalized) >= 1n << 256n) {
    throw new Error("The Farcaster FID is outside the supported range.");
  }
  return normalized;
}

function shorten(value: string | null, start = 7, end = 5): string {
  if (!value || value.length <= start + end + 1) return value ?? "—";
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function epochLabel(value: string | number | null): string {
  if (!value) return "—";
  const date = typeof value === "number" ? new Date(value > 10_000_000_000 ? value : value * 1_000) : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

function errorMessage(body: ApiErrorBody, fallback: string): string {
  if (typeof body.error === "string") return body.error;
  if (body.error && typeof body.error.message === "string") return body.error.message;
  return typeof body.message === "string" ? body.message : fallback;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers }, cache: "no-store", credentials: "same-origin" });
  const body = (await response.json().catch(() => ({}))) as ApiErrorBody & T;
  if (!response.ok) {
    const error = new Error(errorMessage(body, `InfluencedX request failed (${response.status}).`));
    Object.assign(error, { status: response.status, code: body.code });
    throw error;
  }
  return body;
}

function requestBody(value: unknown): RequestInit { return { method: "POST", body: JSON.stringify(value) }; }

function loadRecovery(): ActivationRecovery | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem("influencedx:studionet-activation") ?? "null") as Partial<ActivationRecovery> | null;
    if (!parsed || typeof parsed.preparedId !== "string" || typeof parsed.txHash !== "string" || typeof parsed.requestId !== "string" || !/^0x[\da-f]{64}$/i.test(parsed.txHash)) return null;
    return { preparedId: parsed.preparedId, txHash: parsed.txHash, requestId: parsed.requestId, source: parsed.source === "FARCASTER" ? "FARCASTER" : "X" };
  } catch { return null; }
}

function saveRecovery(value: ActivationRecovery): void { window.sessionStorage.setItem("influencedx:studionet-activation", JSON.stringify(value)); }
function clearRecovery(): void { window.sessionStorage.removeItem("influencedx:studionet-activation"); }
