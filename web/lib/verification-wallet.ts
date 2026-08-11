export function selectVerificationWallet(
  requestWallet: string | null | undefined,
  connectedWallet: string | null | undefined,
): string | null {
  return requestWallet ?? connectedWallet ?? null;
}
