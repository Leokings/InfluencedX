import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./postgres-schema.ts";

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

function createDb(databaseUrl: string) {
  return drizzle(neon(databaseUrl), { schema });
}

export type NeonDatabase = ReturnType<typeof createDb>;

let cachedDatabaseUrl: string | undefined;
let cachedDb: NeonDatabase | undefined;

/**
 * Lazily creates the Neon HTTP client.
 *
 * Next evaluates imported server modules during builds, when Marketplace
 * environment variables may not have been attached yet. Keeping all URL access
 * inside this function lets `next build` succeed while still failing closed on
 * the first database-backed request if DATABASE_URL is absent.
 */
export function getNeonDb(): NeonDatabase {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new DatabaseConfigurationError("DATABASE_URL is unavailable.");
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new DatabaseConfigurationError("DATABASE_URL is invalid.");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname
  ) {
    throw new DatabaseConfigurationError(
      "DATABASE_URL must be a Postgres connection URL.",
    );
  }

  if (!cachedDb || cachedDatabaseUrl !== databaseUrl) {
    cachedDb = createDb(databaseUrl);
    cachedDatabaseUrl = databaseUrl;
  }
  return cachedDb;
}
