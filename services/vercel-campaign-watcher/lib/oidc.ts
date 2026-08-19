import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { WatcherConfig } from "./config.js";
import { WatcherProblem } from "./problem.js";

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function requireCallerOidc(request: Request, config: WatcherConfig): Promise<void> {
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
  config: WatcherConfig,
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

function unauthorized(): never {
  throw new WatcherProblem(401, "CALLER_OIDC_INVALID", "A valid InfluencedX coordinator workload identity is required.");
}
