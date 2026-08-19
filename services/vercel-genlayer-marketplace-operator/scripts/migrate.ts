import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";

const LEDGER_TABLE = "influencedx_marketplace_operator_migrations";
const ADVISORY_LOCK_KEY = "3488961350311019281";
const HISTORICAL_CHECKSUMS = Object.freeze<Record<string, string>>({
  "0001_marketplace_operator.sql": "7824a507bf026fa3c7d3ff78ba8276c273f921b7e4abac9bafbf7307ac6d2a09",
  "0002_identity_bundle_marketplace_address.sql": "6fa8ced69e21c4303bafec518f7d58b5242b12d634a5d3293112717fa08320c8",
});

type Migration = Readonly<{
  name: string;
  source: string;
  checksum: string;
}>;

type AppliedMigration = Readonly<{
  migration_name: string;
  checksum_sha256: string;
}>;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const directory = resolve("migrations");
const names = (await readdir(directory))
  .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
  .sort();
if (names.length === 0) throw new Error("No marketplace operator migrations were found.");

const migrations = await Promise.all(names.map(async (name): Promise<Migration> => {
  const bytes = await readFile(resolve(directory, name));
  return Object.freeze({
    name,
    source: bytes.toString("utf8"),
    checksum: createHash("sha256").update(bytes).digest("hex"),
  });
}));
assertHistoricalChecksums(migrations);

const client = new pg.Client({ connectionString: databaseUrl });
let lockHeld = false;
try {
  await client.connect();
  await client.query("SELECT pg_advisory_lock($1::bigint)", [ADVISORY_LOCK_KEY]);
  lockHeld = true;
  await createLedger(client);

  const appliedResult = await client.query<AppliedMigration>(
    `SELECT migration_name, checksum_sha256
       FROM ${LEDGER_TABLE}
      ORDER BY migration_name`,
  );
  assertAppliedPrefix(migrations, appliedResult.rows);
  if (appliedResult.rows.length === 0) await assertBootstrapSafe(client);

  for (const migration of migrations.slice(appliedResult.rows.length)) {
    await applyMigration(client, migration);
  }
  process.stdout.write("GenLayer marketplace operator schema is current.\n");
} finally {
  if (lockHeld) {
    try {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [ADVISORY_LOCK_KEY]);
    } catch {
      // Closing the session releases its advisory lock even if the connection failed.
    }
  }
  await client.end();
}

function assertHistoricalChecksums(migrations: readonly Migration[]): void {
  const byName = new Map(migrations.map((migration) => [migration.name, migration]));
  for (const [name, expected] of Object.entries(HISTORICAL_CHECKSUMS)) {
    const migration = byName.get(name);
    if (!migration || migration.checksum !== expected) {
      throw new Error(`Historical migration checksum mismatch for ${name}; refusing to continue.`);
    }
  }
}

function assertAppliedPrefix(
  migrations: readonly Migration[],
  applied: readonly AppliedMigration[],
): void {
  if (applied.length > migrations.length) {
    throw new Error("The marketplace operator migration ledger references a missing migration file.");
  }
  for (let index = 0; index < applied.length; index += 1) {
    const migration = migrations[index];
    const record = applied[index];
    if (!migration || record.migration_name !== migration.name) {
      throw new Error("Applied marketplace operator migrations are not an exact prefix of the migration files.");
    }
    if (record.checksum_sha256 !== migration.checksum) {
      throw new Error(`Applied migration checksum mismatch for ${migration.name}; refusing to continue.`);
    }
  }
}

async function createLedger(client: pg.Client): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
        migration_name text PRIMARY KEY CHECK (migration_name ~ '^\\d+_[a-z0-9_]+\\.sql$'),
        checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await client.query("COMMIT");
  } catch (error) {
    await rollback(client);
    throw error;
  }
}

async function assertBootstrapSafe(client: pg.Client): Promise<void> {
  const presence = await client.query<{
    status_table: string | null;
    jobs_table: string | null;
    gate_table: string | null;
  }>(`
    SELECT
      to_regclass(current_schema() || '.influencedx_marketplace_operator_status')::text AS status_table,
      to_regclass(current_schema() || '.influencedx_marketplace_operator_jobs')::text AS jobs_table,
      to_regclass(current_schema() || '.influencedx_marketplace_operator_signer_gate')::text AS gate_table
  `);
  const tables = Object.values(presence.rows[0] ?? {}).filter((value) => value !== null);
  if (tables.length === 0) return;
  if (tables.length !== 3) {
    throw new Error("Cannot bootstrap the marketplace operator ledger over a partial service schema.");
  }

  const safety = await client.query<{
    has_status_rows: boolean;
    has_job_rows: boolean;
    has_unsafe_gate: boolean;
  }>(`
    SELECT
      EXISTS (SELECT 1 FROM influencedx_marketplace_operator_status) AS has_status_rows,
      EXISTS (SELECT 1 FROM influencedx_marketplace_operator_jobs) AS has_job_rows,
      EXISTS (
        SELECT 1
          FROM influencedx_marketplace_operator_signer_gate
         WHERE gate_name <> 'influencedx-marketplace-operator-signer-v1'
            OR holder_id IS NOT NULL
            OR active_operation_id IS NOT NULL
            OR phase IS NOT NULL
            OR lease_expires_at IS NOT NULL
            OR acquired_at IS NOT NULL
      ) AS has_unsafe_gate
  `);
  const row = safety.rows[0];
  if (!row || row.has_status_rows || row.has_job_rows || row.has_unsafe_gate) {
    throw new Error(
      "Cannot bootstrap the marketplace operator migration ledger unless its work tables are empty and signer gate is idle.",
    );
  }
}

async function applyMigration(client: pg.Client, migration: Migration): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(withoutOuterTransaction(migration.source, migration.name));
    await client.query(
      `INSERT INTO ${LEDGER_TABLE} (migration_name, checksum_sha256) VALUES ($1, $2)`,
      [migration.name, migration.checksum],
    );
    await client.query("COMMIT");
  } catch (error) {
    await rollback(client);
    throw error;
  }
}

function withoutOuterTransaction(source: string, name: string): string {
  const match = /^\s*BEGIN;\s*([\s\S]*?)\s*COMMIT;\s*$/i.exec(source);
  if (!match) return source;
  const body = match[1];
  if (/(?:^|;)\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im.test(body)) {
    throw new Error(`Migration ${name} contains nested transaction control.`);
  }
  return body;
}

async function rollback(client: pg.Client): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the migration failure; closing the client cleans up the session.
  }
}
