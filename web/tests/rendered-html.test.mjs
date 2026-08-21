import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const nextCli = fileURLToPath(
  new URL("../node_modules/next/dist/bin/next", import.meta.url),
);

let baseUrl;
let nextServer;
let serverOutput = "";

before(async () => {
  const port = await availablePort();
  baseUrl = "http://127.0.0.1:" + port;
  nextServer = spawn(
    process.execPath,
    [nextCli, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: projectDirectory,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  nextServer.stdout.on("data", (chunk) => {
    serverOutput += chunk;
  });
  nextServer.stderr.on("data", (chunk) => {
    serverOutput += chunk;
  });

  await waitForNextServer();
});

after(async () => {
  if (!nextServer || nextServer.exitCode !== null) return;
  const exited = new Promise((resolve) => nextServer.once("exit", resolve));
  nextServer.kill();
  await Promise.race([exited, delay(5_000)]);
  if (nextServer.exitCode === null) nextServer.kill("SIGKILL");
});

async function render(pathname = "/", headers = {}) {
  return fetch(new URL(pathname, baseUrl), {
    headers: { accept: "text/html", ...headers },
    redirect: "manual",
  });
}

test("server-renders the concise bundled identity flow without claiming verification", async () => {
  const response = await render("/verify");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /VERIFY/);
  assert.match(html, /BOTH\./);
  assert.match(html, /Link X \+ Farcaster to one wallet/);
  assert.doesNotMatch(html, /Pinned to this wallet|ONE WALLET TRANSACTION|NO SOCIAL PASSWORDS/);
  assert.doesNotMatch(html, /FARCASTER FID|FARCASTER CAST HASH/);
  assert.doesNotMatch(html, /BASE|USDC|VERIFICATION COMPLETE/i);
});

test("serves the InfluencedX share card through Next static assets", async () => {
  const response = await render("/og.png");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^image\/png\b/i);
  assert.ok((await response.arrayBuffer()).byteLength > 0);
});

test("serves a wordmark-only InfluencedX application icon", async () => {
  const response = await render("/icon.svg");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^image\/svg\+xml\b/i);

  const svg = await response.text();
  assert.match(svg, />INFLUENCEDX<\/text>/);
  assert.doesNotMatch(svg, /CREATOR MARKET|VERIFIED|BASE|GENLAYER|TESTNET/i);
  assert.doesNotMatch(svg, /<(?:path|circle|polygon)\b/i);
});

test("server-renders the InfluencedX marketplace and share metadata", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>InfluencedX<\/title>/i);
  assert.match(html, /DEALS\./);
  assert.match(html, /ACTIVE CAMPAIGNS/);
  assert.match(html, /CREATOR BOARD/);
  assert.match(html, /LOADING THE MARKET/);
  assert.match(html, /VERIFY X \+ FARCASTER/);
  assert.match(html, /X POST OR FARCASTER CAST/);
  assert.match(html, /PROVEN WITH X \+ FARCASTER · 1 TRANSACTION/);
  assert.doesNotMatch(html, /VERIFY YOUR X|ONE-TIME PUBLIC X POST|>PUBLIC X POST<\/span>/);
  assert.match(html, /href="\/privacy"/);
  assert.match(html, /href="\/terms"/);
  assert.doesNotMatch(html, /Northstar Labs|84\.2K|416.*VERIFIED CREATORS/i);
  assert.match(html, /og\.png/);
  assert.doesNotMatch(
    html,
    /codex-preview|Your site is taking shape|react-loading-skeleton/i,
  );
});

test("server-renders accurate public privacy and testnet terms pages", async () => {
  const [privacyResponse, termsResponse] = await Promise.all([
    render("/privacy"),
    render("/terms"),
  ]);
  assert.equal(privacyResponse.status, 200);
  assert.equal(termsResponse.status, 200);

  const [privacy, terms] = await Promise.all([
    privacyResponse.text(),
    termsResponse.text(),
  ]);

  assert.match(privacy, /PRIVACY NOTICE/);
  assert.match(privacy, /AUGUST 19, 2026/);
  assert.match(privacy, /HttpOnly/);
  assert.match(privacy, /NEON POSTGRES/);
  assert.match(privacy, /GENLAYER STUDIONET/);
  assert.match(privacy, /Public X and Farcaster evidence/);
  assert.doesNotMatch(privacy, /BASE SEPOLIA|USDC|GENLAYER BRADBURY/i);
  assert.match(privacy, /cannot be erased by InfluencedX/i);
  assert.match(privacy, /does not use X OAuth or Farcaster custody APIs/i);

  assert.match(terms, /TESTNET TERMS/);
  assert.match(terms, /AUGUST 19, 2026/);
  assert.match(terms, /NO GUARANTEED PAYMENT OR REFUND/);
  assert.match(terms, /TEST GEN HAS NO PROMISED MONETARY VALUE/);
  assert.match(terms, /X OR FARCASTER CREATOR CAMPAIGNS/i);
  assert.match(terms, /does not take custody of wallet keys/i);
  assert.doesNotMatch(terms, /BASE SEPOLIA|USDC|BASE PAYMENT/i);
  assert.match(terms, /href="\/privacy"/);
  assert.doesNotMatch(terms, /Delaware|United States|Nigeria|registered office/i);
});

test("server-renders the brand campaign creation workspace without a funded claim", async () => {
  const response = await render("/marketplace/create");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /CREATE A/);
  assert.match(html, /CAMPAIGN RECORD/);
  assert.match(html, /NEW \/ UNFUNDED/);
  assert.doesNotMatch(html, /FUNDED ON BASE|ESCROW FUNDED/i);
});

test("removes disposable starter assets and uses the Next.js runtime", async () => {
  const [page, header, layout, packageJson, icon] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/marketplace/components/MarketplaceHeader.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/icon.svg", import.meta.url), "utf8"),
  ]);

  assert.match(page, /MarketplaceHeader/);
  assert.match(header, />INFLUENCEDX</);
  assert.match(layout, /title: "InfluencedX"/);
  assert.match(packageJson, /"next": "16\.3\.0"/);
  assert.match(icon, />INFLUENCEDX<\/text>/);
  assert.doesNotMatch(icon, /CREATOR MARKET|CREATOR WORK, VERIFIED/i);
  assert.doesNotMatch(packageJson, /vinext|react-loading-skeleton/);
  await access(new URL("../public/og.png", import.meta.url));
  await assert.rejects(access(new URL("../app/_sites-preview/", import.meta.url)));
});

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a port for the Next.js smoke test.");
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForNextServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (nextServer.exitCode !== null) {
      throw new Error(
        "Next.js exited before smoke tests could run.\n" + serverOutput,
      );
    }
    try {
      await fetch(baseUrl, { redirect: "manual" });
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error("Next.js did not start in time.\n" + serverOutput);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
