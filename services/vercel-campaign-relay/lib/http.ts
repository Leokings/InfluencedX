import { MAX_REQUEST_BYTES } from "./constants.js";
import { RelayProblem } from "./problem.js";

export async function readRequestId(request: Request): Promise<`0x${string}`> {
  const type = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!type.startsWith("application/json")) throw new RelayProblem(415, "JSON_REQUIRED", "Content-Type must be application/json.");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) throw new RelayProblem(413, "REQUEST_TOO_LARGE", "The relay request is too large.");
  let value: unknown; try { value = JSON.parse(text); } catch { throw new RelayProblem(400, "INVALID_JSON", "The relay request is invalid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !("requestId" in value)) throw new RelayProblem(400, "INVALID_REQUEST", "Only requestId is accepted.");
  const requestId = (value as { requestId?: unknown }).requestId;
  if (typeof requestId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(requestId)) throw new RelayProblem(400, "INVALID_REQUEST", "requestId must be bytes32.");
  return requestId.toLowerCase() as `0x${string}`;
}
