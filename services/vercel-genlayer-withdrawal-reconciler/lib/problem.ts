export class ReconcilerProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReconcilerProblem";
  }
}

export class PoisonMessageError extends ReconcilerProblem {
  constructor(code: string, message: string, readonly withdrawalId?: string) {
    super(400, code, message);
    this.name = "PoisonMessageError";
  }
}

export class GateBusyError extends ReconcilerProblem {
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
  if (error instanceof ReconcilerProblem) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  // Only a stable error class is logged. Never serialize signer material,
  // transfer proofs, RPC bodies, or the thrown object.
  console.error("Withdrawal reconciler request failed", error instanceof Error ? error.name : "UnknownError");
  return json(
    { error: { code: "INTERNAL_ERROR", message: "The withdrawal reconciler request failed." } },
    500,
  );
}
