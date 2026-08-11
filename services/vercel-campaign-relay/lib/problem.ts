export class RelayProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "RelayProblem";
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
  } });
}

export function problemResponse(error: unknown): Response {
  const problem = error instanceof RelayProblem
    ? error
    : new RelayProblem(500, "RELAY_FAILED", "The campaign relay stopped safely.");
  const message = problem.code === "RELAY_CONFIGURATION_INVALID" ? "The campaign relay is unavailable." : problem.message;
  return json({ error: { code: problem.code, message, retryable: problem.retryable } }, problem.status);
}
