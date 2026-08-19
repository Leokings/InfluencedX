import { requireCallerAuth } from "../../lib/auth.js";
import { loadConfig } from "../../lib/config.js";
import { readRequestId } from "../../lib/http.js";
import { json, problemResponse } from "../../lib/problem.js";
import { settleFinalizedCampaignResolution } from "../../lib/service.js";
import { serveVercelNodeRequest } from "../../lib/vercel-node.js";
import type { IncomingMessage, ServerResponse } from "node:http";

export const config = { runtime: "nodejs" };

export async function POST(request: Request): Promise<Response> {
  try {
    const relayConfig = loadConfig();
    await requireCallerAuth(request, relayConfig);
    const requestId = await readRequestId(request);
    return json(await settleFinalizedCampaignResolution({ requestId, config: relayConfig }));
  } catch (error) {
    return problemResponse(error);
  }
}

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  await serveVercelNodeRequest(request, response, POST);
}
