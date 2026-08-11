import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../migrations/0001_bradbury_submissions.sql", import.meta.url), "utf8");
const campaignMigration = await readFile(new URL("../migrations/0002_campaign_submissions.sql", import.meta.url), "utf8");
const metricsMigration = await readFile(new URL("../migrations/0003_metrics_submissions.sql", import.meta.url), "utf8");

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
