import { isHash, keccak256, stringToHex, type Hex } from "viem";

export const INFLUENCEDX_MARKETPLACE_COMMITMENT_SCHEMA =
  "influencedx.marketplace/v1" as const;

export const marketplaceCommitmentKinds = [
  "campaign-terms",
  "creator-application",
  "assignment-agreement",
  "submission-evidence",
  "resolution-evidence",
] as const;

export type MarketplaceCommitmentKind =
  (typeof marketplaceCommitmentKinds)[number];

export type CanonicalMarketplaceValue =
  | null
  | boolean
  | string
  | number
  | readonly CanonicalMarketplaceValue[]
  | { readonly [key: string]: CanonicalMarketplaceValue };

/**
 * Produces a stable JSON representation for commitments stored on Base.
 *
 * Marketplace documents deliberately allow only JSON primitives, safe integer
 * numbers, arrays without holes, and plain objects. Monetary values must be
 * decimal strings or USDC atoms; rejecting floats avoids cross-runtime number
 * formatting disagreements in agreement hashes.
 */
export function canonicalMarketplaceJson(value: unknown): string {
  return canonicalize(value, "$", new Set<object>());
}

/**
 * Domain-separates commitments so identical JSON cannot be replayed as a
 * different marketplace document type.
 */
export function marketplaceDocumentHash(
  kind: MarketplaceCommitmentKind,
  value: unknown,
): Hex {
  if (!marketplaceCommitmentKinds.includes(kind)) {
    throw new Error("The marketplace commitment kind is invalid.");
  }
  const canonical = canonicalMarketplaceJson(value);
  return keccak256(
    stringToHex(
      `${INFLUENCEDX_MARKETPLACE_COMMITMENT_SCHEMA}|${kind}|${canonical}`,
    ),
  );
}

export const campaignTermsHash = (value: unknown): Hex =>
  marketplaceDocumentHash("campaign-terms", value);

export const creatorApplicationHash = (value: unknown): Hex =>
  marketplaceDocumentHash("creator-application", value);

export const assignmentAgreementHash = (value: unknown): Hex =>
  marketplaceDocumentHash("assignment-agreement", value);

export const submissionEvidenceHash = (value: unknown): Hex =>
  marketplaceDocumentHash("submission-evidence", value);

export const resolutionEvidenceHash = (value: unknown): Hex =>
  marketplaceDocumentHash("resolution-evidence", value);

export function normalizeBytes32(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHash(value)) {
    throw new Error(`${label} must be a 32-byte hash.`);
  }
  return value.toLowerCase() as Hex;
}

function canonicalize(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${path} must contain only safe integer numbers.`);
    }
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value !== "object") {
    throw new Error(`${path} contains a non-JSON marketplace value.`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${path} contains a circular marketplace value.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new Error(`${path}[${index}] is an array hole.`);
        }
        items.push(canonicalize(value[index], `${path}[${index}]`, ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain marketplace objects.`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(`${path} must not contain symbol keys.`);
    }

    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .map((key) => (
        `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`, ancestors)}`
      ));
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
