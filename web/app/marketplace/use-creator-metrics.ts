"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  MarketplaceCreatorProfileDto,
  MarketplaceMetricsDto,
} from "@/lib/marketplace-types";
import {
  MarketplaceApiError,
  marketplaceRequest,
} from "./marketplace-api.ts";

export const MAX_CREATOR_METRICS_CONCURRENCY = 4;

const CURRENT_CACHE_MS = 60_000;
const UNAVAILABLE_CACHE_MS = 30_000;
const ERROR_CACHE_MS = 5_000;
const MAX_CACHE_ENTRIES = 100;

export type CreatorMetricsLookup =
  | { phase: "loading"; metrics: null }
  | { phase: "current"; metrics: MarketplaceMetricsDto }
  | { phase: "expired"; metrics: null }
  | { phase: "unavailable"; metrics: null }
  | { phase: "error"; metrics: null };

type CachedLookup = {
  lookup: CreatorMetricsLookup;
  staleAt: number;
};

const lookupCache = new Map<string, CachedLookup>();
const inFlightLookups = new Map<string, Promise<CreatorMetricsLookup>>();
const loadingLookup: CreatorMetricsLookup = { phase: "loading", metrics: null };

export function normalizeCreatorMetricWallets(wallets: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const wallet of wallets) {
    const candidate = wallet.trim().toLowerCase();
    if (/^0x[\da-f]{40}$/.test(candidate)) normalized.add(candidate);
  }
  return [...normalized].sort();
}

export function classifyCreatorMetrics(
  metrics: MarketplaceMetricsDto | null,
  nowMs: number,
): CreatorMetricsLookup {
  if (!metrics) return { phase: "unavailable", metrics: null };
  const expiresAt = new Date(metrics.expiresAt).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    return { phase: "expired", metrics: null };
  }
  return { phase: "current", metrics };
}

export function useCreatorMetrics(
  wallets: readonly string[],
): Readonly<Record<string, CreatorMetricsLookup>> {
  const walletKey = normalizeCreatorMetricWallets(wallets).join("|");
  const normalizedWallets = useMemo(
    () => (walletKey ? walletKey.split("|") : []),
    [walletKey],
  );
  const [result, setResult] = useState<{
    walletKey: string;
    lookups: Record<string, CreatorMetricsLookup>;
  }>({ walletKey: "", lookups: {} });

  useEffect(() => {
    let active = true;
    if (normalizedWallets.length === 0) return undefined;

    void loadCreatorMetricsBatch(normalizedWallets).then((entries) => {
      if (active) {
        setResult({ walletKey, lookups: Object.fromEntries(entries) });
      }
    });

    return () => {
      active = false;
    };
  }, [normalizedWallets, walletKey]);

  if (!walletKey) return {};
  if (result.walletKey === walletKey) return result.lookups;
  return Object.fromEntries(normalizedWallets.map((wallet) => [wallet, loadingLookup]));
}

export function creatorMetricsForWallet(
  lookups: Readonly<Record<string, CreatorMetricsLookup>>,
  wallet: string | null | undefined,
): CreatorMetricsLookup {
  if (!wallet) return { phase: "unavailable", metrics: null };
  return lookups[wallet.toLowerCase()] ?? loadingLookup;
}

async function loadCreatorMetricsBatch(
  wallets: readonly string[],
): Promise<Array<readonly [string, CreatorMetricsLookup]>> {
  const results = new Array<readonly [string, CreatorMetricsLookup]>(wallets.length);
  let cursor = 0;
  const workerCount = Math.min(MAX_CREATOR_METRICS_CONCURRENCY, wallets.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < wallets.length) {
      const index = cursor;
      cursor += 1;
      const wallet = wallets[index];
      results[index] = [wallet, await loadCreatorMetrics(wallet)] as const;
    }
  }));

  return results;
}

async function loadCreatorMetrics(wallet: string): Promise<CreatorMetricsLookup> {
  const nowMs = Date.now();
  const cached = lookupCache.get(wallet);
  if (cached && cached.staleAt > nowMs) return cached.lookup;

  const activeRequest = inFlightLookups.get(wallet);
  if (activeRequest) return activeRequest;

  const request = marketplaceRequest<{ creator: MarketplaceCreatorProfileDto }>(
    `/api/marketplace/creators/${encodeURIComponent(wallet)}`,
  ).then(({ creator }) => {
    const lookup = classifyCreatorMetrics(creator.metrics, Date.now());
    const metricsExpiry = lookup.phase === "current"
      ? new Date(lookup.metrics.expiresAt).getTime()
      : Number.POSITIVE_INFINITY;
    rememberLookup(wallet, lookup, Math.min(Date.now() + cacheDuration(lookup), metricsExpiry));
    return lookup;
  }).catch((error: unknown) => {
    const lookup: CreatorMetricsLookup = error instanceof MarketplaceApiError && error.status === 404
      ? { phase: "unavailable", metrics: null }
      : { phase: "error", metrics: null };
    rememberLookup(wallet, lookup, Date.now() + cacheDuration(lookup));
    return lookup;
  }).finally(() => {
    inFlightLookups.delete(wallet);
  });

  inFlightLookups.set(wallet, request);
  return request;
}

function cacheDuration(lookup: CreatorMetricsLookup): number {
  if (lookup.phase === "current") return CURRENT_CACHE_MS;
  if (lookup.phase === "error") return ERROR_CACHE_MS;
  return UNAVAILABLE_CACHE_MS;
}

function rememberLookup(wallet: string, lookup: CreatorMetricsLookup, staleAt: number): void {
  lookupCache.delete(wallet);
  lookupCache.set(wallet, { lookup, staleAt });
  while (lookupCache.size > MAX_CACHE_ENTRIES) {
    const oldest = lookupCache.keys().next().value as string | undefined;
    if (!oldest) break;
    lookupCache.delete(oldest);
  }
}
