# InfluencedX web

The responsive marketplace interface for InfluencedX: an X-only creator market with
campaign payments on Base and public-work resolution on GenLayer.

The deployed ownership protocol still uses the compatibility identifiers
`XProof v2`, `XProofAttestationReceiver`, and `XPROOF_*`. Do not rename them
without a coordinated contract and proof-protocol migration.

## Commands

```bash
npm install
npm run dev
npm run build
npm test
npm run db:migrate
npm run db:verify
```

## Runtime

- Native Next.js App Router on Vercel.
- Neon Postgres with a Drizzle-managed verification state machine.
- Server-signed, host-only wallet sessions; no X OAuth or trusted client identity
  headers.
- Ownership intents target the deployed Base Sepolia receiver and the APV2
  resolver on GenLayer Bradbury.
- GenLayer submission uses a separate, OIDC-authenticated service that accepts
  only the fixed ownership, campaign-resolution, and metrics Bradbury calls.
  The bridge remains fail-closed
  unless its explicit enable flag, HTTPS origin, evidence keyring, and Vercel
  OIDC token are all available.

Copy `.env.example` for local development. Keep `DATABASE_URL` and
`AUTH_SECRET` server-only; never prefix them with `NEXT_PUBLIC_`. Vercel previews
derive their exact request origin from trusted deployment variables. Production
requires an explicit `XPROOF_APP_ORIGIN` before mutation routes will accept
requests. Deployed mutation routes also require
`XPROOF_VERIFICATION_MUTATIONS_ENABLED=true`; leave it false until rate limiting
and the private submitter boundary have been validated for that environment.
Marketplace writes have an independent fail-closed gate:
`XPROOF_MARKETPLACE_MUTATIONS_ENABLED=true`. Enable it on Preview only while
Base Sepolia campaign funding and receipt confirmation are being exercised;
Production must remain false until the final cutover review.

## Sealed evidence and submission

`prepare` removes the raw X challenge from the verification row and stores one
AES-256-GCM ciphertext instead. Its authenticated data binds the database row,
wallet-session subject, wallet, finalized APV2 request ID, token version, and
key ID. `authorize` recovers that ciphertext server-side, verifies the EIP-712
signature, and reseals the exact challenge plus the raw signature needed by the
later Base receiver relay. A lost tab or browser therefore does not destroy a
valid signed flow, while neither value is plaintext at rest.

Configure `XPROOF_SUBMISSION_ACTIVE_SEAL_KEY_ID` and a JSON object in
`XPROOF_SUBMISSION_SEAL_KEYS`. Keep the retiring key in that object until every
credential sealed under it has expired or been relayed; removing it deliberately
makes those ciphertexts unrecoverable. Never put this keyring in a
`NEXT_PUBLIC_` variable.

The submit bridge requires `XPROOF_SUBMITTER_BRIDGE_ENABLED=true` and an exact
HTTPS origin in `XPROOF_SUBMITTER_URL`. It sends the short-lived Vercel OIDC JWT
as the sole `Authorization: Bearer` credential. The submitter validates the
exact team, project, environment, owner, issuer, and audience claims. Browser
status polling reads only `xproof_bradbury_submission_status`; it never calls
Bradbury and does not consume the three-per-hour funded-submit quota. The web
application must never read `xproof_bradbury_submission_jobs`.

The same short-lived JWT is sent in both `Authorization: Bearer <jwt>` for the
submitter's claim verification and `x-vercel-trusted-oidc-idp-token: <jwt>` for
Vercel Deployment Protection. Do not mint separate tokens for these headers or
replace either one with a long-lived service secret.

Apply Postgres migrations `0002_xproof_submitter_bridge.sql` and
`0003_bradbury_submission_store.sql` before enabling the bridge. Apply
`0004_base_relay_authorization.sql` before attempting Base relay; `db:verify`
now rejects a database missing any Base status column or the one-time grant
table. A
`FINALIZED/VERIFIED` Bradbury result is still not an active Base credential:
watcher quorum and a successful receiver transaction remain required.

For the Base Sepolia relay, configure `XPROOF_CREATOR_REGISTRY` and set
`XPROOF_AUTHORIZATION_BROKER_ENABLED=true` on Preview only. The broker still
rejects Production even if the flag is accidentally copied there. Its grant is
bound to one request, GenLayer transaction, resolver, Base receiver, registry,
wallet, ephemeral RSA public key, and a maximum 15-minute lifetime. Follow the
[one-shot broker runbook](docs/ownership-authorization-broker.md); never move
the raw token, RSA private key, or creator signature through argv, environment
variables, files, stdout, or logs.

The marketplace API persists campaign drafts, verified creator profiles,
applications, and Base Sepolia receipt-bound lifecycle transitions in Neon.
Campaigns remain in `funding` until an exact `CampaignCreated` transaction is
confirmed; selection, acceptance, evidence submission, and resolution requests
likewise update durable state only after their pinned escrow call and event are
verified. Apply `0005_influencedx_marketplace.sql` and
`0006_campaign_settlement_relay.sql` before enabling the Preview marketplace
mutation gate; the latter adds the durable, fenced watcher-quorum settlement
record used to reconcile the final Base transaction.

Creator metrics refresh is an owner-authenticated, empty-body marketplace
action. Before queueing `snapshot_metrics`, the server re-reads the active
profile from the pinned Base Sepolia registry and derives the X handle,
identity hash, request ID, and expiry itself. Only a sanitized finalized
GenLayer result is stored; raw X responses are not persisted and browsers
cannot supply counts, risk, or pay values. The isolated submitter must have its
`0003_metrics_submissions.sql` migration applied before this control is
enabled. No additional web schema migration is required because the metrics
snapshot table is already part of `0005_influencedx_marketplace.sql`.

Automatic campaign settlement is a separate server-only boundary. Configure
`XPROOF_CAMPAIGN_RELAY_BRIDGE_ENABLED=true`, an exact HTTPS coordinator origin
in `XPROOF_CAMPAIGN_RELAY_URL`, and the coordinator's distinct service token.
Once the durable Bradbury submitter reports FINALIZED, the web bridge sends
only its request ID through Vercel OIDC plus that service token. The coordinator
reloads every payout commitment itself; no browser-supplied outcome, assignment
ID, watcher signature, or transaction hash is trusted. Leave the bridge false
until three isolated watcher deployments, coordinator simulation, the
low-balance relayer policy, and migration 0006 have all been verified.

## Verification rate limits

Verification mutations use atomic Neon/Postgres fixed-window counters. Database
buckets are HMAC-SHA-256 digests under `XPROOF_RATE_LIMIT_SECRET`; raw client
IPs, wallets, session subjects, and request IDs are never written to the counter
table. On Vercel, only `x-vercel-forwarded-for` is accepted as the client-IP
boundary and comma-separated chains fail closed. This follows Vercel's request
header contract: <https://vercel.com/docs/headers/request-headers>.

A daily Vercel Cron invokes the bearer-protected cleanup route and removes
expired buckets in capped batches. Configure an independent 32-byte-or-longer
`CRON_SECRET` before deploying the schedule. A `capped: true` result means the
next run still has backlog and should be alerted on.

Throttled responses include `Retry-After` and the combined `RateLimit` /
`RateLimit-Policy` syntax from the May 2026 HTTPAPI Internet-Draft; those fields
are draft fields, not finalized RFC headers:
<https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers>.
