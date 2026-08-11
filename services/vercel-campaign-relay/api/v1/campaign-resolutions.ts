import { requireCallerAuth } from "../../lib/auth";
import { loadConfig } from "../../lib/config";
import { readRequestId } from "../../lib/http";
import { json, problemResponse } from "../../lib/problem";
import { settleFinalizedCampaignResolution } from "../../lib/service";

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

export default POST;
