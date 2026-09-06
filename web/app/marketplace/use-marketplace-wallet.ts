"use client";

import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
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
  const [restoring, setRestoring] = useState(true);

  const authenticated = Boolean(
    address && sessionWallet && address === sessionWallet,
  );

  const refreshSession = useCallback(async () => {
    try {
      const session = await marketplaceRequest<WalletSessionResponse>("/api/auth/wallet/session");
      setSessionWallet(session.authenticated ? session.wallet : null);
      return session;
    } finally {
      setRestoring(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let subscribedProvider: EthereumProvider | null = null;

    const accountsChanged = (...args: unknown[]) => {
      setAddress(firstAddress(args[0]));
    };
    const chainChanged = (...args: unknown[]) => {
      if (typeof args[0] === "string") setChainId(args[0].toLowerCase());
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
      const [accounts, currentChainId] = await Promise.allSettled([
        provider.request({ method: "eth_accounts" }),
        provider.request({ method: "eth_chainId" }),
      ]);
      if (!active) return;
      if (accounts.status === "fulfilled") setAddress(firstAddress(accounts.value));
      if (currentChainId.status === "fulfilled" && typeof currentChainId.value === "string") {
        setChainId(currentChainId.value.toLowerCase());
      }
    };

    const resume = () => {
      void refreshSession().catch(() => undefined);
      void hydrateProvider();
    };

    void refreshSession().catch(() => undefined);
    void hydrateProvider();
    window.addEventListener("ethereum#initialized", hydrateProvider, { once: true });
    window.addEventListener("focus", resume);
    const providerRetry = window.setTimeout(() => void hydrateProvider(), 500);

    return () => {
      active = false;
      window.clearTimeout(providerRetry);
      window.removeEventListener("ethereum#initialized", hydrateProvider);
      window.removeEventListener("focus", resume);
      subscribedProvider?.removeListener?.("accountsChanged", accountsChanged);
      subscribedProvider?.removeListener?.("chainChanged", chainChanged);
    };
  }, [refreshSession]);

  const connect = useCallback(async () => {
    setWalletError(null);
    setConnecting(true);
    try {
      const provider = requireProvider();
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const selected = firstAddress(accounts);
      if (!selected) throw new Error("No wallet selected.");
      setAddress(selected);
      const currentChainId = await provider.request({ method: "eth_chainId" });
      if (typeof currentChainId === "string") setChainId(currentChainId.toLowerCase());
      return selected;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wallet connection failed.";
      setWalletError(message);
      throw error;
    } finally {
      setConnecting(false);
    }
  }, []);

  const authenticate = useCallback(async () => {
    setWalletError(null);
    setAuthenticating(true);
    try {
      const provider = requireProvider();
      let wallet = address;
      if (!wallet) {
        const accounts = await provider.request({ method: "eth_requestAccounts" });
        wallet = firstAddress(accounts);
        if (!wallet) throw new Error("No wallet selected.");
        setAddress(wallet);
      }
      const challenge = await marketplaceRequest<WalletChallengeResponse>("/api/auth/wallet/challenge", {
        method: "POST",
        body: JSON.stringify({ wallet }),
      });
      if (challenge.authenticated) {
        setSessionWallet(wallet);
        return wallet;
      }
      if (!challenge.message) throw new Error("Could not start wallet sign-in.");
      const signature = await provider.request({
        method: "personal_sign",
        params: [messageToHex(challenge.message), wallet],
      });
      if (typeof signature !== "string") throw new Error("No signature returned.");
      const session = await marketplaceRequest<WalletSessionResponse>("/api/auth/wallet/authorize", {
        method: "POST",
        body: JSON.stringify({ wallet, signature }),
      });
      if (!session.authenticated || session.wallet !== wallet) {
        throw new Error("Wallet sign-in failed.");
      }
      setSessionWallet(session.wallet);
      return wallet;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wallet sign-in failed.";
      setWalletError(message);
      throw error;
    } finally {
      setAuthenticating(false);
    }
  }, [address]);

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

  const signOut = useCallback(async () => {
    setWalletError(null);
    try {
      await marketplaceRequest<WalletSessionResponse>("/api/auth/wallet/session", { method: "DELETE" });
      setSessionWallet(null);
      setAddress(null);
      setChainId(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sign-out failed.";
      setWalletError(message);
      throw error;
    }
  }, []);

  return {
    address,
    chainId,
    connecting,
    authenticating,
    authenticated,
    restoring,
    hasSession: sessionWallet !== null,
    sessionWallet,
    walletError,
    isStudioNet: chainId === STUDIONET_CHAIN_ID_HEX,
    connect,
    authenticate,
    refreshSession,
    signOut,
    switchToStudioNet,
  };
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
