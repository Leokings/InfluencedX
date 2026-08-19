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
| Contract | `0x58D598B8323E9C1d041989DccE80E737109DE347` |
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
INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS=0x58D598B8323E9C1d041989DccE80E737109DE347
NEXT_PUBLIC_INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS=0x58D598B8323E9C1d041989DccE80E737109DE347
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

The verify flow creates a source-specific, one-time challenge:

- X uses a public challenge post and `activate_creator`;
- Farcaster uses a public challenge cast, stable FID, cast hash, and
  `activate_farcaster_creator`.

The backend does not assert the stable identity. GenLayer validators retrieve
the public evidence and derive/bind the stable X user ID or Farcaster FID. A
wallet may hold both identities, but a campaign freezes one source and only an
active identity for that source can participate.

Public-source rate limits, authentication blocks, malformed responses, or
provider disagreement remain UNDETERMINED. The UI must not turn those states
into a failed identity or campaign.

## Native marketplace projection

Apply all migrations through
[`0009_genlayer_native_marketplace.sql`](drizzle-postgres/0009_genlayer_native_marketplace.sql)
before enabling V2 mutations. `npm run db:verify` must pass afterward.

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

## Native withdrawal reconciliation

A user signs `request_withdrawal` and `execute_withdrawal`. The latter can leave
V2 at `EMITTED_UNCONFIRMED`; that state is not delivered payment.

The separate
[withdrawal reconciler](../services/vercel-genlayer-withdrawal-reconciler/README.md)
derives recipient/amount/evidence from finalized chain state, proves the unique
native transfer child, and uses the V2 owner boundary only for exact zero-value
`confirm_withdrawal`. The web caller sends only the lowercase withdrawal ID.

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

1. lint, unit, optimized build, rendered smoke, database migration, and
   `db:verify` all pass on the exact commit;
2. the live contract source/schema/config/receipt match the manifest;
3. CSP and browser bundles expose no server secret or disallowed chain origin;
4. operator and reconciler are separately deployed, disabled-first, and bound
   to the exact web workload identity;
5. wrong wallet, extra request fields, wrong call/value, replay, terminated
   receipt, and service-auth failures all fail closed; and
6. the complete X, Farcaster, native campaign, and confirmed withdrawal E2E is
   recorded in [`docs/TEST-REPORT.md`](../docs/TEST-REPORT.md).

## Historical code boundary

Some legacy modules, migrations, tests, and root commands remain for audit and
regression of the former Base Sepolia/test-USDC/APV2/watcher-relay prototype.
They are not active routes, runtime configuration, deployment steps, or queues
for Marketplace V2. The historical evidence is isolated in
[`docs/preview-base-sepolia-relay.md`](../docs/preview-base-sepolia-relay.md).
