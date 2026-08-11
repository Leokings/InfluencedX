# Neon cutover for InfluencedX verification state

This records the storage boundary used to move the InfluencedX verification API from
Cloudflare D1 to Vercel-managed Neon Postgres. The Vercel runtime now uses this
schema. It deliberately preserves the
existing state machine, millisecond epoch values, optimistic `revision` updates,
expiry behavior (including `READY_FOR_GENLAYER` expiring at credential expiry),
and nullable-unique semantics.

## Runtime adapter

Install `@neondatabase/serverless` and use Drizzle's Neon HTTP adapter. Keep
initialization lazy: Vercel evaluates server modules while building, before a
Marketplace database is necessarily attached. Do not wrap the database in a
JavaScript `Proxy`.

```ts
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./postgres-schema";

function createDb(databaseUrl: string) {
  return drizzle(neon(databaseUrl), { schema });
}

let cachedUrl: string | undefined;
let cachedDb: ReturnType<typeof createDb> | undefined;

export function getDb() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is unavailable.");
  }
  if (!cachedDb || cachedUrl !== databaseUrl) {
    cachedDb = createDb(databaseUrl);
    cachedUrl = databaseUrl;
  }
  return cachedDb;
}
```

Use Vercel Marketplace Neon so `DATABASE_URL` is injected into Preview and
Production. Never expose it as a `NEXT_PUBLIC_*` value. The server routes must
use the Node.js runtime, because `@neondatabase/serverless` 1.x requires Node 19
or newer. InfluencedX already requires Node 22.

The active service's `cloudflare:workers` environment import must also be
replaced with server-only `process.env` reads for the Base RPC and contract
addresses. That is a platform migration concern, not a database semantic
change.

## Schema migration

Run `drizzle-kit migrate --config drizzle.config.ts` with `DATABASE_URL` set to
the dedicated Neon database. The checked-in migration journal and snapshot make
the baseline the first tracked Postgres migration, and the Postgres migrator
applies pending migrations transactionally. Do not run migrations from a Vercel
request handler or split them across independent Neon HTTP calls.

The Postgres baseline adds only invariants already maintained by the D1 service:

- one non-expired request per authenticated owner;
- active owner and active wallet are set or cleared together;
- the active owner/wallet match the immutable owner/wallet columns;
- expired rows release the active-owner uniqueness slot;
- intent signature status matches its verification state;
- revisions cannot be negative.

The partial owner/expiry index uses `status <> 'EXPIRED'`, which exactly matches
the stale-cleanup predicate. Using `active_owner_user_id IS NOT NULL` would be
logically equivalent under the checks but is less reliably recognized by the
Postgres planner.

All epoch values are `bigint`, not Postgres `integer`: current millisecond values
are around 1.8 trillion and overflow int4. Drizzle maps these columns to safe
JavaScript numbers.

## Existing D1 rows

Do not assume D1 is empty. A cross-database switch cannot be atomic by SQL alone,
so use a short write pause:

`owner_user_id` in the D1 rows is a ChatGPT Sites authentication subject. A
Vercel wallet-session subject is not automatically the same identity. For a
non-empty production dataset, preserve the old subject behind an explicit
identity-link record that is established by a new wallet signature. If the
current rows are test-only, archive the signed snapshot and make their deletion
an explicit cutover decision. Never rewrite `owner_user_id` to `wallet` as an
unreviewed bulk transform.

1. Deploy a maintenance/read-only version of the old app.
2. Export a consistent D1 snapshot, including every column in table order.
3. Apply the Neon baseline in one transaction.
4. Load the export into a temporary Neon table shaped like
   `verification_requests`, without custom check constraints.
5. In one `SERIALIZABLE` transaction, lock the destination, validate the staging
   rows, insert them without `ON CONFLICT`, compare row counts, and commit.
6. Point the Vercel deployment at Neon and run read-only verification before
   reopening writes. Keep D1 read-only until rollback is no longer needed.

The atomic import transaction is:

```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;
LOCK TABLE verification_requests IN ACCESS EXCLUSIVE MODE;

-- Populate this temporary table from the frozen D1 export before the INSERT.
-- It must use the same column names and Postgres data types as the destination,
-- but it must not inherit destination indexes or custom check constraints.
CREATE TEMP TABLE verification_requests_d1_import
  (LIKE verification_requests INCLUDING DEFAULTS)
  ON COMMIT DROP;

-- COPY verification_requests_d1_import (<all columns in schema order>)
-- FROM STDIN WITH (FORMAT csv, HEADER true);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM verification_requests_d1_import
    GROUP BY id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'D1 import has duplicate request ids';
  END IF;

  IF EXISTS (
    SELECT 1 FROM verification_requests_d1_import
    WHERE active_owner_user_id IS NOT NULL
    GROUP BY active_owner_user_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'D1 import has multiple active requests for one owner';
  END IF;

  IF EXISTS (
    SELECT 1 FROM verification_requests_d1_import
    WHERE finalized_request_id IS NOT NULL
    GROUP BY finalized_request_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'D1 import has duplicate finalized request ids';
  END IF;

  IF EXISTS (
    SELECT 1 FROM verification_requests_d1_import
    WHERE
      (active_owner_user_id IS NULL) <> (active_wallet IS NULL)
      OR (active_owner_user_id IS NOT NULL AND active_owner_user_id <> owner_user_id)
      OR (active_wallet IS NOT NULL AND active_wallet <> wallet)
      OR (status = 'EXPIRED' AND active_owner_user_id IS NOT NULL)
      OR (status <> 'EXPIRED' AND active_owner_user_id IS NULL)
      OR revision < 0
  ) THEN
    RAISE EXCEPTION 'D1 import violates the verification state invariants';
  END IF;
END $$;

INSERT INTO verification_requests
SELECT * FROM verification_requests_d1_import;

DO $$
DECLARE
  source_count bigint;
  destination_count bigint;
BEGIN
  SELECT count(*) INTO source_count
    FROM verification_requests_d1_import;
  SELECT count(*) INTO destination_count
    FROM verification_requests;
  IF source_count <> destination_count THEN
    RAISE EXCEPTION 'row count mismatch: source %, destination %',
      source_count, destination_count;
  END IF;
END $$;

COMMIT;
```

For a non-empty destination, compare against a pre-import destination count or
require it to be empty before inserting. Plain `INSERT` is intentional: conflict
suppression would hide lost or duplicated verification records.

## Required verification

Run these against a disposable Postgres database or Neon branch before touching
Production:

1. Apply the baseline twice; the second attempt must fail safely without
   changing the first schema (the migration ledger, not `IF NOT EXISTS`, owns
   idempotency).
2. Round-trip millisecond values above `2,147,483,647` and confirm
   `toProjection()` produces the same ISO strings as D1.
3. Run at least 20 concurrent create requests for one owner. Exactly one row may
   retain `active_owner_user_id`; callers must receive the winning request or a
   controlled conflict.
4. Race every state transition with the same revision. Exactly one update may
   return a row; replays must take the `STATE_CHANGED` path.
5. Expire requests in every non-expired state, including
   `READY_FOR_GENLAYER`; confirm active fields are cleared and a replacement
   request can be created.
6. Confirm different owners cannot read or mutate one another's requests.
7. Confirm nullable unique indexes permit many `NULL` values but reject duplicate
   non-null active owners and finalized request ids.
8. Confirm unknown enum values, mismatched active fields, negative revisions,
   and invalid status/signature combinations are rejected.
9. Import a frozen D1 snapshot, compare row counts and a deterministic hash of
   every row, then replay status reads against both databases.
10. Build without `DATABASE_URL` to prove lazy initialization works; at runtime,
    a missing URL must fail closed and never fall back to in-memory state.
11. Use `EXPLAIN (ANALYZE, BUFFERS)` for latest-by-owner, active-by-owner,
    owner/status, and stale-owner queries and confirm the intended indexes are
    selected at representative volume.
12. Exercise a simulated database outage during every transition. No transition
    may be acknowledged unless its `UPDATE ... WHERE status/revision ...
    RETURNING` committed.

Finally, schedule expiry/purge work independently of user traffic. The current
service only cleans stale rows when a user starts or reads a verification, so
abandoned challenges can otherwise retain raw challenge text indefinitely.
