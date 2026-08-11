import { loadConfig } from "../../lib/config";
import { readJsonBody, requireServiceToken } from "../../lib/http";
import { requireCallerOidc } from "../../lib/oidc";
import { json, problemResponse } from "../../lib/problem";
import {
  parseCampaignSignatureRequest,
  signVerifiedCampaignResolution,
} from "../../lib/protocol";

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

export default POST;
