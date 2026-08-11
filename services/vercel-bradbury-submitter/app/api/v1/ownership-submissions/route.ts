import { validateOwnershipEnvelope } from "@/lib/envelope";
import { readJsonBody } from "@/lib/http";
import { createIngressRuntime } from "@/lib/ingress-runtime";
import { requireCallerOidc } from "@/lib/oidc";
import { json, problemResponse } from "@/lib/problem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const runtime = createIngressRuntime();
    await requireCallerOidc(request, runtime.config);
    const envelope = await validateOwnershipEnvelope(await readJsonBody(request));
    const result = await runtime.ingress.accept(envelope);
    return json(result, result.replayed ? 200 : 202);
  } catch (error) {
    return problemResponse(error);
  }
}
