import { getVercelOidcToken } from "@vercel/oidc";
import type { Hex } from "viem";

const MAX_RESPONSE_BYTES = 8_192;
const REQUEST_TIMEOUT_MS = 125_000;

export type CampaignRelayResult = Readonly<{
  requestId: Hex;
  status: "CONFIRMED" | "SIMULATED";
  broadcast: boolean;
  txHash: Hex | null;
  outcome: "PASS" | "FAIL" | "UNDETERMINED";
}>;

export type CampaignRelayConfig = Readonly<{
  origin: string;
  oidcToken: string;
  serviceToken: string;
}>;

export class CampaignRelayClientProblem extends Error {
  readonly code:
    | "CONFIGURATION_REQUIRED"
    | "RELAY_UNAVAILABLE"
    | "RELAY_RESPONSE_INVALID";
  readonly ambiguous: boolean;

  constructor(
    code:
      | "CONFIGURATION_REQUIRED"
      | "RELAY_UNAVAILABLE"
      | "RELAY_RESPONSE_INVALID",
    message: string,
    ambiguous = false,
  ) {
    super(message);
    this.name = "CampaignRelayClientProblem";
    this.code = code;
    this.ambiguous = ambiguous;
  }
}

export async function loadCampaignRelayConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CampaignRelayConfig | null> {
  if (env.XPROOF_CAMPAIGN_RELAY_BRIDGE_ENABLED !== "true") return null;
  const origin = exactOrigin(env.XPROOF_CAMPAIGN_RELAY_URL);
  const serviceToken = env.XPROOF_CAMPAIGN_RELAY_SERVICE_TOKEN;
  if (typeof serviceToken !== "string" || Buffer.byteLength(serviceToken, "utf8") < 32 || Buffer.byteLength(serviceToken, "utf8") > 256) throw configuration();
  let oidcToken: string;
  try { oidcToken = await getVercelOidcToken(); }
  catch { throw configuration(); }
  if (oidcToken.length > 16_384 || oidcToken.split(".").length !== 3) throw configuration();
  return Object.freeze({ origin, oidcToken, serviceToken });
}

export function createCampaignRelayClient(
  config: CampaignRelayConfig,
  fetchImplementation: typeof fetch = fetch,
) {
  return Object.freeze({
    async settle(requestId: Hex): Promise<CampaignRelayResult> {
      if (!/^0x[0-9a-f]{64}$/.test(requestId)) throw new CampaignRelayClientProblem("RELAY_RESPONSE_INVALID", "The finalized request ID is invalid.");
      let response: Response;
      try {
        response = await fetchImplementation(`${config.origin}/api/v1/campaign-resolutions`, {
          method: "POST",
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            authorization: `Bearer ${config.oidcToken}`,
            "x-vercel-trusted-oidc-idp-token": config.oidcToken,
            "x-influencedx-service-token": config.serviceToken,
            "content-type": "application/json",
          },
          body: JSON.stringify({ requestId }),
        });
      } catch {
        throw new CampaignRelayClientProblem("RELAY_UNAVAILABLE", "Automatic Base settlement is temporarily unavailable.", true);
      }
      const text = await boundedText(response);
      if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new CampaignRelayClientProblem("RELAY_UNAVAILABLE", "Automatic Base settlement was not accepted.", response.status >= 500);
      let value: unknown; try { value = JSON.parse(text); } catch { throw invalid(); }
      return parseResult(value, requestId);
    },
  });
}

function parseResult(value: unknown, requestId: Hex): CampaignRelayResult {
  if (!plain(value) || Object.keys(value).sort().join(",") !== "broadcast,outcome,requestId,status,txHash") throw invalid();
  if (value.requestId !== requestId || (value.status !== "CONFIRMED" && value.status !== "SIMULATED") || typeof value.broadcast !== "boolean") throw invalid();
  if (value.outcome !== "PASS" && value.outcome !== "FAIL" && value.outcome !== "UNDETERMINED") throw invalid();
  const txHash = value.txHash === null ? null : hash(value.txHash);
  if ((value.status === "CONFIRMED") !== (value.broadcast === true && txHash !== null)) throw invalid();
  return Object.freeze({ requestId, status: value.status, broadcast: value.broadcast, txHash, outcome: value.outcome });
}

async function boundedText(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) throw invalid();
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw invalid();
  return text;
}
function exactOrigin(value: unknown): string {
  if (typeof value !== "string") throw configuration();
  let url: URL; try { url = new URL(value); } catch { throw configuration(); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.port) throw configuration();
  return url.origin;
}
function hash(value: unknown): Hex { if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) throw invalid(); return value as Hex; }
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function configuration(): CampaignRelayClientProblem { return new CampaignRelayClientProblem("CONFIGURATION_REQUIRED", "The automatic campaign relay is not configured."); }
function invalid(): CampaignRelayClientProblem { return new CampaignRelayClientProblem("RELAY_RESPONSE_INVALID", "The automatic campaign relay returned an invalid response."); }
