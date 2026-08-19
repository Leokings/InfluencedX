import assert from "node:assert/strict";
import test from "node:test";

import { generateKeyPair, SignJWT } from "jose";

import { requireServiceToken, verifyCallerToken } from "../lib/auth";
import { configFixture } from "./helpers";

const config = configFixture();
const { publicKey, privateKey } = await generateKeyPair("RS256");

async function token(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    owner: config.caller.teamSlug,
    owner_id: config.caller.teamId,
    project: config.caller.projectName,
    project_id: config.caller.projectId,
    environment: config.caller.environment,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(`https://oidc.vercel.com/${config.caller.teamSlug}`)
    .setAudience(`https://vercel.com/${config.caller.teamSlug}`)
    .setSubject(`owner:${config.caller.teamSlug}:project:${config.caller.projectName}:environment:${config.caller.environment}`)
    .setIssuedAt(now).setNotBefore(now - 1).setExpirationTime(now + 300).sign(privateKey);
}

test("exact Vercel workload claims and the independent withdrawal token are required", async () => {
  await verifyCallerToken(await token(), config, publicKey);
  requireServiceToken(config.serviceToken, config.serviceToken);
  for (const patch of [
    { owner: "attacker" }, { owner_id: "team_attacker" }, { project: "attacker" },
    { project_id: "prj_attacker" }, { environment: "production" }, { project_id: undefined },
  ]) {
    await assert.rejects(
      verifyCallerToken(await token(patch), config, publicKey),
      (error: unknown) => (error as { code?: string }).code === "RECONCILER_AUTH_INVALID",
    );
  }
  for (const candidate of [null, "", "aa", "bb".repeat(32), "g".repeat(64)]) {
    assert.throws(
      () => requireServiceToken(candidate, config.serviceToken),
      (error: unknown) => (error as { code?: string }).code === "RECONCILER_AUTH_INVALID",
    );
  }
});
