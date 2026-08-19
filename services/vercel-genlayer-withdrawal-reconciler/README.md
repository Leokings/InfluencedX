# InfluencedX GenLayer withdrawal reconciler

This is an isolated, disabled-by-default hosted service for the native GEN withdrawal delivery gap in `InfluencedXMarketplace` V2. It watches a finalized `EMITTED_UNCONFIRMED` withdrawal, proves the exact finalized parent `execute_withdrawal` transaction and its unique finalized StudioNet child transfer, then signs only:

```text
confirm_withdrawal(withdrawal_id, evidence_hash), value = 0
```

The live boundary is literal-pinned to StudioNet chain `61999`, protocol `INFLUENCEDX_MARKETPLACE_V2`, storage schema `2`, contract `0x17eb37a3578e21662f4d654b245238df520663fa`, and owner `0x797d3b25fb2cca0ff93f60df1910267f3822d655`.

## Safety model

Ingress accepts only a lowercase `withdrawalId`. Recipient, amount, parent/child hashes, evidence hash, target, method, arguments, and native value are derived by the service from finalized contract and transaction state. A proof requires all of the following:

- the finalized contract state is pristine `EMITTED_UNCONFIRMED`;
- exactly one successful finalized call from the recorded recipient to the pinned contract decodes as `execute_withdrawal(withdrawal_id)` with zero value;
- that parent has exactly one triggered child transaction;
- the child links back to the parent, is finalized, comes from the marketplace ghost address, goes to the recorded recipient, carries the exact recorded amount, and reports `value_credited=true`;
- a second proof discovery under the signer fence is byte-for-byte identical;
- the owner confirmation receipt binds the exact signer, contract, method, arguments, zero value, nested successful leader return, and transaction hash;
- finalized post-state contains the same withdrawal fields, the exact evidence hash, `CONFIRMED`, and exact liability/emitted/withdrawn accounting deltas.

The PostgreSQL signer gate is singleton and fenced. Its short lease exists only during read-only revalidation. Before broadcast it becomes non-expiring. An unknown broadcast result, a crash before the returned hash is durably stored, any receipt ambiguity, or any final-state mismatch is quarantined for manual reconciliation.

The service never calls `restore_failed_withdrawal` or `recapitalize_failed_withdrawal`. If a definitive transfer failure or missing proof persists beyond the contract's 24-hour recovery delay, status becomes `RECONCILIATION_REQUIRED`. Governance must inspect evidence and decide what to do; the service never restores liabilities or supplies capital automatically.

Private keys, service tokens, private proof JSON, and RPC response bodies are never logged. Public status exposes only hashes and lifecycle metadata.

## API contract

Both routes require:

1. `Authorization: Bearer <Vercel OIDC token>` with exact issuer, audience, subject, team, project, and environment claims; and
2. `x-influencedx-withdrawal-service-token: <32-byte hex token>`.

Enqueue or idempotently replay:

```http
POST /v1/withdrawals/reconciliations
Content-Type: application/json

{"schemaVersion":1,"withdrawalId":"0x…64 lowercase hex…"}
```

New jobs return `202`; exact replays return `200`. Poll:

```http
GET /v1/withdrawals/reconciliations/:withdrawalId
```

Both return a public-safe `reconciliation` projection. Status is one of:

```text
QUEUED
WAITING_FOR_EMISSION
WAITING_FOR_TRANSFER
PROOF_VERIFIED
BROADCASTING
SUBMITTED
POLLING
FINALIZED
RECONCILIATION_REQUIRED
POLLING_EXHAUSTED
POISONED
```

Only `FINALIZED` means delivery has been confirmed on the contract. The last three statuses are manual terminal states.

The Vercel Queue topic is `influencedx-genlayer-withdrawal-reconciliation-v1`. Its push consumer is configured with `queue/v2beta`, so it is not publicly routable. Queue delivery is at-least-once; every transition is idempotent and bound to durable PostgreSQL state.

## Deployment runbook

Do not deploy from the repository root. Create a separate Vercel project with this directory as its root.

1. Keep `INFLUENCEDX_WITHDRAWAL_RECONCILER_ENABLED=false`.
2. Create a dedicated private PostgreSQL database/schema and set `DATABASE_URL`.
3. Run `npm ci` and `npm run migrate` against that database.
4. Configure every exact variable from `.env.example`. The private key must derive to the pinned live contract owner; startup and every chain precheck reject any mismatch.
5. Generate a new random 32-byte hex service token. Store it only in this project and the authorized server-side caller.
6. Deploy while disabled. Verify the queue trigger is present and its topic is exact.
7. Run `npm run lint`, `npm test`, `npm run build`, and `npm audit --omit=dev`.
8. Enable with `INFLUENCEDX_WITHDRAWAL_RECONCILER_ENABLED=true` in a new deployment.
9. Enqueue only after the user's `execute_withdrawal` transaction is finalized and the contract projects `EMITTED_UNCONFIRMED`.
10. Alert on `RECONCILIATION_REQUIRED`, `POLLING_EXHAUSTED`, `POISONED`, and signer-gate occupancy. Never clear the gate or create a replacement job until the exact transaction history is reconciled.

Vercel Queue uses workload OIDC automatically on Vercel. Non-Vercel local queue calls require Vercel's standard queue API token; that token is not an ingress credential.

## Local verification

```powershell
npm ci
npm run lint
npm test
npm run build
npm audit --omit=dev
```

CI runs the same lint, production build, and adversarial test suite through the repository's `hosted-services` matrix. CI deliberately does not run migrations, deploy, enable the service, load secrets, or mutate StudioNet.

References: [GenLayer value transfers](https://docs.genlayer.com/developers/intelligent-contracts/features/value-transfers), [GenLayer transaction methods](https://docs.genlayer.com/api-references/genlayer-js/transactions), and [Vercel Queues](https://vercel.com/docs/queues).
