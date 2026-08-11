export class WatcherProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WatcherProblem";
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

export function problemResponse(error: unknown): Response {
  const problem = error instanceof WatcherProblem
    ? error
    : new WatcherProblem(500, "WATCHER_FAILED", "The watcher refused the resolution request.");
  const message = problem.code === "WATCHER_CONFIGURATION_INVALID"
    ? "The watcher is unavailable."
    : problem.message;
  return json({ error: { code: problem.code, message } }, problem.status);
}
