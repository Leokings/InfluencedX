import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

type WebHandler = (request: Request) => Promise<Response>;

export async function serveVercelNodeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: WebHandler,
): Promise<void> {
  if (request.method !== "POST") {
    await writeResponse(response, Response.json(
      { error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is supported." } },
      { status: 405, headers: { allow: "POST", "cache-control": "no-store" } },
    ));
    return;
  }

  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
      else if (typeof value === "string") headers.set(name, value);
    }
    const webRequest = new Request(
      new URL(request.url ?? "/", "https://influencedx-relay.invalid"),
      {
        method: "POST",
        headers,
        body: Readable.toWeb(request) as ReadableStream,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );
    await writeResponse(response, await handler(webRequest));
  } catch {
    await writeResponse(response, Response.json(
      { error: { code: "RELAY_FAILED", message: "The campaign relay stopped safely.", retryable: false } },
      { status: 500, headers: { "cache-control": "no-store" } },
    ));
  }
}

async function writeResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, name) => response.setHeader(name, value));
  response.end(Buffer.from(await webResponse.arrayBuffer()));
}
