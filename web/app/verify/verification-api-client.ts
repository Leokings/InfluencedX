export function shouldRejectVerificationResponse(status: number, body: unknown): boolean {
  if (status < 200 || status >= 300) return true;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return Object.prototype.hasOwnProperty.call(body, "error")
    && (body as { error?: unknown }).error !== undefined;
}
