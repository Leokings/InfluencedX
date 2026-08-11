import { getVercelOidcToken } from "@vercel/oidc";
import {
  getAddress,
  isAddress,
  isHex,
  size,
  type Address,
  type Hex,
} from "viem";
import type { RelayConfig, WatcherTarget } from "./config";
import { MAX_RESPONSE_BYTES } from "./constants";
import { RelayProblem } from "./problem";
import type {
  ResolutionContext,
  SerializedResolutionMessage,
  WatcherRequest,
  WatcherSignature,
} from "./types";

export function buildWatcherRequest(context: ResolutionContext, escrow: Address): WatcherRequest {
  const submissionDocument = Object.freeze({
    schemaVersion: 1,
    chainId: 84_532,
    escrowContract: getAddress(escrow),
    assignmentId: context.assignmentId,
    agreementHash: context.agreementHash,
    creatorWallet: context.creator,
    expectedHandle: context.expectedHandle,
    xPostId: context.xPostId,
  });
  return Object.freeze({
    schemaVersion: 1,
    requestId: context.requestId,
    genlayerTxHash: context.genlayerTxHash,
    binding: Object.freeze({
      campaignId: context.campaignId,
      assignmentId: context.assignmentId,
      brand: context.brand,
      creator: context.creator,
      identityHash: context.identityHash,
      agreementHash: context.agreementHash,
      submissionHash: context.submissionHash,
      postIdHash: context.postIdHash,
      termsDocument: context.termsDocument,
      submissionDocument,
    }),
  });
}

export async function requestWatcherSignatures(input: {
  request: WatcherRequest;
  config: RelayConfig;
  fetchImplementation?: typeof fetch;
  oidcToken?: string;
}): Promise<readonly WatcherSignature[]> {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  let oidcToken: string;
  try { oidcToken = input.oidcToken ?? await getVercelOidcToken(); }
  catch { throw new RelayProblem(503, "WATCHER_AUTH_UNAVAILABLE", "The watcher workload identity is unavailable.", true); }
  if (oidcToken.split(".").length !== 3 || oidcToken.length > 16_384) throw new RelayProblem(503, "WATCHER_AUTH_UNAVAILABLE", "The watcher workload identity is invalid.", true);
  const settled = await Promise.allSettled(input.config.watchers.map((target) => requestOne(
    target,
    input.request,
    oidcToken,
    fetchImplementation,
  )));
  return Object.freeze(settled.flatMap((item) => item.status === "fulfilled" ? [item.value] : []));
}

async function requestOne(
  target: WatcherTarget,
  body: WatcherRequest,
  oidcToken: string,
  fetchImplementation: typeof fetch,
): Promise<WatcherSignature> {
  let response: Response;
  try {
    response = await fetchImplementation(`${target.origin}/api/v1/campaign-signatures`, {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(45_000),
      headers: {
        authorization: `Bearer ${oidcToken}`,
        "x-vercel-trusted-oidc-idp-token": oidcToken,
        "x-influencedx-service-token": target.serviceToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch { throw new RelayProblem(503, "WATCHER_UNAVAILABLE", "A watcher is unavailable.", true); }
  const text = await boundedText(response);
  if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new RelayProblem(503, "WATCHER_REJECTED", "A watcher rejected the resolution request.", true);
  let value: unknown; try { value = JSON.parse(text); } catch { throw invalidWatcher(); }
  if (!plain(value) || !plain(value.signature)) throw invalidWatcher();
  const parsed = parseWatcherSignature(value.signature);
  if (getAddress(parsed.signer) !== getAddress(target.address)) throw invalidWatcher();
  return parsed;
}

export function parseWatcherSignature(value: unknown): WatcherSignature {
  if (!plain(value)) throw invalidWatcher();
  exact(value, ["schemaVersion", "requestId", "signer", "digest", "signature", "message"]);
  if (value.schemaVersion !== 1 || !plain(value.message)) throw invalidWatcher();
  exact(value.message, ["requestId", "assignmentId", "outcome", "evidenceHash", "genlayerContract", "genlayerTxHash", "resolvedAt", "relayDeadline"]);
  const message: SerializedResolutionMessage = Object.freeze({
    requestId: hash(value.message.requestId),
    assignmentId: positive(value.message.assignmentId),
    outcome: outcome(value.message.outcome),
    evidenceHash: hash(value.message.evidenceHash),
    genlayerContract: hash(value.message.genlayerContract),
    genlayerTxHash: hash(value.message.genlayerTxHash),
    resolvedAt: positive(value.message.resolvedAt),
    relayDeadline: positive(value.message.relayDeadline),
  });
  return Object.freeze({
    schemaVersion: 1,
    requestId: hash(value.requestId),
    signer: address(value.signer),
    digest: hash(value.digest),
    signature: signature(value.signature),
    message,
  });
}

async function boundedText(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) throw invalidWatcher();
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw invalidWatcher();
  return text;
}
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) throw invalidWatcher();
}
function hash(value: unknown): Hex { if (typeof value !== "string" || !isHex(value) || size(value) !== 32) throw invalidWatcher(); return value.toLowerCase() as Hex; }
function signature(value: unknown): Hex { if (typeof value !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(value)) throw invalidWatcher(); return value.toLowerCase() as Hex; }
function address(value: unknown): Address { if (typeof value !== "string" || !isAddress(value, { strict: false })) throw invalidWatcher(); return getAddress(value); }
function positive(value: unknown): string { if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw invalidWatcher(); return value; }
function outcome(value: unknown): number { if (value !== 1 && value !== 2 && value !== 3) throw invalidWatcher(); return value; }
function invalidWatcher(): RelayProblem { return new RelayProblem(502, "WATCHER_RESPONSE_INVALID", "A watcher returned an invalid response.", true); }
