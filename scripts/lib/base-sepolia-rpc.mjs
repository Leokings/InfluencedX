import { fallback, http } from 'viem';

export const BASE_SEPOLIA_PUBLIC_RPC_URL = 'https://sepolia.base.org';
export const BASE_SEPOLIA_FALLBACK_RPC_URL = 'https://base-sepolia-rpc.publicnode.com';

export function baseSepoliaRpcUrls(configuredUrl) {
  const candidates = [
    configuredUrl?.trim(),
    BASE_SEPOLIA_PUBLIC_RPC_URL,
    BASE_SEPOLIA_FALLBACK_RPC_URL,
  ].filter(Boolean);
  return [...new Set(candidates)];
}

export function createBaseSepoliaFallbackTransport({
  configuredUrl,
  timeout = 20_000,
} = {}) {
  const transports = baseSepoliaRpcUrls(configuredUrl).map((url) => http(url, {
    timeout,
    retryCount: 0,
  }));
  return fallback(transports, { rank: false, retryCount: 0 });
}

export function safeCutoverErrorMessage(error) {
  const shortMessage = typeof error?.shortMessage === 'string' ? error.shortMessage : '';
  const message = error instanceof Error ? error.message : '';
  const firstLine = (shortMessage || message).split(/\r?\n/, 1)[0].trim();

  if (
    error?.name !== 'Error'
    || /request|rpc|http|timeout|network|backend|limit/i.test(firstLine)
  ) {
    return 'A Base Sepolia RPC endpoint rejected or could not serve the request. '
      + 'The next run will reconcile on-chain state before any mutation.';
  }

  if (firstLine && firstLine.length <= 240) return firstLine;
  return 'The cutover did not complete. The next run will reconcile on-chain state before any mutation.';
}
