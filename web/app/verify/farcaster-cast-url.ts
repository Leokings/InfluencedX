const FARCASTER_CAST_HASH = /^0x[0-9a-f]{40}$/i;

export function farcasterCastUrlForHash(value: string | null | undefined): string | null {
  const hash = value?.trim();
  if (!hash || !FARCASTER_CAST_HASH.test(hash)) return null;
  return `https://farcaster.xyz/~/conversations/${hash.toLowerCase()}`;
}
