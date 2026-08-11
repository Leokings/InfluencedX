import { ApiProblem } from "./verification-api.ts";

const USDC_ATOMS_PATTERN = /^[1-9][0-9]{0,77}$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const WALLET_PATTERN = /^0x[0-9a-f]{40}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseUsdcAmount(value: unknown, field: string): string {
  if (typeof value !== "string" || !USDC_ATOMS_PATTERN.test(value)) {
    throw invalid(
      field,
      `${field} must be a canonical positive USDC atomic-unit string.`,
    );
  }
  const atoms = BigInt(value);
  if (atoms > MAX_UINT256) {
    throw invalid(field, `${field} exceeds the Base uint256 range.`);
  }
  return value;
}

export function formatUsdcAmount(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Stored USDC amount is invalid.");
  }
  return value;
}

export function usdcAtomsToDecimal(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Stored USDC amount is invalid.");
  }
  const atoms = BigInt(value);
  const whole = atoms / 1_000_000n;
  const fraction = (atoms % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function requireText(
  value: unknown,
  field: string,
  minLength: number,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw invalid(field, `${field} is required.`);
  }
  const normalized = value.trim();
  if (
    normalized.length < minLength ||
    normalized.length > maxLength ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint <= 8 ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        codePoint === 127
      );
    })
  ) {
    throw invalid(
      field,
      `${field} must contain ${minLength}-${maxLength} valid characters.`,
    );
  }
  return normalized;
}

export function requireStringList(
  value: unknown,
  field: string,
  options: { minItems: number; maxItems: number; maxItemLength: number },
): string[] {
  if (
    !Array.isArray(value) ||
    value.length < options.minItems ||
    value.length > options.maxItems
  ) {
    throw invalid(
      field,
      `${field} must contain ${options.minItems}-${options.maxItems} items.`,
    );
  }
  const normalized = value.map((item, index) =>
    requireText(item, `${field}[${index}]`, 1, options.maxItemLength),
  );
  if (new Set(normalized.map((item) => item.toLowerCase())).size !== normalized.length) {
    throw invalid(field, `${field} cannot contain duplicate items.`);
  }
  return normalized;
}

export function requireFutureDeadline(
  value: unknown,
  nowMs: number,
): number {
  if (typeof value !== "string" || value.length > 64) {
    throw invalid("deadline", "deadline must be an ISO-8601 timestamp.");
  }
  const deadline = Date.parse(value);
  const minimum = nowMs + 60 * 60 * 1_000;
  const maximum = nowMs + 365 * 24 * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(deadline) || deadline < minimum || deadline > maximum) {
    throw invalid(
      "deadline",
      "deadline must be between one hour and one year from now.",
    );
  }
  return deadline;
}

export function requireUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw invalid(field, `${field} is invalid.`);
  }
  return value.toLowerCase();
}

export function assertOptionalActorWallet(
  body: Record<string, unknown>,
  field: "brandWallet" | "creatorWallet",
  authenticatedWallet: string,
): void {
  const value = body[field];
  if (value === undefined) return;
  if (
    typeof value !== "string" ||
    !WALLET_PATTERN.test(value.toLowerCase()) ||
    value.toLowerCase() !== authenticatedWallet.toLowerCase()
  ) {
    throw new ApiProblem(
      409,
      "SESSION_WALLET_MISMATCH",
      `${field} must match the authenticated wallet session.`,
    );
  }
}

export function isoTime(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function invalid(field: string, message: string): ApiProblem {
  return new ApiProblem(400, "INVALID_REQUEST", message, {
    "X-Invalid-Field": field,
  });
}
