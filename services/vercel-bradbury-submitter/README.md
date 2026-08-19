# InfluencedX Vercel StudioNet submitter

This is a separate, StudioNet-only Vercel service that accepts exact InfluencedX
ownership, campaign-resolution, and creator-metrics envelopes and submits only
their three allowlisted Intelligent Contract calls to GenLayer StudioNet. It is
source code only: it has not been linked, deployed, migrated, funded, or given
secrets.

## Fixed trust boundary

The caller cannot choose transaction controls. The only state-changing calls are:

```text
stage:    studionet
network:  studionet
chain ID: 61999
RPC:      https://studio.genlayer.com/api
resolver: 0x0913b5593Ff16974E2fd616cA678A4986Cb48600
deploy tx: 0xc723b84f49e6842419ac926808d962c4611678b02fbb5b1b1cdba6fe94920591
methods:  verify_ownership | resolve_submission | snapshot_metrics
args:     the exact schema-bound arguments for the selected envelope kind
value:    0
```

Configuration fails closed unless the enable flag is exactly `true`, the stage
is `studionet`, the network, chain ID, and resolver match those constants, the database is
PostgreSQL, a non-zero 32-byte signer key exists, and every expected caller
identity field is configured. The signer key belongs only in this separate
Vercel project; it must never be added to the InfluencedX web project.

## Request path

1. The public ingress verifies a short-lived Vercel OIDC JWT. It checks RS256,
   the team issuer, audience, exact subject, and all of `owner`, `owner_id`,
   `project`, `project_id`, and `environment`. There is no long-lived shared
   bearer token.
2. The ingress rejects extra JSON fields, recomputes the APV2 request ID, checks
   the challenge/credential windows and X snowflake timestamp, creates an
   idempotent database job, sends a small request-ID-only queue message, and
   returns `202` without waiting for StudioNet.
3. Vercel Queues invokes the push consumer. `vercel.json` makes that consumer
   air-gapped: Vercel documents that it has no public URL and only queue
   infrastructure can invoke it.
4. The consumer performs a resolver precheck, acquires the durable signer gate,
   records `BROADCASTING`, sends the pinned zero-value call, stores its hash,
   and polls via delayed queue messages.
5. A finalized lifecycle is accepted only when execution is
   `FINISHED_WITH_RETURN`, the receipt binds the exact hash, signer, resolver,
   value, method and eight arguments, and `get_result` at latest-final returns a
   valid ownership result for the same request ID.

Queues provide at-least-once delivery, not exactly-once execution. Queue
idempotency keys are defense in depth. The authoritative nonce boundary is the
single `xproof_bradbury_signer_gate` row with a monotonically increasing
fencing token. Precheck leases may expire safely because they cannot broadcast.
`BROADCASTING` never expires. If the process crashes or receives an ambiguous
RPC error after that transition, the request becomes
`RECONCILIATION_REQUIRED` and the signer remains blocked for every request
until an operator reconciles it. Automatic resubmission is forbidden.

## Private API contract

The API route is available at both the native Next path and its `/v1` rewrite:

```text
POST /api/v1/ownership-submissions
GET  /api/v1/ownership-submissions/:requestId
POST /api/v1/campaign-submissions
GET  /api/v1/campaign-submissions/:requestId
POST /api/v1/metrics-submissions
GET  /api/v1/metrics-submissions/:requestId
POST /v1/ownership-submissions
GET  /v1/ownership-submissions/:requestId
POST /v1/campaign-submissions
GET  /v1/campaign-submissions/:requestId
POST /v1/metrics-submissions
GET  /v1/metrics-submissions/:requestId
```

Every request requires:

```http
Authorization: Bearer <the calling InfluencedX function's Vercel OIDC JWT>
```

The web function should forward its runtime `x-vercel-oidc-token` header only
server to server. It must never return that token to the browser or persist it.

The POST body has exactly these fields:

```json
{
  "schemaVersion": 1,
  "requestId": "0x<64 lowercase hex characters>",
  "baseWallet": "0x<40 hex characters>",
  "expectedHandle": "creator_handle",
  "postId": "<decimal X post ID>",
  "challenge": "APV2-<24 base64url characters>",
  "issuedAtEpoch": 0,
  "expiresAtEpoch": 0,
  "credentialExpiresAtEpoch": 0
}
```

New requests return `202`; an existing request returns `200`. Both use:

```json
{
  "replayed": false,
  "submission": {
    "requestId": "0x...",
    "network": "studionet",
    "resolver": "0x0913b5593ff16974e2fd616ca678a4986cb48600",
    "status": "QUEUED",
    "lifecycleStatus": null,
    "executionResult": null,
    "resultOutcome": null,
    "txHash": null,
    "queueMessageId": "msg_...",
    "enqueueAttempts": 1,
    "deliveryCount": 0,
    "pollAttempts": 0,
    "errorCode": null,
    "broadcastStartedAt": null,
    "submittedAt": null,
    "lastPolledAt": null,
    "finalizedAt": null,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

## Shared Neon status contract

Run `migrations/0001_bradbury_submissions.sql`,
`migrations/0002_campaign_submissions.sql`,
`migrations/0003_metrics_submissions.sql`, and
`migrations/0004_studionet_cutover.sql`, in that order, on the dedicated
InfluencedX submitter database used by the corresponding web environment.

The first migration retains its historical filename and table names. Migration
0004 changes the defaults for new rows to the coupled StudioNet network/resolver
pair while allowing the coupled historical Bradbury pair for existing records.
Mixed network/resolver pairs are rejected.

- `xproof_bradbury_submission_status` is a safe request-ID-keyed projection for
  DB-only web polling.
- `xproof_bradbury_submission_jobs` contains the temporary validated envelope.
  The consumer clears `envelope_json` after submission or terminal quarantine.
- `xproof_bradbury_signer_gate` is service-private serialization state.

Use separate database roles in production. The web role should receive only
`SELECT` on `xproof_bradbury_submission_status` (plus its own application
tables). It must have no rights on jobs or the signer gate. The submitter role
needs read/write access to all three submitter tables.

## Local verification

```powershell
npm install
npm run lint
npm test
npm run build
npm audit --omit=dev
```

No test reads a real secret, calls StudioNet, connects to Neon, sends a real
queue message, or deploys anything.

## Deployment prerequisites and order

1. Create a **new Vercel project** with this directory as its Root Directory.
   Do not add this code to the public InfluencedX project.
2. Create dedicated Preview and Production Neon branches. Apply all four
   service migrations in order and provision least-privilege submitter/web
   database roles.
3. In the InfluencedX caller project, enable Vercel Secure Backend Access with the
   recommended **Team issuer mode**. Record the exact team slug/ID and caller
   project name/ID. Do not guess them.
4. Configure each submitter environment using `.env.example`. Scope Preview to
   the Preview database and `XPROOF_CALLER_ENVIRONMENT=preview`; scope
   Production to its own database and `production`.
5. Create a dedicated low-balance StudioNet account. Store
   `GENLAYER_SUBMITTER_PRIVATE_KEY` as a sensitive Vercel secret only in this
   project. Do not reuse a Base owner, treasury, watcher, relayer, browser, or
   team wallet.
6. Deploy first with `XPROOF_SUBMITTER_ENABLED=false`. Confirm the public API is
   fail-closed and the queue consumer is not publicly addressable.
7. Enable **Preview only**, redeploy, submit one controlled APV2 request, and
   independently verify the transaction hash, sender, resolver, the signer's
   hard-coded zero-value call, decoded method/arguments, execution result, and
   latest-final resolver result. StudioNet's `genlayer-js` consensus receipt
   currently omits the outer EVM `value` field, so absence of that receipt
   field is not itself an error; if the SDK exposes it, it must equal zero.
8. Add alerts for `RECONCILIATION_REQUIRED`, `EXECUTION_FAILED`,
   `POLLING_EXHAUSTED`, `POISONED`, a non-null signer gate older than its normal
   window, and increasing Queue Max Message Age. Keep Production disabled until
   those checks pass.

### Operator reconciliation

Inspect a blocked gate with a read-only query:

```sql
SELECT gate_name, fencing_token, active_request_id, phase, acquired_at, updated_at
FROM xproof_bradbury_signer_gate
WHERE gate_name = 'bradbury-signer-v1';
```

Never release a `BROADCASTING` gate based only on age. First establish whether
the historical Bradbury network accepted the call, record/verify its transaction and account nonce,
and resolve the request. Only then may an operator clear the singleton gate in
one reviewed SQL transaction. There is deliberately no public "unlock" or
arbitrary transaction endpoint.

The historical Bradbury Preview incident caused by `genlayer-js` omitting
`value` from its consensus receipt has a narrowly scoped operator command. It accepts only a
`RECONCILIATION_REQUIRED` row whose error is exactly
`TRANSACTION_VALUE_MISSING`, verifies the saved hash, signer, resolver, method,
and all eight arguments, and remains read-only until the transaction is
terminal. A second run with the exact printed confirmation atomically updates
the submitter projection and its one owning verification row. It never has a
private key and cannot broadcast or clear a non-empty signer gate.

## Vercel Queues beta caveat

This service pins `@vercel/queue` exactly to `0.4.0` and uses the documented
`queue/v2beta` push trigger. Vercel Queues is currently public beta. The current
0.4.0 callback API and documented `vercel.json` trigger fields do **not** expose
a code-level `maxConcurrency` option, even though Vercel documents max
concurrency for push consumer groups. If the project dashboard/API exposes that
control at deployment time, set the consumer group to `1` and verify it in
Queues observability. Do not add an undocumented trigger property. The service
does not rely on that setting: the PostgreSQL fencing gate remains the primary
account-wide serialization boundary.

Queue topics are partitioned by deployment ID in push mode, delivery is
at-least-once, ordering is approximate, and there is no built-in DLQ. Poisoned
messages are acknowledged explicitly after safe database classification;
transient failures retry until retention expires. Review Vercel's beta release
notes and the installed SDK types before every dependency upgrade.
