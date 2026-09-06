"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  broadcastMarketplaceTransaction,
  isExplicitEip1193UserRejection,
  isTerminalMarketplaceTransactionError,
  type GenLayerTransactionStage,
} from "../marketplace/marketplace-transaction";
import {
  STUDIONET_CHAIN_ID_HEX,
  STUDIONET_EXPLORER_URL,
  STUDIONET_FUNDING_GUIDE_URL,
  STUDIONET_RPC_URL,
  type MarketplaceTransactionDto,
  studioNetExplorerLink,
} from "../marketplace/marketplace-types";
import { selectVerificationWallet } from "@/lib/verification-wallet";
import { useMarketplaceWallet } from "../marketplace/use-marketplace-wallet";
import { farcasterCastUrlForHash } from "./farcaster-cast-url";
import { shouldRejectVerificationResponse } from "./verification-api-client";
import { parseBoundIdentityBundleRecovery, recoveryMatchesActiveBundle, type BoundIdentityBundleRecovery } from "./verification-recovery";

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

type VerificationOutcome = "VERIFIED" | "REJECTED" | "UNDETERMINED";
type VerificationRequest = {
  id: string;
  revision: number;
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
  farcasterUsername?: string | null;
  farcasterFid?: string | number | null;
  farcasterCastText?: string | null;
  farcasterCastHash?: string | null;
  farcasterChallengeIssuedAt?: string | null;
  farcasterChallengeExpiresAt?: string | null;
  identityBundleReady?: boolean;
  identityBundleRequestId?: string | null;
  activationPreparedId?: string | null;
  activationRecovery?: unknown;
  genlayerTxHash?: string | null;
  activationTxHash?: string | null;
  genlayerOutcome?: VerificationOutcome | null;
  genlayerRetryable?: boolean | null;
  genlayerProfileActive?: boolean | null;
  createdAt: string;
  updatedAt: string;
};

type IdentityChallengeResponse = {
  request: VerificationRequest;
  xChallenge: { handle: string; tweetText: string; issuedAt: string; expiresAt: string; credentialExpiresAt: string };
  farcasterChallenge: { username: string; fid: string | number; castText: string; issuedAt: string; expiresAt: string; credentialExpiresAt: string };
};
type PreparedActivation = {
  request?: VerificationRequest;
  preparedId: string;
  bundleRequestId: string;
  transaction: MarketplaceTransactionDto;
};
type GenLayerProfile = {
  active: boolean;
  outcome?: VerificationOutcome;
  retryable?: boolean;
  credentialExpiresAt?: string;
  expiresAt?: string;
};
type BundleResult = {
  requestId: string;
  outcome: VerificationOutcome;
  retryable?: boolean;
  transactionHash?: string;
};
type ActivationConfirmation = {
  request: VerificationRequest;
  profiles: { x: GenLayerProfile | null; farcaster: GenLayerProfile | null };
  bundle: BundleResult;
};
type LegacyActivationConfirmation = { request: VerificationRequest; profile: GenLayerProfile };
type ActivationRecovery = BoundIdentityBundleRecovery;
type ReadyActivationRetry = {
  requestId: string;
  wallet: string;
  verificationPostUrl: string;
  farcasterCastUrl: string;
  prepared: PreparedActivation;
};
type ApiErrorBody = { error?: string | { code?: string; message?: string }; code?: string; message?: string };

const ACTIVE_STEPS = [
  ["01", "WALLET"],
  ["02", "ACCOUNTS"],
  ["03", "POSTS"],
  ["04", "VERIFY"],
] as const;

export default function VerifyFlow() {
  const persistentWallet = useMarketplaceWallet();
  return <VerificationSession key={persistentWallet.disconnectVersion} persistentWallet={persistentWallet} />;
}

function VerificationSession({ persistentWallet }: { persistentWallet: ReturnType<typeof useMarketplaceWallet> }) {
  const [request, setRequest] = useState<VerificationRequest | null>(null);
  const wallet = persistentWallet.address;
  const [loadingRequest, setLoadingRequest] = useState(true);
  const [handle, setHandle] = useState("");
  const [postUrl, setPostUrl] = useState("");
  const [farcasterUsername, setFarcasterUsername] = useState("");
  const [farcasterCastUrl, setFarcasterCastUrl] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ActivationConfirmation["profiles"] | null>(null);
  const [bundle, setBundle] = useState<BundleResult | null>(null);
  const [recovery, setRecovery] = useState<ActivationRecovery | null>(() => loadRecovery());
  const [activationDetachReady, setActivationDetachReady] = useState(false);
  const switchingWalletRef = useRef(false);
  const flowGenerationRef = useRef(0);
  const activationReadyRetryRef = useRef<ReadyActivationRetry | null>(null);

  const effectiveWallet = selectVerificationWallet(request?.wallet, wallet);
  const walletMismatch = Boolean(request?.wallet && wallet && wallet.toLowerCase() !== request.wallet.toLowerCase());
  const bundleReady = hasBothChallenges(request);
  const expired = request?.status === "EXPIRED";
  const terminalOutcome = request?.genlayerOutcome === "REJECTED"
    || (request?.genlayerOutcome === "UNDETERMINED" && !request.genlayerRetryable);
  const bundleActive = Boolean(
    (bundle?.outcome === "VERIFIED" && profiles?.x?.active && profiles.farcaster?.active)
    || (request?.genlayerOutcome === "VERIFIED" && request.genlayerProfileActive && bundleReady),
  );
  const activationTxHash = bundle?.transactionHash
    ?? request?.activationTxHash
    ?? request?.genlayerTxHash
    ?? recovery?.txHash
    ?? null;
  const activeRunRequest = request
    && request.status !== "EXPIRED"
    && request.genlayerOutcome !== "VERIFIED"
    && request.genlayerOutcome !== "REJECTED"
    ? request
    : null;
  const hashBoundHint = activationDetachReady;
  const switchBusyBlocked = Boolean(
    busy && !(busy === "activation" && activationDetachReady),
  );
  const restoring = persistentWallet.restoring || loadingRequest;
  const activeStep = persistentWallet.authenticated && !walletMismatch
    ? statusStep(request, bundleActive, recovery)
    : 1;

  useEffect(() => {
    let active = true;
    const generation = flowGenerationRef.current;
    void api<{ request: VerificationRequest | null }>("/api/verification/status")
      .then((result) => {
        if (
          !active
          || switchingWalletRef.current
          || generation !== flowGenerationRef.current
        ) return;
        const serverRecovery = parseBoundIdentityBundleRecovery(
          result.request?.activationRecovery,
          result.request?.id,
        );
        const candidateRecovery = serverRecovery ?? recovery;
        if (candidateRecovery && recoveryMatchesActiveBundle(candidateRecovery, result.request)) {
          if (!sameRecovery(candidateRecovery, recovery)) {
            saveRecovery(candidateRecovery);
            setRecovery(candidateRecovery);
          }
        } else if (recovery) {
          clearRecovery();
          setRecovery(null);
        }
        setActivationDetachReady(Boolean(
          serverRecovery
          || result.request?.activationTxHash
          || result.request?.genlayerTxHash,
        ));
        setRequest(result.request);
        hydrateFields(result.request, { setHandle, setPostUrl, setFarcasterUsername, setFarcasterCastUrl });
      })
      .catch((statusError: unknown) => {
        if (
          active
          && !switchingWalletRef.current
          && generation === flowGenerationRef.current
          && (statusError as Error & { status?: number }).status !== 401
        ) setError(readError(statusError, "Could not load this run."));
      })
      .finally(() => {
        if (active && generation === flowGenerationRef.current) setLoadingRequest(false);
      });
    return () => { active = false; };
  }, [recovery]);

  const progress = ACTIVE_STEPS.map(([number, label], index) => ({
    number,
    label,
    state: index + 1 < activeStep ? "complete" : index + 1 === activeStep ? "active" : "future",
  }));

  async function connectWallet() {
    setBusy("connect"); setError(null); setNotice(null);
    const generation = flowGenerationRef.current;
    try {
      const connectedWallet = await persistentWallet.authenticate();
      if (generation !== flowGenerationRef.current) return;
      switchingWalletRef.current = false;
      if (request?.wallet && connectedWallet.toLowerCase() !== request.wallet.toLowerCase()) throw new Error(`Switch to ${shorten(request.wallet)}.`);
      const result = await api<{ request: VerificationRequest }>(
        "/api/verification/challenge",
        requestBody({ wallet: connectedWallet }),
      );
      if (generation !== flowGenerationRef.current) return;
      setRequest(result.request);
      if (result.request.id !== request?.id) {
        activationReadyRetryRef.current = null;
        setProfiles(null); setBundle(null); setPostUrl(""); setFarcasterCastUrl("");
        setActivationDetachReady(false);
      }
    } catch (connectError) {
      switchingWalletRef.current = false;
      setError(readError(connectError, "Wallet connection failed."));
    } finally { setBusy(null); }
  }

  async function createIdentityChallenges(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request || !consent) return;
    setBusy("identity-challenge"); setError(null); setNotice(null);
    activationReadyRetryRef.current = null;
    try {
      const result = await api<IdentityChallengeResponse>(
        "/api/verification/identity-challenge",
        requestBody({
          requestId: request.id,
          handle: normalizeXHandle(handle),
          farcasterUsername: normalizeFarcasterUsername(farcasterUsername),
        }),
      );
      setRequest({
        ...result.request,
        identityBundleReady: true,
        handle: result.xChallenge.handle,
        tweetText: result.xChallenge.tweetText,
        xChallengeIssuedAt: result.xChallenge.issuedAt,
        xChallengeExpiresAt: result.xChallenge.expiresAt,
        credentialExpiresAt: result.xChallenge.credentialExpiresAt,
        farcasterUsername: result.farcasterChallenge.username,
        farcasterFid: result.farcasterChallenge.fid,
        farcasterCastText: result.farcasterChallenge.castText,
        farcasterChallengeIssuedAt: result.farcasterChallenge.issuedAt,
        farcasterChallengeExpiresAt: result.farcasterChallenge.expiresAt,
      });
      setHandle(result.xChallenge.handle);
      setFarcasterUsername(result.farcasterChallenge.username);
      setPostUrl("");
      setFarcasterCastUrl("");
    } catch (challengeError) {
      setError(readError(challengeError, "Could not create challenges."));
    } finally { setBusy(null); }
  }

  async function activateBundle(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!request || !effectiveWallet) return;
    const generation = flowGenerationRef.current;
    let readyMayBeRetried = false;
    setBusy("activation"); setError(null); setNotice(null);
    try {
      const provider = getProvider();
      await ensureStudioNet(provider);
      requireSelectedAccount(await provider.request({ method: "eth_accounts" }), effectiveWallet);
      if (recovery) {
        activationReadyRetryRef.current = null;
        if (!recoveryMatchesActiveBundle(recovery, request)) {
          clearRecovery(); setRecovery(null);
          throw new Error("Saved transaction cleared. Retry.");
        }
        await confirmActivation(recovery, generation);
        return;
      }
      setActivationDetachReady(false);
      const normalizedVerificationPostUrl = postUrl.trim();
      const normalizedFarcasterCastUrl = farcasterCastUrl.trim();
      if (!normalizedVerificationPostUrl) throw new Error("Add the X URL.");
      if (!normalizedFarcasterCastUrl) throw new Error("Add the Farcaster URL.");
      const normalizedWallet = effectiveWallet.toLowerCase();
      const ready = activationReadyRetryRef.current;
      const reusableReady = ready
        && ready.requestId === request.id
        && ready.wallet === normalizedWallet
        && ready.verificationPostUrl === normalizedVerificationPostUrl
        && ready.farcasterCastUrl === normalizedFarcasterCastUrl
        ? ready
        : null;
      if (ready && !reusableReady) activationReadyRetryRef.current = null;
      const prepared = reusableReady?.prepared ?? await api<PreparedActivation>(
        "/api/verification/activation",
        requestBody({ requestId: request.id, verificationPostUrl: normalizedVerificationPostUrl, farcasterCastUrl: normalizedFarcasterCastUrl }),
      );
      activationReadyRetryRef.current = {
        requestId: request.id,
        wallet: normalizedWallet,
        verificationPostUrl: normalizedVerificationPostUrl,
        farcasterCastUrl: normalizedFarcasterCastUrl,
        prepared,
      };
      readyMayBeRetried = true;
      if (prepared.request) setRequest(prepared.request);
      const txHash = await broadcastMarketplaceTransaction(prepared.transaction, effectiveWallet, {
        expectedFunctionName: "activate_identity_bundle",
        expectedValue: "0",
        onSubmitted: async (hash) => {
          readyMayBeRetried = false;
          activationReadyRetryRef.current = null;
          const value = { preparedId: prepared.preparedId, txHash: hash, requestId: request.id };
          saveRecovery(value); setRecovery(value);
          await api<{ accepted: true; preparedId: string; txHash: string }>(
            "/api/verification/activation/submitted",
            requestBody({ preparedId: prepared.preparedId, txHash: hash }),
          );
          if (generation === flowGenerationRef.current) {
            setActivationDetachReady(true);
          }
        },
        onStage: (stage) => {
          if (generation === flowGenerationRef.current && !switchingWalletRef.current) {
            setNotice(activationNotice(stage));
          }
        },
      });
      readyMayBeRetried = false;
      activationReadyRetryRef.current = null;
      if (generation !== flowGenerationRef.current) return;
      await confirmActivation(
        { preparedId: prepared.preparedId, txHash, requestId: request.id },
        generation,
      );
    } catch (activationError) {
      if (!(readyMayBeRetried && isExplicitEip1193UserRejection(activationError))) {
        activationReadyRetryRef.current = null;
      }
      if (isTerminalMarketplaceTransactionError(activationError)) {
        clearRecovery();
        setRecovery(null);
      }
      if (generation === flowGenerationRef.current && !switchingWalletRef.current) {
        setError(walletPromptRejected(activationError)
          ? "Transaction cancelled. Retry verification."
          : readError(activationError, "Verification failed. Retry."));
      }
    } finally {
      setBusy((current) => current === "activation" ? null : current);
    }
  }

  async function confirmActivation(
    value: ActivationRecovery,
    generation = flowGenerationRef.current,
  ) {
    if (generation === flowGenerationRef.current && !switchingWalletRef.current) {
      setNotice("Checking finality…");
    }
    const confirmed = await api<ActivationConfirmation | LegacyActivationConfirmation>(
      "/api/verification/activation/confirm",
      requestBody({ preparedId: value.preparedId, txHash: value.txHash }),
    );
    if (generation !== flowGenerationRef.current || switchingWalletRef.current) return;
    setRequest(confirmed.request);
    setRecovery(null); clearRecovery();
    if (!("bundle" in confirmed)) {
      setNotice("Recovered. Add both accounts.");
      return;
    }
    const result = { ...confirmed.bundle, transactionHash: value.txHash };
    setProfiles(confirmed.profiles);
    setBundle(result);
    if (result.outcome === "UNDETERMINED") {
      if (result.retryable) {
        return;
      }
      throw new Error("Could not verify. Start again.");
    }
    if (result.outcome !== "VERIFIED" || !confirmed.profiles.x?.active || !confirmed.profiles.farcaster?.active) {
      throw new Error("Proof rejected. Start again.");
    }
  }

  async function switchWallet() {
    if (switchBusyBlocked) return;
    if (
      activeRunRequest
      && !window.confirm(
        hashBoundHint
          ? "Sign out? Transaction will continue."
          : "Switch wallet? This run will end.",
      )
    ) return;
    switchingWalletRef.current = true;
    setBusy("switch-wallet"); setError(null); setNotice(null);
    try {
      await persistentWallet.signOut(activeRunRequest
        ? { verificationRequest: { id: activeRunRequest.id, revision: activeRunRequest.revision } }
        : undefined);
      flowGenerationRef.current += 1;
      activationReadyRetryRef.current = null;
      clearRecovery();
      setRecovery(null);
      setRequest(null);
      setHandle("");
      setPostUrl("");
      setFarcasterUsername("");
      setFarcasterCastUrl("");
      setConsent(false);
      setProfiles(null);
      setBundle(null);
      setActivationDetachReady(false);
      setError(null);
    } catch (switchError) {
      switchingWalletRef.current = false;
      setError(
        walletMismatch && request
          ? `Switch back to ${shorten(request.wallet)}.`
          : readError(switchError, "Could not switch wallets."),
      );
    } finally {
      setBusy((current) => current === "switch-wallet" ? null : current);
    }
  }

  async function copyChallengeText(source: "X" | "FARCASTER") {
    const text = source === "X" ? request?.tweetText : request?.farcasterCastText;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${source === "X" ? "X" : "Farcaster"} copied.`);
    } catch {
      setError("Copy failed. Select the text manually.");
    }
  }

  const challengeExpiry = earliestExpiry(request?.xChallengeExpiresAt, request?.farcasterChallengeExpiresAt);
  const retryableUndetermined = (bundle?.outcome === "UNDETERMINED" || request?.genlayerOutcome === "UNDETERMINED")
    && Boolean(bundle?.retryable ?? request?.genlayerRetryable)
    && !expired;
  const activationTxUrl = studioNetExplorerLink("tx", activationTxHash);
  const resultRows = [
    ["X", request?.verificationPostId ? "complete" : "future", request?.verificationPostId ? shorten(request.verificationPostId, 8, 6) : "POST REQUIRED"],
    ["FARCASTER", request?.farcasterCastHash ? "complete" : "future", request?.farcasterCastHash ? shorten(request.farcasterCastHash, 8, 6) : "CAST REQUIRED"],
  ] as const;

  return (
    <main className="verify-page">
      <header className="site-header verify-header">
        <Link className="brand" href="/" aria-label="InfluencedX home"><span className="brand-name">INFLUENCEDX</span></Link>
        <nav className="main-nav verify-nav" aria-label="Verification navigation"><Link href="/">MARKET</Link><Link aria-current="page" href="/verify">VERIFY</Link></nav>
        <div className="header-actions verify-header-status"><span className="network-label"><i /> STUDIONET</span><span className="verify-run-id">{request ? shorten(request.id, 9, 5) : "NEW"}</span></div>
      </header>

      <section className="verify-layout">
        <aside className="verify-overview">
          <Link className="verify-back" href="/">← MARKET</Link><p className="eyebrow"><span /> IDENTITY</p><h1>VERIFY<br /><em>BOTH.</em></h1>
          <p className="verify-lead">Link X + Farcaster to one wallet.</p>
          <ol className="verify-progress" aria-label="Verification progress">{progress.map((item) => <li className={item.state} aria-current={item.state === "active" ? "step" : undefined} key={item.number}><strong>{item.number}</strong><span>{item.label}</span><em>{item.state === "complete" ? "DONE" : item.state === "active" ? "NOW" : "NEXT"}</em></li>)}</ol>
        </aside>

        <section className="verify-workspace" aria-labelledby="verify-workspace-title">
          <div className="verify-workspace-head"><div><span>VERIFICATION</span><strong id="verify-workspace-title">STEP {String(activeStep).padStart(2, "0")} / 04</strong></div><span className={expired ? "run-state error" : "run-state"}><i /> {expired ? "EXPIRED" : bundleActive ? "VERIFIED" : "READY"}</span></div>
          {persistentWallet.hasSession || request || wallet ? (
            <button
              className="verify-secondary verify-switch-wallet"
              disabled={switchBusyBlocked || persistentWallet.authenticating || persistentWallet.disconnecting || restoring}
              onClick={() => void switchWallet()}
              type="button"
            >
              {persistentWallet.disconnecting ? "DISCONNECTING…" : "DISCONNECT WALLET"}
            </button>
          ) : null}
          <div className="verify-announcer" aria-live="polite">
            {notice || persistentWallet.walletNotice ? <p className="verify-notice">{notice ?? persistentWallet.walletNotice}</p> : null}
            {error || walletMismatch ? <p className="verify-error" role="alert">{error ?? `Switch back to ${shorten(request?.wallet ?? "")}.`}</p> : null}
          </div>

          {activeStep === 1 ? (
            <div className="verify-card">
              <h2>{restoring ? "RESTORING SESSION" : expired || terminalOutcome ? "START AGAIN" : persistentWallet.authenticated ? "WALLET CONNECTED" : "CONNECT WALLET"}</h2>
              {effectiveWallet ? <div className="connected-wallet"><span>WALLET</span><strong title={effectiveWallet}>{shorten(effectiveWallet)}</strong><small>GENLAYER STUDIONET</small></div> : null}
              <button className="button verify-primary" type="button" disabled={Boolean(busy) || restoring || persistentWallet.disconnecting || walletMismatch} onClick={connectWallet}>{restoring ? "RESTORING…" : persistentWallet.authenticating ? "SIGNING IN…" : busy === "connect" ? "CONTINUING…" : persistentWallet.authenticated ? "CONTINUE →" : "CONNECT + SIGN →"}</button>
            </div>
          ) : null}

          {activeStep === 2 ? (
            <form className="verify-card" onSubmit={createIdentityChallenges}>
              <h2>ADD ACCOUNTS.</h2>
              <div className="identity-grid">
                <label className="verify-field"><span>X HANDLE</span><input autoComplete="off" maxLength={16} name="handle" onChange={(event) => setHandle(event.target.value)} placeholder="@handle" required value={handle} /></label>
                <label className="verify-field"><span>FARCASTER USERNAME</span><input autoComplete="off" maxLength={16} name="farcasterUsername" onChange={(event) => setFarcasterUsername(event.target.value)} pattern="[a-z0-9][a-z0-9-]{0,15}" placeholder="username" required value={farcasterUsername} /></label>
              </div>
              <label className="consent-row"><input checked={consent} onChange={(event) => setConsent(event.target.checked)} type="checkbox" /><span>Verify these public accounts.</span></label>
              <button className="button verify-primary" type="submit" disabled={!consent || Boolean(busy)}>{busy === "identity-challenge" ? "CREATING…" : "CREATE CHALLENGES →"}</button>
            </form>
          ) : null}

          {activeStep === 3 ? (
            <form className="verify-card" onSubmit={activateBundle}>
              <h2>{retryableUndetermined ? "RETRY." : "POST BOTH."}</h2>
              <p>{retryableUndetermined ? "Use the same posts." : `Post both before ${epochLabel(challengeExpiry)}.`}</p>
              <div className="bundle-proofs">
                <ChallengeProof source="X" account={`@${request?.handle ?? handle}`} text={request?.tweetText ?? ""} composeUrl={`https://x.com/intent/post?text=${encodeURIComponent(request?.tweetText ?? "")}`} onCopy={() => void copyChallengeText("X")} />
                <ChallengeProof source="FARCASTER" account={`@${request?.farcasterUsername ?? farcasterUsername}`} text={request?.farcasterCastText ?? ""} composeUrl={`https://farcaster.xyz/~/compose?text=${encodeURIComponent(request?.farcasterCastText ?? "")}`} onCopy={() => void copyChallengeText("FARCASTER")} />
              </div>
              <div className="proof-inputs">
                <label className="verify-field"><span>X POST URL</span><input inputMode="url" name="postUrl" onChange={(event) => setPostUrl(event.target.value)} placeholder="https://x.com/handle/status/…" required type="url" value={postUrl} /></label>
                <label className="verify-field"><span>FARCASTER CAST URL</span><input autoComplete="off" inputMode="url" name="farcasterCastUrl" onChange={(event) => setFarcasterCastUrl(event.target.value)} placeholder="https://farcaster.xyz/username/0x…" required type="url" value={farcasterCastUrl} /></label>
              </div>
              <button className="button verify-primary" type="submit" disabled={Boolean(busy)}>{busy === "activation" ? "VERIFYING…" : retryableUndetermined ? "RETRY BOTH →" : "VERIFY BOTH · 1 TRANSACTION →"}</button>
              <a className="verify-funding-link" href={STUDIONET_FUNDING_GUIDE_URL} target="_blank" rel="noreferrer">NEED TEST GEN? ↗</a>
            </form>
          ) : null}

          {activeStep === 4 ? (
            <div className="verify-card">
              <h2>{bundleActive ? "VERIFIED." : "FINALIZING."}</h2>
              <div className="resolution-board">{resultRows.map(([label, rowState, detail]) => <div className={rowState} key={label}><span><i /> {label}</span><strong>{detail}</strong></div>)}</div>
              {!bundleActive ? <button className="button verify-primary" type="button" disabled={Boolean(busy)} onClick={() => void activateBundle()}>{busy === "activation" ? "CHECKING…" : "CHECK TRANSACTION →"}</button> : <Link className="button verify-primary" href={`/marketplace/creators/${encodeURIComponent(effectiveWallet ?? "")}`}>VIEW PROFILE →</Link>}
              {activationTxUrl ? <div className="chain-proof-details"><div><span>TRANSACTION</span><a href={activationTxUrl} rel="noreferrer" target="_blank">{shorten(activationTxHash, 10, 8)} ↗</a></div></div> : null}
            </div>
          ) : null}

        </section>
      </section>
    </main>
  );
}

function ChallengeProof(props: { source: "X" | "FARCASTER"; account: string; text: string; composeUrl: string; onCopy: () => void }) {
  return (
    <section className="tweet-proof">
      <div><span>{props.source}</span><strong>{props.account}</strong></div>
      <pre>{props.text}</pre>
      <div className="tweet-actions"><button className="verify-secondary" type="button" onClick={props.onCopy}>COPY</button><a className="button button-small" href={props.composeUrl} rel="noreferrer" target="_blank">POST →</a></div>
    </section>
  );
}

function hydrateFields(request: VerificationRequest | null, setters: {
  setHandle(value: string): void;
  setPostUrl(value: string): void;
  setFarcasterUsername(value: string): void;
  setFarcasterCastUrl(value: string): void;
}) {
  if (request?.handle) setters.setHandle(request.handle);
  if (request?.normalizedVerificationPostUrl) setters.setPostUrl(request.normalizedVerificationPostUrl);
  if (request?.farcasterUsername) setters.setFarcasterUsername(request.farcasterUsername);
  const farcasterCastUrl = farcasterCastUrlForHash(request?.farcasterCastHash);
  if (farcasterCastUrl) setters.setFarcasterCastUrl(farcasterCastUrl);
}

function getProvider(): EthereumProvider {
  if (!window.ethereum) throw new Error("Install a StudioNet-compatible wallet.");
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

function statusStep(request: VerificationRequest | null, bundleActive: boolean, recovery: ActivationRecovery | null): number {
  if (recovery || bundleActive) return 4;
  if (!request || request.status === "WALLET_CHALLENGE_PENDING" || request.status === "EXPIRED") return 1;
  if (!request.walletAuthorizedAt) return 1;
  if (
    request.genlayerOutcome === "REJECTED"
    || (request.genlayerOutcome === "UNDETERMINED" && !request.genlayerRetryable)
    || (request.genlayerOutcome === "VERIFIED" && !hasBothChallenges(request))
  ) return 1;
  if (request.genlayerOutcome === "UNDETERMINED" && request.genlayerRetryable) return 3;
  if (request.activationTxHash || request.genlayerTxHash) return 4;
  return hasBothChallenges(request) ? 3 : 2;
}

function hasBothChallenges(request: VerificationRequest | null): boolean {
  return Boolean(request?.identityBundleReady || (request?.tweetText && request.farcasterCastText));
}

function activationNotice(stage: GenLayerTransactionStage): string {
  if (stage === "wallet") return "Confirm one transaction.";
  if (stage === "submitted") return "Transaction sent.";
  if (stage === "finality") return "Waiting for finality…";
  return "Finalized.";
}

function requireSelectedAccount(accounts: unknown, expected: string): void {
  const selected = firstAddress(accounts);
  if (!selected || selected.toLowerCase() !== expected.toLowerCase()) throw new Error(`Switch to ${shorten(expected)}.`);
}

function firstAddress(value: unknown): string | null {
  if (!Array.isArray(value) || typeof value[0] !== "string") return null;
  return /^0x[\da-f]{40}$/i.test(value[0]) ? value[0].toLowerCase() : null;
}

function normalizeXHandle(value: string): string {
  const normalized = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(normalized)) throw new Error("Enter a valid X handle.");
  return normalized;
}

function normalizeFarcasterUsername(value: string): string {
  const candidate = value.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,15}$/.test(candidate)) throw new Error("Enter a valid Farcaster username.");
  return candidate.toLowerCase();
}

function shorten(value: string | null, start = 7, end = 5): string {
  if (!value || value.length <= start + end + 1) return value ?? "—";
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function earliestExpiry(...values: Array<string | null | undefined>): string | null {
  const dates = values.flatMap((value) => {
    if (!value) return [];
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? [] : [time];
  });
  return dates.length ? new Date(Math.min(...dates)).toISOString() : null;
}

function epochLabel(value: string | null): string {
  if (!value) return "expiry";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "expiry";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function errorCode(body: ApiErrorBody): string | undefined {
  return body.code ?? (typeof body.error === "object" ? body.error.code : undefined);
}

function errorMessage(body: ApiErrorBody, status: number, fallback: string): string {
  const code = errorCode(body);
  const messages: Record<string, string> = {
    INVALID_VERIFICATION_POST_URL: "Paste the full public X post URL.",
    INVALID_X_POST_URL: "Paste the full public X post URL.",
    X_POST_NOT_FOUND: "Make the X post public, then retry.",
    X_PROOF_MISMATCH: "The X post must contain the exact challenge text.",
    INVALID_FARCASTER_CAST_URL: "Paste the full Farcaster cast URL.",
    FARCASTER_CAST_NOT_FOUND: "Make the Farcaster cast public, then retry.",
    FARCASTER_CAST_LOOKUP_UNAVAILABLE: "Farcaster is temporarily unavailable. Retry.",
    FARCASTER_PROOF_MISMATCH: "The cast must contain the exact challenge text.",
    CHALLENGE_EXPIRED: "Challenge expired. Start again.",
    SESSION_WALLET_MISMATCH: "Switch to the wallet used for this run.",
    WALLET_AUTHENTICATION_REQUIRED: "Reconnect and sign the wallet message.",
    INVALID_STATE: "Run changed. Refresh.",
    STATE_CHANGED: "Run changed. Refresh.",
    PREPARED_TRANSACTION_MISMATCH: "Saved transaction does not match this run. Start again.",
    ACTIVATION_OUTCOME_TERMINAL: "Start a new verification.",
    IDENTITY_BUNDLE_INCOMPLETE: "Create both challenges first.",
    ACTIVATION_ALREADY_PREPARED: "Use the same two posts and continue.",
    GENLAYER_TRANSACTION_UNAVAILABLE: "Still finalizing.",
    GENLAYER_FINALITY_PENDING: "Still finalizing.",
    GENLAYER_TRANSACTION_TERMINATED: "Transaction failed. Start again.",
    GENLAYER_EXECUTION_FAILED: "Transaction failed. Start again.",
    GENLAYER_TRANSACTION_MISMATCH: "Transaction mismatch. Start again.",
    VERIFICATION_TRANSACTION_PENDING: "Finish the transaction first.",
  };
  if (code && messages[code]) return messages[code];
  const serverMessage = typeof body.error === "string"
    ? body.error
    : typeof body.error?.message === "string"
      ? body.error.message
      : typeof body.message === "string"
        ? body.message
        : null;
  if (status >= 500) return "Verification is temporarily unavailable. Retry.";
  return serverMessage ?? fallback;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers }, cache: "no-store", credentials: "same-origin" });
  const body = (await response.json().catch(() => ({}))) as ApiErrorBody & T;
  if (shouldRejectVerificationResponse(response.status, body)) {
    const error = new Error(errorMessage(body, response.status, `Request failed (${response.status}).`));
    Object.assign(error, { status: response.status, code: errorCode(body) });
    throw error;
  }
  return body;
}

function readError(value: unknown, fallback: string): string {
  return value instanceof Error && value.message ? value.message : fallback;
}

function walletPromptRejected(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const error = value as { code?: unknown; message?: unknown; cause?: unknown };
  if (error.code === 4_001) return true;
  if (error.cause && walletPromptRejected(error.cause)) return true;
  return typeof error.message === "string"
    && /user (?:rejected|denied)|cancelled/i.test(error.message);
}

function requestBody(value: unknown): RequestInit { return { method: "POST", body: JSON.stringify(value) }; }

function sameRecovery(left: ActivationRecovery | null, right: ActivationRecovery | null): boolean {
  return Boolean(left && right
    && left.requestId === right.requestId
    && left.preparedId === right.preparedId
    && left.txHash.toLowerCase() === right.txHash.toLowerCase());
}

function loadRecovery(): ActivationRecovery | null {
  if (typeof window === "undefined") return null;
  try {
    return parseBoundIdentityBundleRecovery(
      JSON.parse(window.sessionStorage.getItem("influencedx:studionet-activation") ?? "null"),
    );
  } catch { return null; }
}

function saveRecovery(value: ActivationRecovery): void { window.sessionStorage.setItem("influencedx:studionet-activation", JSON.stringify(value)); }
function clearRecovery(): void { window.sessionStorage.removeItem("influencedx:studionet-activation"); }
