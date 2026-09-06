"use client";

import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { marketplaceRequest } from "./marketplace-api";
import {
  STUDIONET_CHAIN_ID_HEX,
  STUDIONET_EXPLORER_URL,
  STUDIONET_RPC_URL,
} from "./marketplace-types";

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

type MarketplaceWalletContextValue = ReturnType<typeof useMarketplaceWalletState>;

const MarketplaceWalletContext = createContext<MarketplaceWalletContextValue | null>(null);
const WALLET_SESSION_SYNC_KEY = "influencedx:wallet-session:v1";

type SignOutOptions = { verificationRequest?: { id: string; revision: number } };

export function MarketplaceWalletProvider({ children }: { children: ReactNode }) {
  const wallet = useMarketplaceWalletState();
  return createElement(MarketplaceWalletContext.Provider, { value: wallet }, children);
}

export function useMarketplaceWallet(): MarketplaceWalletContextValue {
  const wallet = useContext(MarketplaceWalletContext);
  if (!wallet) throw new Error("MarketplaceWalletProvider is missing.");
  return wallet;
}

function useMarketplaceWalletState() {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [sessionWallet, setSessionWallet] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [walletNotice, setWalletNotice] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectVersion, setDisconnectVersion] = useState(0);
  const lifecycle = useRef(0);
  const sessionRead = useRef(0);
  const disconnectPending = useRef(false);
  const disconnected = useRef(false);
  const currentSessionWallet = useRef<string | null>(null);
  const currentAddress = useRef<string | null>(null);

  const authenticated = Boolean(
    address && sessionWallet && address === sessionWallet,
  );

  const updateAddress = useCallback((next: string | null) => {
    if (currentAddress.current && currentAddress.current !== next) {
      setDisconnectVersion((version) => version + 1);
    }
    currentAddress.current = next;
    setAddress(next);
  }, []);

  const clearSession = useCallback(() => {
    lifecycle.current += 1;
    sessionRead.current += 1;
    currentSessionWallet.current = null;
    currentAddress.current = null;
    disconnected.current = true;
    setSessionWallet(null);
    setAddress(null);
    setChainId(null);
    setRestoring(false);
    setDisconnectVersion((version) => version + 1);
  }, []);

  const refreshSession = useCallback(async () => {
    const version = lifecycle.current;
    const sequence = ++sessionRead.current;
    try {
      const session = await marketplaceRequest<WalletSessionResponse>("/api/auth/wallet/session");
      if (version !== lifecycle.current || sequence !== sessionRead.current || disconnectPending.current || disconnected.current) return session;
      const next = session.authenticated ? session.wallet : null;
      if (currentSessionWallet.current && currentSessionWallet.current !== next) {
        setDisconnectVersion((value) => value + 1);
      }
      currentSessionWallet.current = next;
      setSessionWallet(next);
      return session;
    } finally {
      if (version === lifecycle.current && sequence === sessionRead.current) setRestoring(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let subscribedProvider: EthereumProvider | null = null;
    try {
      disconnected.current = window.localStorage.getItem(WALLET_SESSION_SYNC_KEY)?.startsWith("disconnected:") ?? false;
    } catch {
      // Session cookies still work when browser storage is unavailable.
    }

    const accountsChanged = (...args: unknown[]) => {
      if (!disconnectPending.current && !disconnected.current) updateAddress(firstAddress(args[0]));
    };
    const chainChanged = (...args: unknown[]) => {
      if (!disconnectPending.current && !disconnected.current && typeof args[0] === "string") setChainId(args[0].toLowerCase());
    };

    const hydrateProvider = async () => {
      const provider = window.ethereum;
      if (!provider || !active) return;
      if (provider !== subscribedProvider) {
        subscribedProvider?.removeListener?.("accountsChanged", accountsChanged);
        subscribedProvider?.removeListener?.("chainChanged", chainChanged);
        subscribedProvider = provider;
        provider.on?.("accountsChanged", accountsChanged);
        provider.on?.("chainChanged", chainChanged);
      }
      if (disconnectPending.current || disconnected.current) return;
      const version = lifecycle.current;
      const [accounts, currentChainId] = await Promise.allSettled([
        provider.request({ method: "eth_accounts" }),
        provider.request({ method: "eth_chainId" }),
      ]);
      if (!active || version !== lifecycle.current || disconnectPending.current || disconnected.current) return;
      if (accounts.status === "fulfilled") updateAddress(firstAddress(accounts.value));
      if (currentChainId.status === "fulfilled" && typeof currentChainId.value === "string") {
        setChainId(currentChainId.value.toLowerCase());
      }
    };

    const resume = () => {
      if (disconnectPending.current || disconnected.current) return;
      void refreshSession().catch(() => undefined);
      void hydrateProvider();
    };

    const synchronize = (event: StorageEvent) => {
      if (event.key !== WALLET_SESSION_SYNC_KEY) return;
      if (event.newValue?.startsWith("disconnected:")) {
        clearSession();
        setWalletNotice("Wallet disconnected.");
      } else if (event.newValue?.startsWith("authenticated:")) {
        disconnected.current = false;
        resume();
      }
    };

    void refreshSession().catch(() => undefined);
    void hydrateProvider();
    window.addEventListener("ethereum#initialized", hydrateProvider, { once: true });
    window.addEventListener("focus", resume);
    window.addEventListener("storage", synchronize);
    const providerRetry = window.setTimeout(() => void hydrateProvider(), 500);

    return () => {
      active = false;
      window.clearTimeout(providerRetry);
      window.removeEventListener("ethereum#initialized", hydrateProvider);
      window.removeEventListener("focus", resume);
      window.removeEventListener("storage", synchronize);
      subscribedProvider?.removeListener?.("accountsChanged", accountsChanged);
      subscribedProvider?.removeListener?.("chainChanged", chainChanged);
    };
  }, [clearSession, refreshSession, updateAddress]);

  const connect = useCallback(async () => {
    setWalletError(null);
    setWalletNotice(null);
    setConnecting(true);
    try {
      if (disconnectPending.current) throw new Error("Wait for the wallet to disconnect.");
      const version = lifecycle.current;
      const provider = requireProvider();
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const selected = firstAddress(accounts);
      if (!selected) throw new Error("No wallet selected.");
      if (version !== lifecycle.current) throw new Error("Wallet session changed. Connect again.");
      disconnected.current = false;
      updateAddress(selected);
      const currentChainId = await provider.request({ method: "eth_chainId" });
      if (version === lifecycle.current && typeof currentChainId === "string") setChainId(currentChainId.toLowerCase());
      return selected;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wallet connection failed.";
      setWalletError(message);
      throw error;
    } finally {
      setConnecting(false);
    }
  }, [updateAddress]);

  const authenticate = useCallback(async () => {
    setWalletError(null);
    setWalletNotice(null);
    setAuthenticating(true);
    try {
      if (disconnectPending.current) throw new Error("Wait for the wallet to disconnect.");
      const version = lifecycle.current;
      const provider = requireProvider();
      let wallet = disconnected.current ? null : firstAddress(await provider.request({ method: "eth_accounts" }));
      if (!wallet) {
        const accounts = await provider.request({ method: "eth_requestAccounts" });
        wallet = firstAddress(accounts);
        if (!wallet) throw new Error("No wallet selected.");
      }
      if (version !== lifecycle.current) throw new Error("Wallet session changed. Connect again.");
      disconnected.current = false;
      updateAddress(wallet);
      const currentChainId = await provider.request({ method: "eth_chainId" });
      if (version !== lifecycle.current) throw new Error("Wallet session changed. Connect again.");
      if (typeof currentChainId === "string") setChainId(currentChainId.toLowerCase());
      const challenge = await marketplaceRequest<WalletChallengeResponse>("/api/auth/wallet/challenge", {
        method: "POST",
        body: JSON.stringify({ wallet }),
      });
      if (challenge.authenticated) {
        if (version !== lifecycle.current) throw new Error("Wallet session changed. Connect again.");
        sessionRead.current += 1;
        currentSessionWallet.current = wallet;
        setSessionWallet(wallet);
        setRestoring(false);
        publishSessionChange("authenticated");
        return wallet;
      }
      if (!challenge.message) throw new Error("Could not start wallet sign-in.");
      if (version !== lifecycle.current) throw new Error("Wallet session changed. Connect again.");
      const signature = await provider.request({
        method: "personal_sign",
        params: [messageToHex(challenge.message), wallet],
      });
      if (typeof signature !== "string") throw new Error("No signature returned.");
      if (version !== lifecycle.current) throw new Error("Wallet session changed. Connect again.");
      const session = await marketplaceRequest<WalletSessionResponse>("/api/auth/wallet/authorize", {
        method: "POST",
        body: JSON.stringify({ wallet, signature }),
      });
      if (!session.authenticated || session.wallet !== wallet) {
        throw new Error("Wallet sign-in failed.");
      }
      if (version !== lifecycle.current) throw new Error("Wallet session changed. Connect again.");
      sessionRead.current += 1;
      currentSessionWallet.current = session.wallet;
      setSessionWallet(session.wallet);
      setRestoring(false);
      publishSessionChange("authenticated");
      return wallet;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wallet sign-in failed.";
      setWalletError(message);
      throw error;
    } finally {
      setAuthenticating(false);
    }
  }, [updateAddress]);

  const switchToStudioNet = useCallback(async () => {
    const provider = requireProvider();
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: STUDIONET_CHAIN_ID_HEX }],
      });
    } catch (error) {
      if (!isMissingChainError(error)) throw error;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: STUDIONET_CHAIN_ID_HEX,
          chainName: "GenLayer StudioNet",
          nativeCurrency: { name: "GEN Token", symbol: "GEN", decimals: 18 },
          rpcUrls: [STUDIONET_RPC_URL],
          blockExplorerUrls: [STUDIONET_EXPLORER_URL],
        }],
      });
    }
    setChainId(STUDIONET_CHAIN_ID_HEX);
  }, []);

  const signOut = useCallback(async (options: SignOutOptions = {}) => {
    if (disconnectPending.current) return;
    disconnectPending.current = true;
    lifecycle.current += 1;
    setDisconnecting(true);
    setWalletError(null);
    setWalletNotice(null);
    try {
      const verification = options.verificationRequest;
      await marketplaceRequest<WalletSessionResponse>(
        verification ? "/api/verification/session" : "/api/auth/wallet/session",
        {
          method: "DELETE",
          ...(verification ? { body: JSON.stringify({ requestId: verification.id, revision: verification.revision }) } : {}),
        },
      );
      clearSession();
      publishSessionChange("disconnected");
      try {
        await window.ethereum?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
        setWalletNotice("Wallet disconnected.");
      } catch {
        setWalletNotice("Signed out. Choose another account in your wallet to switch.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sign-out failed.";
      setWalletError(message);
      throw error;
    } finally {
      disconnectPending.current = false;
      setDisconnecting(false);
    }
  }, [clearSession]);

  return {
    address,
    chainId,
    connecting,
    authenticating,
    authenticated,
    restoring,
    disconnecting,
    disconnectVersion,
    hasSession: sessionWallet !== null,
    sessionWallet,
    walletError,
    walletNotice,
    isStudioNet: chainId === STUDIONET_CHAIN_ID_HEX,
    connect,
    authenticate,
    refreshSession,
    signOut,
    switchToStudioNet,
  };
}

function publishSessionChange(state: "authenticated" | "disconnected") {
  try {
    window.localStorage.setItem(WALLET_SESSION_SYNC_KEY, `${state}:${crypto.randomUUID()}`);
  } catch {
    // Storage events are an enhancement; the signed cookie is authoritative.
  }
}

type WalletSessionResponse = {
  authenticated: boolean;
  wallet: string | null;
  expiresAt: string | null;
};

type WalletChallengeResponse = {
  authenticated: boolean;
  wallet: string;
  message: string | null;
  expiresAt: string;
};

function requireProvider(): EthereumProvider {
  if (!window.ethereum) {
    throw new Error("Open in a wallet browser or install a StudioNet wallet.");
  }
  return window.ethereum;
}

function firstAddress(value: unknown): string | null {
  if (!Array.isArray(value) || typeof value[0] !== "string") return null;
  const normalized = value[0].toLowerCase();
  return /^0x[\da-f]{40}$/.test(normalized) ? normalized : null;
}

function messageToHex(message: string): `0x${string}` {
  return `0x${Array.from(new TextEncoder().encode(message), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function isMissingChainError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? Number(error.code) : NaN;
  return code === 4_902;
}
