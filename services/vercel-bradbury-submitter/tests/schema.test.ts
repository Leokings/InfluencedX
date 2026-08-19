import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../migrations/0001_bradbury_submissions.sql", import.meta.url), "utf8");
const campaignMigration = await readFile(new URL("../migrations/0002_campaign_submissions.sql", import.meta.url), "utf8");
const metricsMigration = await readFile(new URL("../migrations/0003_metrics_submissions.sql", import.meta.url), "utf8");
const studioNetMigration = await readFile(new URL("../migrations/0004_studionet_cutover.sql", import.meta.url), "utf8");
const vercelConfig = await readFile(new URL("../vercel.json", import.meta.url), "utf8");
const queuePublisher = await readFile(new URL("../lib/queue-publisher.ts", import.meta.url), "utf8");

test("shared Neon schema exposes a safe requestId status projection and a separate private job table", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS xproof_bradbury_submission_status/);
  assert.match(migration, /request_id text PRIMARY KEY/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS xproof_bradbury_submission_jobs/);
  assert.match(migration, /envelope_json jsonb/);
  assert.match(migration, /COMMENT ON TABLE xproof_bradbury_submission_status/);
});

test("the signer gate has a fencing token and BROADCASTING cannot expire automatically", () => {
  assert.match(migration, /fencing_token bigint NOT NULL/);
  assert.match(migration, /phase = 'BROADCASTING' AND lease_expires_at IS NULL/);
  assert.match(migration, /BROADCASTING has no expiry/);
});

test("campaign migration allowlists only resolve_submission and campaign outcomes", () => {
  assert.match(campaignMigration, /function_name IN \('verify_ownership', 'resolve_submission'\)/);
  assert.match(campaignMigration, /'VERIFIED', 'REJECTED', 'PASS', 'FAIL', 'UNDETERMINED'/);
  assert.match(campaignMigration, /'agreementHash', 'submissionHash'/);
  assert.doesNotMatch(campaignMigration, /function_name\s+text|method_name|arbitrary/i);
});

test("metrics migration allowlists snapshot_metrics and stores only sanitized resolver results", () => {
  assert.match(metricsMigration, /'verify_ownership', 'resolve_submission', 'snapshot_metrics'/);
  assert.match(metricsMigration, /ADD COLUMN IF NOT EXISTS result_json jsonb/);
  assert.match(metricsMigration, /function_name = 'snapshot_metrics'/);
  assert.match(metricsMigration, /'followers'.*'engagement_consistency'/s);
  assert.doesNotMatch(metricsMigration, /raw_html|raw_json|caller_counts/i);
});

test("StudioNet cutover defaults new rows to the finalized resolver while preserving only coupled historical pairs", () => {
  assert.match(studioNetMigration, /ALTER COLUMN network SET DEFAULT 'studionet'/);
  assert.match(studioNetMigration, /ALTER COLUMN resolver SET DEFAULT '0x0913b5593ff16974e2fd616ca678a4986cb48600'/);
  assert.match(studioNetMigration, /xproof_bradbury_submission_status_network_resolver_check/);
  assert.match(studioNetMigration, /network = 'testnet-bradbury'[\s\S]+resolver = '0x017311b35dbb9802883bdae7fb0efd7bd77cb0b2'/);
  assert.match(studioNetMigration, /network = 'studionet'[\s\S]+resolver = '0x0913b5593ff16974e2fd616ca678a4986cb48600'/);
  assert.doesNotMatch(studioNetMigration, /network\s+IN|resolver\s+IN/);
});

test("the queue trigger uses a StudioNet-specific topic so legacy deliveries cannot reach this consumer", () => {
  assert.match(vercelConfig, /"topic": "influencedx-studionet-submissions-v1"/);
  assert.doesNotMatch(vercelConfig, /xproof-bradbury-ownership-v1/);
  assert.match(queuePublisher, /influencedx-studionet-submit:/);
  assert.match(queuePublisher, /influencedx-studionet-poll:/);
});
