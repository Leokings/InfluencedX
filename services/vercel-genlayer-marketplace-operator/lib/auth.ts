import { createHash, timingSafeEqual } from "node:crypto";

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import type { OperatorConfig } from "./config";
import { SERVICE_TOKEN_HEADER } from "./constants";
import { OperatorProblem } from "./problem";

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function requireIngressAuth(request: Request, config: OperatorConfig): Promise<void> {
  await requireCallerOidc(request, config);
  requireServiceToken(request.headers.get(SERVICE_TOKEN_HEADER), config.serviceToken);
}

export async function requireCallerOidc(request: Request, config: OperatorConfig): Promise<void> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length <= 7) unauthorized();
  const issuer = `https://oidc.vercel.com/${config.caller.teamSlug}`;
  let key = jwks.get(issuer);
  if (!key) {
    key = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));
    jwks.set(issuer, key);
  }
  await verifyCallerToken(authorization.slice(7), config, key);
}

export async function verifyCallerToken(
  token: string,
  config: OperatorConfig,
  key: CryptoKey | Uint8Array | JWTVerifyGetKey,
): Promise<void> {
  const issuer = `https://oidc.vercel.com/${config.caller.teamSlug}`;
  const subject = `owner:${config.caller.teamSlug}:project:${config.caller.projectName}:environment:${config.caller.environment}`;
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer,
      audience: `https://vercel.com/${config.caller.teamSlug}`,
      subject,
      algorithms: ["RS256"],
    });
    if (
      payload.owner !== config.caller.teamSlug ||
      payload.owner_id !== config.caller.teamId ||
      payload.project !== config.caller.projectName ||
      payload.project_id !== config.caller.projectId ||
      payload.environment !== config.caller.environment
    ) unauthorized();
  } catch {
    unauthorized();
  }
}

export function requireServiceToken(candidate: string | null, expected: string): void {
  if (typeof candidate !== "string" || !/^[0-9a-fA-F]{64}$/.test(candidate)) unauthorized();
  const left = createHash("sha256").update(candidate.toLowerCase()).digest();
  const right = createHash("sha256").update(expected.toLowerCase()).digest();
  if (!timingSafeEqual(left, right)) unauthorized();
}

function unauthorized(): never {
  throw new OperatorProblem(401, "OPERATOR_AUTH_INVALID", "Exact Vercel OIDC and service-token credentials are required.");
}
