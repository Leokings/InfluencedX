import { MAX_REQUEST_BYTES } from "./constants";
import { SubmitterProblem } from "./problem";

export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) throw new SubmitterProblem(415, "JSON_REQUIRED", "Content-Type must be application/json.");
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) throw new SubmitterProblem(413, "REQUEST_TOO_LARGE", "The submission body is too large.");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) throw new SubmitterProblem(413, "REQUEST_TOO_LARGE", "The submission body is too large.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SubmitterProblem(400, "INVALID_JSON", "The submission body is not valid JSON.");
  }
}
