export type DatabaseFailure =
  | { kind: "configuration" }
  | { kind: "not_migrated"; postgresCode?: string }
  | { kind: "unavailable"; postgresCode?: string };

const missingSchemaCodes = new Set(["3F000", "42P01", "42704"]);

/**
 * Classifies nested Drizzle/Neon failures without copying queries, parameters,
 * connection strings, challenges, or signatures into logs and responses.
 */
export function classifyDatabaseFailure(
  error: unknown,
): DatabaseFailure | null {
  const visited = new Set<unknown>();
  let current: unknown = error;
  let postgresCode: string | undefined;
  let sawDatabaseFailure = false;

  for (let depth = 0; current && depth < 10; depth += 1) {
    if (visited.has(current)) break;
    visited.add(current);

    if (!(current instanceof Error) && typeof current !== "object") break;
    const record = current as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const message = typeof record.message === "string" ? record.message : "";
    const code = typeof record.code === "string" ? record.code : undefined;

    if (name === "DatabaseConfigurationError") {
      return { kind: "configuration" };
    }
    if (message.toLowerCase().includes("no such table")) {
      return { kind: "not_migrated" };
    }
    if (code && missingSchemaCodes.has(code)) {
      return { kind: "not_migrated", postgresCode: code };
    }

    if (code && /^[0-9A-Z]{5}$/.test(code)) {
      postgresCode ??= code;
      sawDatabaseFailure = true;
    }
    if (
      name === "NeonDbError" ||
      (typeof record.query === "string" && Array.isArray(record.params))
    ) {
      sawDatabaseFailure = true;
    }

    current = record.cause;
  }

  return sawDatabaseFailure
    ? { kind: "unavailable", postgresCode }
    : null;
}
