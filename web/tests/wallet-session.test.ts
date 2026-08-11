import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  AUTHENTICATED_SESSION_TTL_SECONDS,
  PENDING_SESSION_TTL_SECONDS,
  attachWalletSessionCookie,
  authenticateWalletSession,
  clearWalletSessionCookies,
  createPendingWalletSession,
  isAuthenticatedWalletSession,
  readWalletSession,
  walletSessionCookieName,
  walletSessionMatches,
} from "../lib/wallet-session.ts";

const SECRET = "wallet-session-test-secret-is-at-least-32-bytes";
const OTHER_SECRET = "another-wallet-session-secret-at-least-32-bytes";
const NOW_MS = 1_800_000_000_000;
const WALLET = "0x1234567890AbCdEf1234567890aBcdef12345678";
const OTHER_WALLET = "0x876543210fedcba9876543210fedcba987654321";

function sessionOptions(production = false) {
  return { secret: SECRET, nowMs: NOW_MS, production };
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  assert.ok(header, "expected a Set-Cookie header");
  return header.split(";", 1)[0];
}

function requestWithCookie(cookie: string, extraHeaders?: HeadersInit): Request {
  const headers = new Headers(extraHeaders);
  headers.set("cookie", cookie);
  return new Request("https://xproof.example/api/verification/status", {
    headers,
  });
}

function signedToken(payload: unknown, secret = SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret)
    .update(encoded, "ascii")
    .digest("base64url");
  return `${encoded}.${signature}`;
}

test("pending sessions use an opaque subject and a 15 minute expiry", () => {
  const session = createPendingWalletSession(sessionOptions());

  assert.equal(session.stage, "pending");
  assert.equal(session.wallet, null);
  assert.match(session.subject, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    session.expiresAt - session.issuedAt,
    PENDING_SESSION_TTL_SECONDS,
  );
});

test("development cookies are HttpOnly, Strict, host scoped, and readable", () => {
  const session = createPendingWalletSession(sessionOptions());
  const response = attachWalletSessionCookie(
    Response.json({ ok: true }),
    session,
    sessionOptions(),
  );
  const setCookie = response.headers.get("set-cookie") ?? "";

  assert.match(setCookie, /^xproof_session=/);
  assert.match(setCookie, /; Max-Age=900;/);
  assert.match(setCookie, /; Path=\//);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Strict/);
  assert.doesNotMatch(setCookie, /; Secure/);
  assert.doesNotMatch(setCookie, /; Domain=/i);

  const parsed = readWalletSession(
    requestWithCookie(cookieFrom(response)),
    sessionOptions(),
  );
  assert.deepEqual(parsed, session);
});

test("sign out expires both development and production session cookies", () => {
  const response = clearWalletSessionCookies(Response.json({ ok: true }));
  const setCookie = response.headers.get("set-cookie") ?? "";

  assert.match(setCookie, /xproof_session=; Max-Age=0;/);
  assert.match(setCookie, /__Host-xproof_session=; Max-Age=0;/);
  assert.match(setCookie, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /__Host-xproof_session=.*; Secure$/);
  assert.doesNotMatch(setCookie, /Domain=/i);
});

test("production cookies use the Secure __Host prefix without Domain", () => {
  const options = sessionOptions(true);
  const session = createPendingWalletSession(options);
  const response = attachWalletSessionCookie(
    Response.json({ ok: true }),
    session,
    options,
  );
  const setCookie = response.headers.get("set-cookie") ?? "";

  assert.equal(walletSessionCookieName(true), "__Host-xproof_session");
  assert.match(setCookie, /^__Host-xproof_session=/);
  assert.match(setCookie, /; Secure/);
  assert.match(setCookie, /; Path=\//);
  assert.doesNotMatch(setCookie, /; Domain=/i);
  assert.deepEqual(
    readWalletSession(requestWithCookie(cookieFrom(response)), options),
    session,
  );
});

test("wallet authentication retains the subject and rotates to 30 days", () => {
  const pending = createPendingWalletSession(sessionOptions());
  const authenticated = authenticateWalletSession(
    pending,
    WALLET,
    sessionOptions(),
  );

  assert.equal(authenticated.subject, pending.subject);
  assert.equal(authenticated.wallet, WALLET.toLowerCase());
  assert.ok(isAuthenticatedWalletSession(authenticated));
  assert.equal(
    authenticated.expiresAt - authenticated.issuedAt,
    AUTHENTICATED_SESSION_TTL_SECONDS,
  );
  assert.ok(walletSessionMatches(authenticated, WALLET));
  assert.ok(!walletSessionMatches(authenticated, OTHER_WALLET));
});

test("an authenticated session cannot be rebound to another wallet", () => {
  const authenticated = authenticateWalletSession(
    createPendingWalletSession(sessionOptions()),
    WALLET,
    sessionOptions(),
  );

  assert.throws(
    () => authenticateWalletSession(authenticated, OTHER_WALLET, sessionOptions()),
    /bound to another wallet/,
  );
});

test("legacy identity headers cannot spoof a wallet session", () => {
  const spoofed = new Request(
    "https://xproof.example/api/verification/status",
    {
      headers: {
        "oai-authenticated-user-id": "attacker-controlled-user",
        "oai-authenticated-user-email": "attacker@example.com",
      },
    },
  );

  assert.equal(readWalletSession(spoofed, sessionOptions()), null);
});

test("tampered payloads and signatures fail closed", () => {
  const session = createPendingWalletSession(sessionOptions());
  const response = attachWalletSessionCookie(
    new Response(null),
    session,
    sessionOptions(),
  );
  const [name, token] = cookieFrom(response).split("=");
  const [payload, signature] = token.split(".");
  const changedPayload = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;
  const changedSignature = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;

  assert.equal(
    readWalletSession(
      requestWithCookie(`${name}=${changedPayload}.${signature}`),
      sessionOptions(),
    ),
    null,
  );
  assert.equal(
    readWalletSession(
      requestWithCookie(`${name}=${payload}.${changedSignature}`),
      sessionOptions(),
    ),
    null,
  );
  assert.equal(
    readWalletSession(requestWithCookie(`${name}=${token}`), {
      ...sessionOptions(),
      secret: OTHER_SECRET,
    }),
    null,
  );
});

test("expired sessions fail closed at the expiry boundary", () => {
  const session = createPendingWalletSession(sessionOptions());
  const response = attachWalletSessionCookie(
    new Response(null),
    session,
    sessionOptions(),
  );

  assert.equal(
    readWalletSession(requestWithCookie(cookieFrom(response)), {
      ...sessionOptions(),
      nowMs: session.expiresAt * 1_000,
    }),
    null,
  );
});

test("strict payload validation rejects signed extra fields", () => {
  const session = createPendingWalletSession(sessionOptions());
  const token = signedToken({ ...session, role: "admin" });

  assert.equal(
    readWalletSession(
      requestWithCookie(`${walletSessionCookieName(false)}=${token}`),
      sessionOptions(),
    ),
    null,
  );
});

test("duplicate session cookies are rejected as ambiguous", () => {
  const session = createPendingWalletSession(sessionOptions());
  const response = attachWalletSessionCookie(
    new Response(null),
    session,
    sessionOptions(),
  );
  const cookie = cookieFrom(response);

  assert.equal(
    readWalletSession(requestWithCookie(`${cookie}; ${cookie}`), sessionOptions()),
    null,
  );
});

test("AUTH_SECRET must contain at least 32 bytes", () => {
  assert.throws(
    () => createPendingWalletSession({ ...sessionOptions(), secret: "too-short" }),
    /at least 32 bytes/,
  );
});
