import { MAX_REQUEST_BYTES } from "./constants";
import { OperatorProblem } from "./problem";

export async function readJsonBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_REQUEST_BYTES) tooLarge();
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) tooLarge();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OperatorProblem(400, "INVALID_JSON", "The request body must be JSON.");
  }
}

function tooLarge(): never {
  throw new OperatorProblem(413, "REQUEST_TOO_LARGE", "The operation request is too large.");
}
