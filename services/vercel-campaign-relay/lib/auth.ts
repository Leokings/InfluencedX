import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { RelayConfig } from "./config";
import { RelayProblem } from "./problem";

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function requireCallerAuth(request: Request, config: RelayConfig): Promise<void> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length <= 7) unauthorized("CALLER_OIDC_INVALID");
  const issuer = `https://oidc.vercel.com/${config.caller.teamSlug}`;
  let key = jwks.get(issuer);
  if (!key) {
    key = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));
    jwks.set(issuer, key);
  }
  await verifyCallerToken(authorization.slice(7), config, key);
  const supplied = Buffer.from(request.headers.get("x-influencedx-service-token") ?? "", "utf8");
  const expected = Buffer.from(config.serviceToken, "utf8");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) unauthorized("SERVICE_AUTH_INVALID");
}

export async function verifyCallerToken(token: string, config: RelayConfig, key: CryptoKey | Uint8Array | JWTVerifyGetKey): Promise<void> {
  const issuer = `https://oidc.vercel.com/${config.caller.teamSlug}`;
  const subject = `owner:${config.caller.teamSlug}:project:${config.caller.projectName}:environment:${config.caller.environment}`;
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer,
      audience: `https://vercel.com/${config.caller.teamSlug}`,
      subject,
      algorithms: ["RS256"],
    });
    if (payload.owner !== config.caller.teamSlug || payload.owner_id !== config.caller.teamId || payload.project !== config.caller.projectName || payload.project_id !== config.caller.projectId || payload.environment !== config.caller.environment) unauthorized("CALLER_OIDC_INVALID");
  } catch { unauthorized("CALLER_OIDC_INVALID"); }
}

function unauthorized(code: string): never {
  throw new RelayProblem(401, code, "Authenticated InfluencedX service access is required.");
}
