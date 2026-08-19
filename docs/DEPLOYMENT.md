# InfluencedX GenLayer V2 deployment and cutover

This runbook deploys the GenLayer-only product. It does not deploy, configure,
or depend on Base, USDC, watchers, the historical submitter, or a cross-network
relay.

## Current release boundary

The frozen StudioNet V2 contract exists at
`0x58D598B8323E9C1d041989DccE80E737109DE347`. The native PostgreSQL migrations
are applied and verified, and the web/API plus both hosted services are enabled
in an isolated Preview release at
`https://influencedx-native-preview.vercel.app`. The existing public alias has
not moved. **Public cutover and complete user-driven V2 E2E evidence are still
pending.**

The release consists of three separately deployed projects:

1. `web/` — user interface, API, PostgreSQL projection, and progression queue;
2. `services/vercel-genlayer-marketplace-operator/` — fixed permissionless
   maintenance writes; and
3. `services/vercel-genlayer-withdrawal-reconciler/` — exact native-transfer
   proof and narrowly scoped withdrawal-confirmer authorization.

Each project is disabled by default. Never place either service private key in
the web project.

## 1. Freeze and validate the release

Use a clean release commit and record it before changing any hosted state.

```powershell
cd C:\path\to\adproof
git status --short
python -m pip install --requirement requirements-direct.txt
genvm-lint check contracts/genlayer/InfluencedXMarketplace.py --json
python -m pytest tests/direct -q

cd web
npm ci
npm run lint
npm test

cd ..\services\vercel-genlayer-marketplace-operator
npm ci
npm run lint
npm test
npm run build
npm audit --omit=dev

cd ..\vercel-genlayer-withdrawal-reconciler
npm ci
npm run lint
npm test
npm run build
npm audit --omit=dev
```

Do not treat the root `test:base`, `test:relay`, `test:services`,
`test:submitter`, `deploy:base-sepolia`, `cutover:base:studionet`,
`settlement:*`, or `relay:*` scripts as V2 release commands. They preserve the
former prototype for regression/audit only.

## 2. Verify the pinned StudioNet contract

Read, do not mutate, the deployment before configuring hosted services:

```powershell
genlayer schema 0x58D598B8323E9C1d041989DccE80E737109DE347 --rpc https://studio.genlayer.com/api
genlayer code 0x58D598B8323E9C1d041989DccE80E737109DE347 --rpc https://studio.genlayer.com/api
genlayer call 0x58D598B8323E9C1d041989DccE80E737109DE347 get_config --rpc https://studio.genlayer.com/api
genlayer receipt 0x899c619e51775eed7c442ddb1c6f1fa8073a25005681935d3dda763aef2fc24a --rpc https://studio.genlayer.com/api
```

Stop if any live value differs from
[`deployments/genlayer-studionet.json`](../deployments/genlayer-studionet.json),
including network `studionet`, chain `61999`, protocol
`INFLUENCEDX_MARKETPLACE_V2`, schema `2`, native symbol/decimals, owner,
treasury, upgrade administrator, fee, pause state, or seven-day delay. Stop if
the deployment receipt is not finalized with a successful leader return.

The manifest currently records `productionOwnerConfigured: false`. This is an
intentional developer-network limitation, not a condition to waive for mainnet.

## 3. Provision isolated data stores

Use a private PostgreSQL database for the web projection. Give the marketplace
operator and withdrawal reconciler separate databases or strictly isolated
schemas/roles so a service cannot read or mutate another service's private job
envelopes or signer fence.

Back up the target database, verify the restore path, and apply migrations only
to the isolated release:

```powershell
cd C:\path\to\adproof\web
npm run db:migrate
npm run db:verify

cd ..\services\vercel-genlayer-marketplace-operator
npm run migrate

cd ..\vercel-genlayer-withdrawal-reconciler
npm run migrate
```

The web migrations include
[`0009_genlayer_native_marketplace.sql`](../web/drizzle-postgres/0009_genlayer_native_marketplace.sql)
and the additive
[`0010_maintenance_generation_fence.sql`](../web/drizzle-postgres/0010_maintenance_generation_fence.sql).
Confirm every projection and uniqueness boundary is scoped by network, chain,
contract, protocol/schema version, and onchain ID. Never rewrite historical
Base or V1 rows into V2 rows.

## 4. Configure the marketplace operator while disabled

Create a separate Vercel project rooted at
`services/vercel-genlayer-marketplace-operator/`. Configure every variable in
its [`.env.example`](../services/vercel-genlayer-marketplace-operator/.env.example)
for the exact isolated web project and deployment environment.

Critical pins are:

```text
INFLUENCEDX_MARKETPLACE_OPERATOR_ENABLED=false
INFLUENCEDX_MARKETPLACE_OPERATOR_STAGE=studionet
INFLUENCEDX_GENLAYER_NETWORK=studionet
INFLUENCEDX_GENLAYER_CHAIN_ID=61999
INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS=0x58D598B8323E9C1d041989DccE80E737109DE347
INFLUENCEDX_GENLAYER_MARKETPLACE_PROTOCOL=INFLUENCEDX_MARKETPLACE_V2
INFLUENCEDX_GENLAYER_MARKETPLACE_SCHEMA_VERSION=2
```

Generate a dedicated StudioNet operator key. It must not be the owner, upgrade
administrator, treasury, a user wallet, or the withdrawal signer. Store the key
and independent 32-byte service token only in encrypted server-side settings.

Deploy disabled. Verify health/configuration fails closed and that the
air-gapped queue consumer is bound only to
`influencedx-genlayer-marketplace-ops-v1`. Confirm wrong OIDC claims, service
token, route body, method, target, arguments, and native value are rejected.

## 5. Configure the withdrawal reconciler while disabled

Create another Vercel project rooted at
`services/vercel-genlayer-withdrawal-reconciler/`. Configure every variable in
its [`.env.example`](../services/vercel-genlayer-withdrawal-reconciler/.env.example).
The fresh contract authorizes only its distinct `withdrawal_confirmer` to call
`confirm_withdrawal`. Keep the service disabled until its role migration is
applied and the configured address, private-key-derived signer, and live
`get_config().withdrawal_confirmer` all match exactly.

```text
INFLUENCEDX_WITHDRAWAL_RECONCILER_ENABLED=false
INFLUENCEDX_WITHDRAWAL_RECONCILER_STAGE=studionet
INFLUENCEDX_GENLAYER_NETWORK=studionet
INFLUENCEDX_GENLAYER_CHAIN_ID=61999
INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS=0x58D598B8323E9C1d041989DccE80E737109DE347
INFLUENCEDX_GENLAYER_MARKETPLACE_WITHDRAWAL_CONFIRMER=0xAaFC5D9075A404d82b8Ee1692F7ff802168c5Dd8
INFLUENCEDX_GENLAYER_MARKETPLACE_PROTOCOL=INFLUENCEDX_MARKETPLACE_V2
INFLUENCEDX_GENLAYER_MARKETPLACE_SCHEMA_VERSION=2
```

Reject any other protocol value. The dedicated withdrawal-confirmer signer is
a StudioNet-only test boundary and must never be copied into a mainnet project.

Deploy disabled. Confirm the queue consumer is bound only to
`influencedx-genlayer-withdrawal-reconciliation-v1` and that no route permits
`restore_failed_withdrawal`, recapitalization, arbitrary target/method/value, or
caller-supplied transfer evidence.

## 6. Configure and deploy the isolated web release

Create the web deployment from `web/` and copy
[`web/.env.example`](../web/.env.example) into encrypted environment settings.
Use the exact Preview/isolated environment scope first.

Keep all three gates false:

```text
XPROOF_VERIFICATION_MUTATIONS_ENABLED=false
XPROOF_MARKETPLACE_MUTATIONS_ENABLED=false
INFLUENCEDX_MARKETPLACE_OPERATOR_ENABLED=false
INFLUENCEDX_WITHDRAWAL_RECONCILER_ENABLED=false
```

Pin the StudioNet RPC, V2 address, public address, and version. Configure the
operator/reconciler origins and distinct service tokens, but do not enable
either caller until their disabled deployments and OIDC bindings are verified.

Verify the web queue consumers are bound only to
`influencedx-studionet-campaign-progression-v3` and
`influencedx-studionet-maintenance-v2`. The former submitter, watcher, Base
relay, `campaign-progression-v2`, and unfenced `maintenance-v1` topics must not
be configured for V2.

Run read-only smoke checks:

- landing, campaign directory, creator profile, dashboard, verify flow, terms,
  and privacy pages render without fixtures claiming success;
- the UI says StudioNet/native GEN and never asks for Base Sepolia or USDC;
- X and Farcaster choices render independently;
- explorer links point to `explorer-studio.genlayer.com`;
- no server secret or private projection appears in browser bundles/responses;
- the V2 contract/config read matches the manifest; and
- every mutation endpoint returns its disabled response.

## 7. Enable in a controlled order

Use a new immutable deployment for every gate change:

1. enable the marketplace operator service;
2. enable the withdrawal reconciler service;
3. enable the two server-to-server callers in the isolated web project;
4. run operator/reconciler authenticated smoke requests that do not broadcast
   an ineligible write;
5. enable verification mutations; and
6. enable marketplace mutations.

Do not enable the public alias yet.

### Promote the maintenance generation

Migration `0010` deliberately creates no active worker. Inventory Queue
Observability and runtime logs, then retire every seeded pre-fence deployment;
moving an alias does not stop its deployment-partitioned queue loop. Allow one
visibility lease (up to ten minutes) to clear.

Read the currently observed generation (`0` on first activation), move only the
isolated native Preview alias to the new immutable deployment, and dispatch
[`promote-native-preview.yml`](../.github/workflows/promote-native-preview.yml)
with that exact number. The workflow is pinned to the InfluencedX native
Preview alias and uses the encrypted
`INFLUENCEDX_PREVIEW_CRON_SECRET`; it cannot forward the credential to a caller-
supplied host. The route performs a database CAS, seeds a deployment-ID-bound
message, and increments the generation exactly once.

Observe at least two successful `maintenance-v2` callbacks approximately five
minutes apart, no stale-generation rescheduling, no consumer backlog, and no
error/fatal logs. Subsequent releases and rollbacks always promote from the
currently observed generation; never decrement or reuse a generation.

## 8. Required isolated E2E rehearsal

Use disposable StudioNet wallets and developer-network GEN. Record every wallet,
call, hash, finalized receipt, and post-state without recording private keys.

1. Activate an X identity with a genuine public challenge post.
2. Activate a Farcaster identity with a genuine public challenge cast.
3. Create a campaign with exact native GEN value and confirm V2 custody.
4. Apply with a verified source-matching creator.
5. Select, accept, publish, and submit the canonical source content ID.
6. Wait the frozen retention period and let the hosted operator resolve it.
7. Confirm the exact PASS/FAIL/UNDETERMINED state and accounting.
8. Complete a claimable-credit path, then request and execute withdrawal.
9. Prove the child transfer and let the reconciler finalize
   `confirm_withdrawal`.
10. Verify contract withdrawal status `CONFIRMED`, matching recipient/amount,
    accounting invariants, database projection, and explorer/API trail.

Also exercise wrong wallet, extra body field, wrong method, wrong value,
terminated receipt, replay, stale deadline, source unavailability, and queue
redelivery. Never label `EMITTED_UNCONFIRMED` as paid.

The live native-value canary and complete public E2E are pending until their
actual hashes are added to [the test report](TEST-REPORT.md). Do not invent or
reuse historical Base receipts.

## 9. Public cutover

Only after the isolated rehearsal passes:

1. record all results in `docs/TEST-REPORT.md` and a new immutable release
   record;
2. take a fresh database backup and verify service alerts;
3. move the public alias to the exact tested web deployment;
4. repeat read-only and one low-value mutation smoke check through the public
   origin;
5. remove active hosted environment bindings for Base, USDC, historical
   submitter, watchers, relay, and old queue topics; and
6. retain historical projects disabled for audit until their evidence-retention
   policy permits archival.

The public URL must never be moved merely because a build succeeds.

## 10. Rollback and reconciliation

If the hosted release fails:

1. disable web mutations and both hosted service gates;
2. stop new jobs without deleting rows, queue evidence, or hashes;
3. restore the previous known-good web deployment/alias;
4. reconcile every submitted hash against StudioNet and V2 post-state;
5. clear a signer fence only after its exact transaction history is understood;
6. resume only idempotent operations whose database and contract states agree;
   and
7. rotate a secret only if exposure is suspected, preserving required audit
   evidence.

A web rollback cannot roll back GenLayer state. Never replace an unknown
broadcast with a new transaction simply to make the UI progress.

## 11. StudioNet reset

StudioNet is resettable. If the contract or transaction history disappears:

1. disable all mutation and automation gates;
2. treat every old address, prepared call, projection, queue job, and identity
   as network-retired;
3. validate and deploy the exact approved source to the reset network;
4. write a new immutable manifest and deployment-scoped database projection;
5. configure all three hosted projects with the new address/protocol/schema;
6. run the complete isolated E2E again; and
7. cut over only after new evidence is recorded.

Never overwrite the current V2 manifest or relabel a pre-reset receipt as live.

## 12. Upgrades and mainnet

For an in-place V2 upgrade, pause the marketplace, publish the exact candidate
source/hash and storage-layout review, schedule the hash, wait seven full days,
then execute only the exact reviewed bytes. Monitor the entire delay and verify
post-upgrade schema/config/state. See
[the protocol operations reference](GENLAYER-MARKETPLACE.md).

A mainnet deployment is a fresh release, not an environment-variable flip. It
requires a current GenLayer mainnet chain/RPC adapter and new manifest, reviewed
multisignature owner and upgrade governance, distinct treasury and operational
keys, external contract/security review, invariant/fuzz and live value-transfer
testing, service SLOs and alerts, incident drills, database point-in-time
recovery/deletion drills, and applicable legal/privacy controls. StudioNet keys,
addresses, GEN, and receipts have no production authority.

## Historical archive

The former Base Sepolia/USDC/watcher/relay deployment is documented only in
[the historical relay record](preview-base-sepolia-relay.md),
[historical settlement services](campaign-settlement-services.md), and
[`deployments/base-sepolia.json`](../deployments/base-sepolia.json). Do not use
those runbooks, secrets, addresses, or queues during a V2 release.
