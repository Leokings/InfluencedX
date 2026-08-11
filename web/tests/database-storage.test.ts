import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  DatabaseConfigurationError,
  getNeonDb,
} from "../db/neon.ts";
import {
  ownershipAuthorizationGrants,
  verificationRateLimits,
  verificationRequests,
} from "../db/postgres-schema.ts";
import { classifyDatabaseFailure } from "../lib/database-error.ts";

test("Neon initialization is lazy and fails closed without a Postgres URL", () => {
  const previous = process.env.DATABASE_URL;
  try {
    delete process.env.DATABASE_URL;
    assert.throws(() => getNeonDb(), DatabaseConfigurationError);

    process.env.DATABASE_URL = "https://not-a-postgres-database.example";
    assert.throws(() => getNeonDb(), DatabaseConfigurationError);
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("Postgres schema keeps millisecond epochs in bigint columns", () => {
  const table = getTableConfig(verificationRequests);
  const epochColumns = [
    "status_updated_at",
    "request_expires_at",
    "wallet_challenge_expires_at",
    "wallet_authorized_at",
    "x_challenge_issued_at",
    "x_challenge_expires_at",
    "credential_expires_at",
    "verification_post_created_at",
    "intent_prepared_at",
    "ready_for_genlayer_at",
    "sealed_evidence_expires_at",
    "sealed_evidence_purged_at",
    "submission_status_updated_at",
    "submission_attempts",
    "submission_last_attempt_at",
    "submission_response_updated_at",
    "genlayer_submitted_at",
    "genlayer_last_polled_at",
    "genlayer_finalized_at",
    "base_relay_updated_at",
    "base_confirmed_at",
    "base_profile_expires_at",
    "purged_at",
    "created_at",
    "updated_at",
  ];

  for (const name of epochColumns) {
    const column = table.columns.find((candidate) => candidate.name === name);
    assert.ok(column, `missing ${name}`);
    assert.equal(column.getSQLType(), "bigint", `${name} must not use int4`);
  }
});

test("Postgres schema pins uniqueness, cleanup, and lifecycle invariants", () => {
  const table = getTableConfig(verificationRequests);
  const indexes = new Set(table.indexes.map((index) => index.config.name));
  const checks = new Set(table.checks.map((check) => check.name));

  assert.ok(indexes.has("verification_requests_one_active_owner_idx"));
  assert.ok(indexes.has("verification_requests_finalized_request_idx"));
  assert.ok(indexes.has("verification_requests_owner_active_expiry_idx"));
  assert.ok(checks.has("verification_requests_active_pair"));
  assert.ok(checks.has("verification_requests_expiry_state"));
  assert.ok(checks.has("verification_requests_intent_state"));
  assert.ok(checks.has("verification_requests_submission_attempts_nonnegative"));
  assert.ok(checks.has("verification_requests_submission_outcome"));
  assert.ok(checks.has("verification_requests_sealed_evidence_pair"));
  assert.ok(checks.has("verification_requests_base_confirmation_state"));
  assert.ok(indexes.has("verification_requests_base_relay_status_idx"));
  assert.ok(indexes.has("verification_requests_base_relay_tx_idx"));
});

test("ownership authorization grants are digest-only, short-lived, and single-use", () => {
  const table = getTableConfig(ownershipAuthorizationGrants);
  const columns = new Set(table.columns.map((column) => column.name));
  const checks = new Set(table.checks.map((check) => check.name));
  assert.deepEqual([...columns].sort(), [
    "base_receiver_address",
    "base_registry_address",
    "consumed_at",
    "consumer_key_fingerprint",
    "created_at",
    "expected_wallet",
    "expires_at",
    "genlayer_tx_hash",
    "request_id",
    "resolver_address",
    "token_hash",
  ]);
  assert.equal(columns.has("token"), false);
  assert.equal(columns.has("ownership_signature"), false);
  assert.ok(checks.has("ownership_authorization_grants_token_hash_format"));
  assert.ok(checks.has("ownership_authorization_grants_short_lived"));
  assert.ok(checks.has("ownership_authorization_grants_consumption_pair"));
});

test("rate-limit schema stores only bounded HMAC counters with atomic keys", () => {
  const table = getTableConfig(verificationRateLimits);
  const columns = new Set(table.columns.map((column) => column.name));
  const checks = new Set(table.checks.map((check) => check.name));
  const primaryKey = table.primaryKeys.find(
    (key) => key.getName() === "verification_rate_limits_policy_bucket_pk",
  );

  assert.deepEqual(
    [...columns].sort(),
    [
      "bucket_hash",
      "created_at",
      "policy_key",
      "request_count",
      "request_limit",
      "updated_at",
      "window_expires_at",
      "window_started_at",
    ],
  );
  assert.ok(primaryKey);
  assert.deepEqual(
    primaryKey.columns.map((column) => column.name),
    ["policy_key", "bucket_hash"],
  );
  assert.ok(checks.has("verification_rate_limits_bucket_hash_format"));
  assert.ok(checks.has("verification_rate_limits_window_order"));
  assert.ok(checks.has("verification_rate_limits_positive_counts"));
  assert.ok(
    table.indexes.some(
      (index) => index.config.name === "verification_rate_limits_expiry_idx",
    ),
  );
});

test("database failures are classified through nested driver causes", () => {
  const missingRelation = Object.assign(new Error("relation is missing"), {
    code: "42P01",
  });
  const wrappedMissingRelation = Object.assign(new Error("Failed query"), {
    query: "select redacted",
    params: [],
    cause: missingRelation,
  });
  assert.deepEqual(classifyDatabaseFailure(wrappedMissingRelation), {
    kind: "not_migrated",
    postgresCode: "42P01",
  });

  const connectionFailure = Object.assign(new Error("connection failed"), {
    name: "NeonDbError",
    code: "08006",
  });
  assert.deepEqual(classifyDatabaseFailure(connectionFailure), {
    kind: "unavailable",
    postgresCode: "08006",
  });

  assert.equal(classifyDatabaseFailure(new Error("ordinary failure")), null);
});
