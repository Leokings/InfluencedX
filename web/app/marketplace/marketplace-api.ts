type ApiErrorBody = {
  error?: string | { code?: string; message?: string };
  code?: string;
  message?: string;
};

export class MarketplaceApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "MarketplaceApiError";
    this.status = status;
    this.code = code;
  }
}

export async function marketplaceRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const body = await readJson(response);
  if (!response.ok) {
    const error = body as ApiErrorBody | null;
    const nested = error && typeof error.error === "object" ? error.error : null;
    const message = nested?.message
      ?? (typeof error?.error === "string" ? error.error : null)
      ?? error?.message
      ?? `Marketplace request failed (${response.status}).`;
    const code = nested?.code ?? error?.code ?? null;
    throw new MarketplaceApiError(response.status, message, code);
  }
  return body as T;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MarketplaceApiError(response.status, "Invalid marketplace response.");
  }
}

export function marketplaceErrorMessage(error: unknown): string {
  if (error instanceof MarketplaceApiError) {
    if (error.status === 401) {
      return "Sign in with your wallet.";
    }
    if (error.status === 409 && error.code === "SESSION_WALLET_MISMATCH") {
      return "Wallet changed. Sign out and reconnect.";
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "Marketplace action failed.";
}
