import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const migrationDirectory = resolve("migrations");
const migrationFiles = (await readdir(migrationDirectory))
  .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
  .sort();
if (migrationFiles.length === 0) throw new Error("No StudioNet submitter migrations were found.");
const client = new pg.Client({ connectionString: databaseUrl });
try {
  await client.connect();
  for (const name of migrationFiles) {
    await client.query(await readFile(resolve(migrationDirectory, name), "utf8"));
  }
  process.stdout.write("StudioNet submitter schema is current.\n");
} finally {
  await client.end();
}
