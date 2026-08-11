import assert from "node:assert/strict";
import test from "node:test";

import { generateKeyPair, SignJWT } from "jose";

import { verifyCallerToken } from "../lib/oidc";
import { configFixture } from "./helpers";

const config = configFixture();
const { publicKey, privateKey } = await generateKeyPair("RS256");

async function token(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1_000);
  const claims = {
    owner: config.caller.teamSlug,
    owner_id: config.caller.teamId,
    project: config.caller.projectName,
    project_id: config.caller.projectId,
    environment: config.caller.environment,
    ...overrides,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(`https://oidc.vercel.com/${config.caller.teamSlug}`)
    .setAudience(`https://vercel.com/${config.caller.teamSlug}`)
    .setSubject(`owner:${config.caller.teamSlug}:project:${config.caller.projectName}:environment:${config.caller.environment}`)
    .setIssuedAt(now)
    .setNotBefore(now - 1)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

test("accepts a Vercel OIDC token only when every caller binding matches", async () => {
  await verifyCallerToken(await token(), config, publicKey);
});

test("rejects OIDC spoofing, wrong project, wrong environment, and missing binding claims", async () => {
  for (const patch of [
    { project_id: "prj_attacker" },
    { project: "other-project" },
    { environment: "production" },
    { owner_id: undefined },
  ]) {
    await assert.rejects(verifyCallerToken(await token(patch), config, publicKey), (error: unknown) => (error as { code?: string }).code === "CALLER_OIDC_INVALID");
  }

  const wrongSubject = await new SignJWT({
    owner: config.caller.teamSlug,
    owner_id: config.caller.teamId,
    project: "attacker",
    project_id: config.caller.projectId,
    environment: config.caller.environment,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(`https://oidc.vercel.com/${config.caller.teamSlug}`)
    .setAudience(`https://vercel.com/${config.caller.teamSlug}`)
    .setSubject(`owner:${config.caller.teamSlug}:project:attacker:environment:${config.caller.environment}`)
    .setExpirationTime("5m")
    .sign(privateKey);
  await assert.rejects(verifyCallerToken(wrongSubject, config, publicKey));
});
