import { loadConfig } from "../../lib/config.js";
import { readJsonBody, requireServiceToken } from "../../lib/http.js";
import { requireCallerOidc } from "../../lib/oidc.js";
import { json, problemResponse } from "../../lib/problem.js";
import {
  parseCampaignSignatureRequest,
  signVerifiedCampaignResolution,
} from "../../lib/protocol.js";
import { serveVercelNodeRequest } from "../../lib/vercel-node.js";
import type { IncomingMessage, ServerResponse } from "node:http";

export const config = { runtime: "nodejs" };

export async function POST(request: Request): Promise<Response> {
  try {
    const watcherConfig = loadConfig();
    await requireCallerOidc(request, watcherConfig);
    requireServiceToken(request, watcherConfig.serviceToken);
    const body = parseCampaignSignatureRequest(await readJsonBody(request));
    return json({ signature: await signVerifiedCampaignResolution(body, watcherConfig) });
  } catch (error) {
    return problemResponse(error);
  }
}

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  await serveVercelNodeRequest(request, response, POST);
}
