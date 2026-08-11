export class SubmitterProblem extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'SubmitterProblem';
    this.status = status;
    this.code = code;
  }
}

export function problemResponse(error) {
  const problem = error instanceof SubmitterProblem
    ? error
    : new SubmitterProblem(500, 'INTERNAL_ERROR', 'The private submitter failed safely.');
  return jsonResponse(
    { error: { code: problem.code, message: problem.message } },
    problem.status,
  );
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
