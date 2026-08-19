export class OperatorProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OperatorProblem";
  }
}

export class PoisonMessageError extends OperatorProblem {
  constructor(code: string, message: string, readonly operationId?: string) {
    super(400, code, message);
    this.name = "PoisonMessageError";
  }
}

export class GateBusyError extends OperatorProblem {
  constructor() {
    super(503, "SIGNER_GATE_BUSY", "The singleton signer is processing another operation.");
    this.name = "GateBusyError";
  }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function problemResponse(error: unknown): Response {
  if (error instanceof OperatorProblem) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  console.error("Marketplace operator request failed", error);
  return json(
    { error: { code: "INTERNAL_ERROR", message: "The marketplace operator request failed." } },
    500,
  );
}
