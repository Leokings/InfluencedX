import { timingSafeEqual } from "node:crypto";
import { MAX_REQUEST_BYTES } from "./constants";
import { WatcherProblem } from "./problem";

export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new WatcherProblem(415, "JSON_REQUIRED", "Content-Type must be application/json.");
  }
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) {
    throw new WatcherProblem(413, "REQUEST_TOO_LARGE", "The watcher request is too large.");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) {
    throw new WatcherProblem(413, "REQUEST_TOO_LARGE", "The watcher request is too large.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WatcherProblem(400, "INVALID_JSON", "The watcher request is not valid JSON.");
  }
}

export function requireServiceToken(request: Request, expected: string): void {
  const supplied = request.headers.get("x-influencedx-service-token") ?? "";
  const left = Buffer.from(supplied, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new WatcherProblem(401, "SERVICE_AUTH_INVALID", "Authenticated coordinator access is required.");
  }
}
