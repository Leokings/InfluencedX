import { requireIngressAuth } from "@/lib/auth";
import { validateReconciliationRequest } from "@/lib/envelope";
import { readJsonBody } from "@/lib/http";
import { json, problemResponse } from "@/lib/problem";
import { createIngressRuntime } from "@/lib/runtimes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const runtime = createIngressRuntime();
    await requireIngressAuth(request, runtime.config);
    const input = validateReconciliationRequest(await readJsonBody(request), runtime.config);
    const result = await runtime.ingress.accept(input);
    return json(result, result.replayed ? 200 : 202);
  } catch (error) {
    return problemResponse(error);
  }
}
