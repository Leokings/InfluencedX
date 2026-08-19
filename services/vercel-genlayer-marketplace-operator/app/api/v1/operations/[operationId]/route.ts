import { requireIngressAuth } from "@/lib/auth";
import { validateOperationId } from "@/lib/envelope";
import { OperatorProblem, json, problemResponse } from "@/lib/problem";
import { createStatusRuntime } from "@/lib/runtimes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ operationId: string }> },
): Promise<Response> {
  try {
    const runtime = createStatusRuntime();
    await requireIngressAuth(request, runtime.config);
    const operationId = validateOperationId((await context.params).operationId);
    const operation = await runtime.repository.getProjection(operationId);
    if (!operation) throw new OperatorProblem(404, "OPERATION_NOT_FOUND", "Operation not found.");
    return json({ operation });
  } catch (error) {
    return problemResponse(error);
  }
}
