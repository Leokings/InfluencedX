# InfluencedX web

The InfluencedX web application is the user and indexing layer for the
GenLayer-only Marketplace V2 product. It supports X and Farcaster creator
identity, native GEN campaigns, direct user-signed lifecycle writes, hosted
resolution progression, and reconciled native withdrawals.

The isolated V2 release has not yet replaced the existing public deployment.
Do not present a public URL as the V2 product until the E2E and cutover gates in
[`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) are complete.

## Active deployment

| Setting | Value |
| --- | --- |
| Network | GenLayer StudioNet |
| Chain ID | `61999` |
| Contract | `0xb72FE7272A5aEdf3c6Ba893394EbeF818fd86Fbb` |
| Deployment transaction | `0x05ff78998a2b389c7e102f6f09b893dbd16d376f3c18f9748b2b8ef9de5e7998` |
| Source SHA-256 | `0xcdb7a7126cb59705bddf8862c49d9ce6d49c9c18e792d4851c071ad403d10705` |
| Protocol / schema | `INFLUENCEDX_MARKETPLACE_V2` / `2` |
| Native unit | GEN / 18 decimals |
| Deployment record | [`deployments/genlayer-studionet.json`](../deployments/genlayer-studionet.json) |

The contract, not PostgreSQL, is authoritative for identity, campaign terms,
GEN custody, lifecycle, resolution, credits, refunds, fees, and withdrawals.
The web database is a deployment-scoped projection plus private application
state.

## Commands

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
npm run lint
npm test
npm run db:migrate
npm run db:verify
```

`npm test` runs the unit suite, optimized Next.js build, and rendered-page smoke
tests. Do not run database migrations against a shared or production database
without a backup, verified target, and release authorization.

## Environment

Copy [`.env.example`](.env.example) and keep populated values in an ignored
local file or encrypted hosting settings. `DATABASE_URL`, `AUTH_SECRET`, rate
limit/cron secrets, service tokens, and all private keys are server-only.

The active chain pins are:

```text
GENLAYER_STUDIONET_RPC_URL=https://studio.genlayer.com/api
INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS=0xb72FE7272A5aEdf3c6Ba893394EbeF818fd86Fbb
NEXT_PUBLIC_INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS=0xb72FE7272A5aEdf3c6Ba893394EbeF818fd86Fbb
INFLUENCEDX_GENLAYER_MARKETPLACE_VERSION=2
```

`XPROOF_APP_ORIGIN`, `XPROOF_VERIFICATION_MUTATIONS_ENABLED`, and
`XPROOF_MARKETPLACE_MUTATIONS_ENABLED` retain compatibility names in the
session/mutation-gate module. They do not select the retired APV2/Base product.
All mutation gates default false and must remain false until the isolated
deployment has passed read-only smoke checks.

Base, USDC, watcher, historical submitter, authorization-broker, and campaign
relay variables are intentionally absent from the active template. Do not copy
them from an old Vercel project.

## Wallet-session and write boundary

The application uses a short-lived wallet challenge and an HttpOnly session
bound to the normalized GenLayer address. No client identity header is trusted.
Users must explicitly sign out before switching wallets.

For each state-changing user action, the API stores and returns an immutable
prepared call with exact network, chain, contract, method, ordered argument
types/values, native value, actor, and expiry. The browser sends that exact call
through the connected GenLayer wallet. A confirmation body contains only the
prepared ID and transaction hash.

The server accepts the transition only after it proves:

- sender equals the session wallet;
- target equals Marketplace V2;
- decoded method, ordered arguments, and native value match the prepared call;
- the StudioNet transaction is `FINALIZED` with `MAJORITY_AGREE` and exactly one
  successful leader return; and
- the V2 post-state matches the expected identity/campaign/assignment/withdrawal
  transition.

`create_campaign` carries the exact GEN budget in atto-GEN. All other normal
user calls carry zero value. A hash alone or a browser callback never advances
the database.

## X and Farcaster verification

The verify flow creates one X challenge and one Farcaster challenge. After the
creator publishes both, the wallet signs exactly one zero-value
`activate_identity_bundle` call. GenLayer validators derive and bind both the
stable X user ID and Farcaster FID atomically; no single-source activation path
is exposed. Marketplace participation requires both credentials to remain
active, while each campaign still freezes the source used for its deliverable.

Farcaster username proofs accept the two canonical 65-byte representations
returned by supported Hubs: 132-character hex including `0x`, or 88-character
padded base64.

Public-source rate limits, authentication blocks, malformed responses, or
provider disagreement remain UNDETERMINED. The UI must not turn those states
into a failed identity or campaign.

## Native marketplace projection

Apply every migration through
[`0016_maintenance_heartbeat_lease.sql`](drizzle-postgres/0016_maintenance_heartbeat_lease.sql)
before deploying code that can activate the maintenance heartbeat or enabling
V2 mutations. Migration `0012` expires unfinished identity and transaction work
scoped to the retired marketplace and clears only the two retired marketplace
namespaces that held maintenance-generation authority, without deleting audit
evidence. Migration `0016` adds the durable queue-message winner required for a
safe heartbeat handoff. This is a migration-first rollout: `npm run db:verify`
must pass and report `"schemaVersion":6` before the new web deployment is
activated.

Native projection records are scoped by network, chain ID, contract address,
protocol/storage version, and onchain ID. Private pitches are stored only for
authorized application views; onchain applications bind their commitment.
Prepared calls and confirmations are idempotent and actor-bound.

Every campaign page and dashboard must be derived from authoritative V2 state
plus the matching deployment-scoped projection. Demo fixtures cannot label a
campaign funded, settled, refunded, or paid.

## Hosted progression

The web progression queue is
`influencedx-studionet-campaign-progression-v3`. It submits only fixed,
contract-derived operation shapes to the separate
[marketplace operator](../services/vercel-genlayer-marketplace-operator/README.md)
using Vercel workload OIDC plus an independent 32-byte service token.

The operator is permitted to call only:

- `resolve_assignment(assignment_id, request_id)`;
- `expire_assignment(assignment_id)`; and
- `finalize_campaign(campaign_id)`.

It cannot accept arbitrary target, method, arguments, or value. The web caller
is fail-closed unless all operator configuration is valid and
`INFLUENCEDX_MARKETPLACE_OPERATOR_ENABLED=true`.

The five-minute maintenance heartbeat uses
`influencedx-studionet-maintenance-v2`. Each message is bound to the runtime's
`VERCEL_DEPLOYMENT_ID` and to a monotonic generation held in Neon. Preview and
Production are separate generation scopes. A message first claims one fixed
five-minute database slot, so concurrent/manual reseeds self-thin to a single
live message without acknowledging a duplicate delivery of that same message.
The winner uses queue visibility redelivery for the cadence. Before Vercel's
forced retry-backoff range, it publishes an immediate next-slot successor. The
successor parks itself with a visibility change until that slot boundary, while
the old message stays retryable until the distinct successor is actually
delivered and wins a slot. Consumers prove the active database row before work
and after the bounded batch; stale and superseded deployments acknowledge
without extending their loop.

Migrations `0010` and `0012` intentionally leave the fresh contract namespace
without an active generation. Never reuse a generation belonging to a retired
contract. After deploying,
an operator must call the authenticated `POST /api/internal/campaign-progression`
route with `x-influencedx-maintenance-generation` set to the last observed
generation (`0` on first boot). An authenticated `GET` to an inactive
deployment returns that observed value as `error.currentGeneration`. Routine
authenticated `GET`/Cron calls only reseed an already-active deployment and
never promote one implicitly. Vercel
system variables must expose the deployment ID, project ID, environment, and
target environment or the loop fails closed.

Activation revokes the prior generation's scheduling authority atomically. A
bounded batch that already passed its first check may finish concurrently; its
per-row journal/progression leases and immutable operation IDs remain the
idempotency boundary, and its second generation check prevents rescheduling.
Every legacy v1 deployment whose loop was seeded must be identified through
Queue Observability/runtime logs and retired during the first cutover; changing
an alias alone is insufficient because already-built code cannot adopt a new
database check.

## Native withdrawal reconciliation

A user signs `request_withdrawal` and `execute_withdrawal`. The latter can leave
V2 at `EMITTED_UNCONFIRMED`; that state is not delivered payment.

The separate
[withdrawal reconciler](../services/vercel-genlayer-withdrawal-reconciler/README.md)
derives recipient/amount/evidence from finalized chain state, proves the unique
native transfer child, and uses the dedicated V2 withdrawal-confirmer boundary
only for exact zero-value `confirm_withdrawal`. The web caller sends only the
lowercase withdrawal ID.

Only a `FINALIZED` reconciler projection backed by contract status `CONFIRMED`
may be shown as delivered. Reconciliation ambiguity is a manual terminal state;
the web must never automatically restore or recapitalize a withdrawal.

## Rate limits and cleanup

Verification mutations use atomic PostgreSQL fixed-window counters. Bucket keys
are HMAC-SHA-256 digests under `XPROOF_RATE_LIMIT_SECRET`; raw client IPs,
wallets, session subjects, and request IDs are not stored in the rate-limit
table. On Vercel, only the platform's trusted forwarded-for boundary is used and
malformed/comma-separated chains fail closed.

A daily Vercel Cron invokes the bearer-protected cleanup route. Configure an
independent `CRON_SECRET` and alert if cleanup reports a capped backlog.

## Release checks

Before enabling V2 web mutations:

1. lint, unit, optimized build, and rendered smoke pass on the exact commit;
2. migration `0016` is applied before the web deployment and `db:verify`
   reports `"schemaVersion":6`;
3. after deployment, activate only the next monotonic maintenance generation,
   then run a controlled current-slot and next-slot reseed canary; observe at
   least two five-minute redeliveries, one distinct `heartbeat_message_id`
   winner per slot, stale/duplicate acknowledgement, and zero queue-handler
   5xx responses before switching the public alias;
4. alert when the active generation's `updated_at` fails to advance for two
   expected slots, and keep an independent authenticated reseed runbook for a
   queue outage or seven-day retention expiry;
5. the live contract source/schema/config/receipt match the manifest;
6. CSP and browser bundles expose no server secret or disallowed chain origin;
7. operator and reconciler are separately deployed, disabled-first, and bound
   to the exact web workload identity;
8. wrong wallet, extra request fields, wrong call/value, replay, terminated
   receipt, and service-auth failures all fail closed; and
9. the complete X, Farcaster, native campaign, and confirmed withdrawal E2E is
   recorded in [`docs/TEST-REPORT.md`](../docs/TEST-REPORT.md).

## Historical code boundary

Some legacy modules, migrations, tests, and root commands remain for audit and
regression of the former Base Sepolia/test-USDC/APV2/watcher-relay prototype.
They are not active routes, runtime configuration, deployment steps, or queues
for Marketplace V2. The historical evidence is isolated in
[`docs/preview-base-sepolia-relay.md`](../docs/preview-base-sepolia-relay.md).
