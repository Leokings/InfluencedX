import { requireIngressAuth } from "@/lib/auth";
import { validateWithdrawalId } from "@/lib/envelope";
import { ReconcilerProblem, json, problemResponse } from "@/lib/problem";
import { createStatusRuntime } from "@/lib/runtimes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ withdrawalId: string }> },
): Promise<Response> {
  try {
    const runtime = createStatusRuntime();
    await requireIngressAuth(request, runtime.config);
    const withdrawalId = validateWithdrawalId((await context.params).withdrawalId);
    const reconciliation = await runtime.repository.getProjection(withdrawalId);
    if (!reconciliation) throw new ReconcilerProblem(404, "RECONCILIATION_NOT_FOUND", "Withdrawal reconciliation not found.");
    return json({ reconciliation });
  } catch (error) {
    return problemResponse(error);
  }
}
