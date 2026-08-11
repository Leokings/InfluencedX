import {
  issueOwnershipAuthorizationCiphertext,
  OwnershipAuthorizationBrokerProblem,
} from "@/lib/ownership-authorization-broker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readBoundedJson(request);
    const result = await issueOwnershipAuthorizationCiphertext(body);
    // The response deliberately has one field: RSA-OAEP ciphertext encrypted
    // to the caller's one-use public key. No proof or signature metadata is
    // returned in plaintext.
    return Response.json(
      { ciphertext: result.ciphertext },
      { headers: RESPONSE_HEADERS },
    );
  } catch (error) {
    return brokerError(error);
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new OwnershipAuthorizationBrokerProblem(
      415,
      "JSON_REQUIRED",
      "Requests must use the application/json content type.",
    );
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 8_192) {
    throw new OwnershipAuthorizationBrokerProblem(
      413,
      "PAYLOAD_TOO_LARGE",
      "The request is too large.",
    );
  }
  const text = await request.text();
  if (text.length > 8_192) {
    throw new OwnershipAuthorizationBrokerProblem(
      413,
      "PAYLOAD_TOO_LARGE",
      "The request is too large.",
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new OwnershipAuthorizationBrokerProblem(
      400,
      "INVALID_JSON",
      "The JSON body is invalid.",
    );
  }
}

function brokerError(error: unknown): Response {
  if (error instanceof OwnershipAuthorizationBrokerProblem) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: RESPONSE_HEADERS },
    );
  }
  // Do not log the thrown value: this route is intentionally the only process
  // boundary that can open the sealed creator signature.
  return Response.json(
    {
      error: {
        code: "OWNERSHIP_AUTHORIZATION_FAILED",
        message: "The ownership authorization could not be issued.",
      },
    },
    { status: 500, headers: RESPONSE_HEADERS },
  );
}
