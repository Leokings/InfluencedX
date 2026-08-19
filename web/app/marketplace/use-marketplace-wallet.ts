"use client";

import { useCallback, useEffect, useState } from "react";
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

export function useMarketplaceWallet() {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [sessionWallet, setSessionWallet] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider) return;

    void Promise.all([
      provider.request({ method: "eth_accounts" }),
      provider.request({ method: "eth_chainId" }),
      marketplaceRequest<WalletSessionResponse>("/api/auth/wallet/session"),
    ]).then(([accounts, currentChainId, session]) => {
      const currentAddress = firstAddress(accounts);
      setAddress(currentAddress);
      if (typeof currentChainId === "string") setChainId(currentChainId.toLowerCase());
      setSessionWallet(session.authenticated ? session.wallet : null);
      setAuthenticated(Boolean(session.authenticated && currentAddress && session.wallet === currentAddress));
    }).catch(() => undefined);

    const accountsChanged = (...args: unknown[]) => {
      setAddress(firstAddress(args[0]));
      setAuthenticated(false);
    };
    const chainChanged = (...args: unknown[]) => {
      if (typeof args[0] === "string") setChainId(args[0].toLowerCase());
    };
    provider.on?.("accountsChanged", accountsChanged);
    provider.on?.("chainChanged", chainChanged);
    return () => {
      provider.removeListener?.("accountsChanged", accountsChanged);
      provider.removeListener?.("chainChanged", chainChanged);
    };
  }, []);

  const connect = useCallback(async () => {
    setWalletError(null);
    setConnecting(true);
    try {
      const provider = requireProvider();
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const selected = firstAddress(accounts);
      if (!selected) throw new Error("The wallet did not return an account.");
      setAddress(selected);
      const currentChainId = await provider.request({ method: "eth_chainId" });
      if (typeof currentChainId === "string") setChainId(currentChainId.toLowerCase());
      return selected;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The wallet connection was declined.";
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
        if (!wallet) throw new Error("The wallet did not return an account.");
        setAddress(wallet);
      }
      const challenge = await marketplaceRequest<WalletChallengeResponse>("/api/auth/wallet/challenge", {
        method: "POST",
        body: JSON.stringify({ wallet }),
      });
      if (challenge.authenticated) {
        setSessionWallet(wallet);
        setAuthenticated(true);
        return wallet;
      }
      if (!challenge.message) throw new Error("The wallet sign-in challenge was empty.");
      const signature = await provider.request({
        method: "personal_sign",
        params: [messageToHex(challenge.message), wallet],
      });
      if (typeof signature !== "string") throw new Error("The wallet did not return a signature.");
      const session = await marketplaceRequest<WalletSessionResponse>("/api/auth/wallet/authorize", {
        method: "POST",
        body: JSON.stringify({ wallet, signature }),
      });
      if (!session.authenticated || session.wallet !== wallet) {
        throw new Error("The wallet session could not be authenticated.");
      }
      setSessionWallet(session.wallet);
      setAuthenticated(true);
      return wallet;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wallet authorization failed.";
      setWalletError(message);
      setAuthenticated(false);
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
      setAuthenticated(false);
      setAddress(null);
      setChainId(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wallet sign-out failed.";
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
    hasSession: sessionWallet !== null,
    sessionWallet,
    walletError,
    isStudioNet: chainId === STUDIONET_CHAIN_ID_HEX,
    connect,
    authenticate,
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
    throw new Error("No browser wallet found. Install a wallet that supports GenLayer StudioNet and try again.");
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
