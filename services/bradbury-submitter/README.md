# InfluencedX private Bradbury submitter

This directory contains a validated Cloudflare Durable Object alternative for a
testnet-only boundary that may submit an already
wallet-authorized APV2 ownership envelope to GenLayer Bradbury. It is designed
as a Cloudflare Worker service binding backed by one Durable Object per APV2
request ID.

It is **local code only** today. It has not been deployed, funded, given a real
secret, or bound to the public InfluencedX Worker. The public
`/api/verification/submit` route must remain fail-closed until the deployment
and binding gates below have all passed.

## Fixed trust boundary

The service accepts exactly one state-changing operation:

```text
network:  testnet-bradbury
resolver: 0x017311b35dbB9802883bDaE7Fb0Efd7Bd77cB0b2
method:   verify_ownership
args:     the eight APV2 ownership fields in protocol order
value:    0
```

Callers cannot supply a network, RPC URL, resolver, function name, transaction
value, or arbitrary arguments. The request validator rejects extra JSON fields,
recomputes the APV2 SHA-256 request ID, checks the X snowflake publication time,
and enforces the same challenge and credential windows as the resolver.

The entry Worker requires a private bearer token even when called through a
service binding. Configuration also fails closed unless the enable switch,
testnet stage, Bradbury network, and pinned resolver are set exactly. The RPC
URL is compiled as the official Bradbury endpoint rather than accepted from a
request or environment variable.

The active deployment path is the separate Vercel submitter under
`services/vercel-bradbury-submitter`; this implementation remains useful as an
independent protocol and concurrency reference, but is not reachable from the
Vercel web app while `workers_dev = false` and no custom route exists.

## Idempotency, signer serialization, and polling

The request ID chooses the Durable Object, which serializes operations and
persists a single submission record. Before broadcasting, the service reads
`get_result(requestId)` from Bradbury. A duplicate POST returns the persisted
transaction instead of sending another transaction.

Every request object delegates its state-changing call to a second Durable
Object addressed by the fixed name `bradbury-signer-v1`. That singleton
serializes all requests sharing the Bradbury account, preventing distinct
request IDs from racing the account nonce. Receipt reconciliation also requires
the resolver, method, and all eight decoded arguments to be present and to
match the stored SHA-256 call fingerprint; missing call data is quarantined.

There is an unavoidable distributed-systems gap if the RPC accepts a broadcast
but the connection closes before returning its transaction hash. In that case
the record becomes `RECONCILIATION_REQUIRED`; it is never automatically
resubmitted. An operator must establish the original transaction hash before
continuing. The same quarantine applies to a mismatched resolver, method,
request ID, or finalized result.

After a known transaction hash is stored, Durable Object alarms poll Bradbury.
`FINALIZED` is treated as successful only when execution is
`FINISHED_WITH_RETURN` and the latest-final resolver result is valid ownership
JSON for the same request ID. `VERIFIED`, `REJECTED`, and `UNDETERMINED` remain
distinct resolver outcomes. Lifecycle finality alone is never reported as
execution success.

## Private API

Every request requires:

```http
Authorization: Bearer <XPROOF_SUBMITTER_SHARED_SECRET>
```

- `GET /healthz` — pinned non-secret configuration only.
- `POST /v1/ownership-submissions` — validate and idempotently submit one APV2
  envelope.
- `GET /v1/ownership-submissions/:requestId` — read persisted status.
- `POST /v1/ownership-submissions/:requestId/poll` — operator-triggered fixed
  transaction poll; it cannot broadcast.

Example submission body:

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

## Deployment gates

1. Create a dedicated Bradbury submitter account. Do not reuse the owner,
   treasury, watcher, Base relayer, or browser wallet. Keep only the minimum GEN
   operational balance on it.
2. Review `wrangler.toml` against `wrangler.toml.example`. Confirm it has no
   public route and `workers_dev = false`.
3. Store `GENLAYER_SUBMITTER_PRIVATE_KEY` and a separately generated
   `XPROOF_SUBMITTER_SHARED_SECRET` in Cloudflare's encrypted secret store. Never
   put either value in Wrangler variables, source, logs, D1, or Durable Object
   storage.
4. Run `npm run test:submitter`, then deploy the private Worker by an approved
   release workflow.
5. Call private `healthz`, submit a controlled APV2 test, and independently
   verify its resolver, decoded method, first argument, execution result, and
   latest-final result on Bradbury.
6. Configure alarms/observability for `RECONCILIATION_REQUIRED`,
   `EXECUTION_FAILED`, and `POLLING_EXHAUSTED`. Logs must contain request IDs and
   transaction hashes only—not authorization tokens, private keys, or complete
   challenge bodies.
7. Only after those checks, add a Cloudflare service binding from the trusted
   InfluencedX backend and inject the same bearer token there. Update the application
   database transition atomically from `READY_FOR_GENLAYER` to its submitted
   state. Until then, leave the public submit route unchanged and unavailable.

The example Wrangler file intentionally contains public testnet identifiers
only. No secret material is created or read by the test suite.
