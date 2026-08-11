import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const PENDING_SESSION_TTL_SECONDS = 15 * 60;
export const AUTHENTICATED_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const SESSION_VERSION = 1;
const DEVELOPMENT_COOKIE_NAME = "xproof_session";
const PRODUCTION_COOKIE_NAME = "__Host-xproof_session";
const SUBJECT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const WALLET_PATTERN = /^0x[0-9a-f]{40}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 4_096;
const SESSION_KEYS = [
  "expiresAt",
  "issuedAt",
  "stage",
  "subject",
  "version",
  "wallet",
] as const;

export type PendingWalletSession = {
  version: typeof SESSION_VERSION;
  subject: string;
  stage: "pending";
  wallet: null;
  issuedAt: number;
  expiresAt: number;
};

export type AuthenticatedWalletSession = {
  version: typeof SESSION_VERSION;
  subject: string;
  stage: "authenticated";
  wallet: string;
  issuedAt: number;
  expiresAt: number;
};

export type WalletSession =
  | PendingWalletSession
  | AuthenticatedWalletSession;

export type WalletSessionOptions = {
  nowMs?: number;
  production?: boolean;
  secret?: string;
};

export function createPendingWalletSession(
  options: WalletSessionOptions = {},
): PendingWalletSession {
  requireSessionSecret(options.secret);
  const issuedAt = nowSeconds(options.nowMs);
  return {
    version: SESSION_VERSION,
    subject: randomBytes(32).toString("base64url"),
    stage: "pending",
    wallet: null,
    issuedAt,
    expiresAt: issuedAt + PENDING_SESSION_TTL_SECONDS,
  };
}

export function authenticateWalletSession(
  session: WalletSession,
  wallet: unknown,
  options: WalletSessionOptions = {},
): AuthenticatedWalletSession {
  requireSessionSecret(options.secret);
  const normalizedWallet = normalizeSessionWallet(wallet);
  if (
    session.stage === "authenticated" &&
    session.wallet !== normalizedWallet
  ) {
    throw new Error("The authenticated session is bound to another wallet.");
  }

  const issuedAt = nowSeconds(options.nowMs);
  return {
    version: SESSION_VERSION,
    subject: session.subject,
    stage: "authenticated",
    wallet: normalizedWallet,
    issuedAt,
    expiresAt: issuedAt + AUTHENTICATED_SESSION_TTL_SECONDS,
  };
}

export function readWalletSession(
  request: Request,
  options: WalletSessionOptions = {},
): WalletSession | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;

  const cookieName = walletSessionCookieName(options.production);
  const values = cookieValues(cookieHeader, cookieName);
  if (values.length !== 1) return null;

  return verifySessionToken(
    values[0],
    requireSessionSecret(options.secret),
    nowSeconds(options.nowMs),
  );
}

export function attachWalletSessionCookie(
  response: Response,
  session: WalletSession,
  options: WalletSessionOptions = {},
): Response {
  const now = nowSeconds(options.nowMs);
  if (session.expiresAt <= now) {
    throw new Error("Cannot attach an expired wallet session.");
  }

  const production = isProduction(options.production);
  const token = signSessionToken(session, requireSessionSecret(options.secret));
  const attributes = [
    `${walletSessionCookieName(production)}=${token}`,
    `Max-Age=${session.expiresAt - now}`,
    `Expires=${new Date(session.expiresAt * 1_000).toUTCString()}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Priority=High",
  ];
  if (production) attributes.push("Secure");
  response.headers.append("Set-Cookie", attributes.join("; "));
  return response;
}

export function clearWalletSessionCookies(response: Response): Response {
  const expires = "Thu, 01 Jan 1970 00:00:00 GMT";
  response.headers.append(
    "Set-Cookie",
    `${DEVELOPMENT_COOKIE_NAME}=; Max-Age=0; Expires=${expires}; Path=/; HttpOnly; SameSite=Strict; Priority=High`,
  );
  response.headers.append(
    "Set-Cookie",
    `${PRODUCTION_COOKIE_NAME}=; Max-Age=0; Expires=${expires}; Path=/; HttpOnly; SameSite=Strict; Priority=High; Secure`,
  );
  return response;
}

export function walletSessionCookieName(production?: boolean): string {
  return isProduction(production)
    ? PRODUCTION_COOKIE_NAME
    : DEVELOPMENT_COOKIE_NAME;
}

export function isAuthenticatedWalletSession(
  session: WalletSession,
): session is AuthenticatedWalletSession {
  return session.stage === "authenticated";
}

export function walletSessionMatches(
  session: AuthenticatedWalletSession,
  wallet: unknown,
): boolean {
  try {
    return session.wallet === normalizeSessionWallet(wallet);
  } catch {
    return false;
  }
}

export function normalizeSessionWallet(wallet: unknown): string {
  if (typeof wallet !== "string") {
    throw new Error("A valid EVM wallet address is required.");
  }
  const normalized = wallet.trim().toLowerCase();
  if (!WALLET_PATTERN.test(normalized)) {
    throw new Error("A valid EVM wallet address is required.");
  }
  return normalized;
}

function signSessionToken(session: WalletSession, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret)
    .update(encodedPayload, "ascii")
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function verifySessionToken(
  token: string,
  secret: string,
  now: number,
): WalletSession | null {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, encodedSignature] = parts;
  if (
    !isCanonicalBase64Url(encodedPayload) ||
    !isCanonicalBase64Url(encodedSignature)
  ) {
    return null;
  }

  const providedSignature = Buffer.from(encodedSignature, "base64url");
  const expectedSignature = createHmac("sha256", secret)
    .update(encodedPayload, "ascii")
    .digest();
  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    return null;
  }

  let value: unknown;
  try {
    const bytes = Buffer.from(encodedPayload, "base64url");
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(json);
  } catch {
    return null;
  }
  return parseSessionPayload(value, now);
}

function parseSessionPayload(value: unknown, now: number): WalletSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload).sort();
  if (
    keys.length !== SESSION_KEYS.length ||
    keys.some((key, index) => key !== [...SESSION_KEYS].sort()[index])
  ) {
    return null;
  }
  if (
    payload.version !== SESSION_VERSION ||
    typeof payload.subject !== "string" ||
    !SUBJECT_PATTERN.test(payload.subject) ||
    !Number.isInteger(payload.issuedAt) ||
    !Number.isInteger(payload.expiresAt)
  ) {
    return null;
  }

  const issuedAt = payload.issuedAt as number;
  const expiresAt = payload.expiresAt as number;
  if (issuedAt > now + 60 || expiresAt <= now || expiresAt <= issuedAt) {
    return null;
  }

  if (
    payload.stage === "pending" &&
    payload.wallet === null &&
    expiresAt - issuedAt === PENDING_SESSION_TTL_SECONDS
  ) {
    return {
      version: SESSION_VERSION,
      subject: payload.subject,
      stage: "pending",
      wallet: null,
      issuedAt,
      expiresAt,
    };
  }

  if (
    payload.stage === "authenticated" &&
    typeof payload.wallet === "string" &&
    WALLET_PATTERN.test(payload.wallet) &&
    expiresAt - issuedAt === AUTHENTICATED_SESSION_TTL_SECONDS
  ) {
    return {
      version: SESSION_VERSION,
      subject: payload.subject,
      stage: "authenticated",
      wallet: payload.wallet,
      issuedAt,
      expiresAt,
    };
  }

  return null;
}

function cookieValues(header: string, name: string): string[] {
  const values: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const candidateName = part.slice(0, separator).trim();
    if (candidateName !== name) continue;
    values.push(part.slice(separator + 1).trim());
  }
  return values;
}

function isCanonicalBase64Url(value: string): boolean {
  if (!BASE64URL_PATTERN.test(value)) return false;
  try {
    return Buffer.from(value, "base64url").toString("base64url") === value;
  } catch {
    return false;
  }
}

function requireSessionSecret(override?: string): string {
  const secret = override ?? process.env.AUTH_SECRET;
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("AUTH_SECRET must contain at least 32 bytes.");
  }
  return secret;
}

function nowSeconds(nowMs?: number): number {
  const value = nowMs ?? Date.now();
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("The session clock is invalid.");
  }
  return Math.floor(value / 1_000);
}

function isProduction(override?: boolean): boolean {
  return override ?? process.env.NODE_ENV === "production";
}
