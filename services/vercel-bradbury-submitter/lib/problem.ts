export class SubmitterProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SubmitterProblem";
  }
}

export class PoisonMessageError extends SubmitterProblem {
  constructor(code: string, message: string, readonly requestId: string | null = null) {
    super(400, code, message);
    this.name = "PoisonMessageError";
  }
}

export class GateBusyError extends SubmitterProblem {
  constructor() {
    super(503, "SIGNER_GATE_BUSY", "The serialized StudioNet signer is busy.");
    this.name = "GateBusyError";
  }
}

export function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

export function problemResponse(error: unknown): Response {
  const problem = error instanceof SubmitterProblem
    ? error
    : new SubmitterProblem(500, "INTERNAL_ERROR", "The private submitter failed safely.");
  const message = problem.code === "SUBMITTER_CONFIGURATION_INVALID"
    ? "The private submitter is unavailable."
    : problem.message;
  return json({ error: { code: problem.code, message } }, problem.status);
}
