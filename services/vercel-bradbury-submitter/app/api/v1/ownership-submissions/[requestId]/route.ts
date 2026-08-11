import { createStatusRuntime } from "@/lib/ingress-runtime";
import { requireCallerOidc } from "@/lib/oidc";
import { json, problemResponse, SubmitterProblem } from "@/lib/problem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
): Promise<Response> {
  try {
    const runtime = createStatusRuntime();
    await requireCallerOidc(request, runtime.config);
    const { requestId } = await context.params;
    if (!/^0x[0-9a-fA-F]{64}$/.test(requestId)) throw new SubmitterProblem(400, "INVALID_REQUEST_ID", "requestId must be a 32-byte hex hash.");
    const submission = await runtime.repository.getProjection(requestId.toLowerCase());
    if (!submission) throw new SubmitterProblem(404, "SUBMISSION_NOT_FOUND", "Submission not found.");
    return json({ submission });
  } catch (error) {
    return problemResponse(error);
  }
}
