import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const directory = resolve("migrations");
const files = (await readdir(directory))
  .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
  .sort();
if (files.length === 0) throw new Error("No withdrawal reconciler migrations were found.");
const client = new pg.Client({ connectionString: databaseUrl });
try {
  await client.connect();
  for (const name of files) await client.query(await readFile(resolve(directory, name), "utf8"));
  process.stdout.write("GenLayer withdrawal reconciler schema is current.\n");
} finally {
  await client.end();
}
