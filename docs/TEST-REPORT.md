# InfluencedX GenLayer V2 verification report

This report separates recorded evidence from work that is still pending. It
must not be used to claim that the public site is already running the V2
GenLayer-only product.

Report date: **2026-08-19**

Target: **GenLayer StudioNet (`61999`)**

## Recorded V2 contract evidence

| Check | Recorded result |
| --- | --- |
| Contract source | [`InfluencedXMarketplace.py`](../contracts/genlayer/InfluencedXMarketplace.py) |
| Source SHA-256 | `0xf6dbcfaf11456096c11bf8dbcc729238d3b31156e842c5ba01f694915c4d3323` |
| Frozen source commit | `77e6109ca60d2b444f168d0a6b8de5df92cf902e` |
| GenVM lint | PASS; public ABI contains 50 methods (21 view, 29 write) |
| Direct suite | PASS; 50 tests |
| Deployment | `0x58D598B8323E9C1d041989DccE80E737109DE347` |
| Deployment transaction | `0x899c619e51775eed7c442ddb1c6f1fa8073a25005681935d3dda763aef2fc24a` |
| Deployment receipt | `FINALIZED`, `MAJORITY_AGREE`, successful leader return |
| Protocol / schema | `INFLUENCEDX_MARKETPLACE_V2` / `2` |
| Native asset / fee | GEN (18 decimals) / 250 bps |
| Upgrade control | Dedicated upgrade administrator; `604800` second minimum delay |

The canonical record is
[`deployments/genlayer-studionet.json`](../deployments/genlayer-studionet.json).
Live read-only checks verified owner, treasury, upgrade administrator, fee,
protocol/schema, native unit, pause state, and upgrade-delay configuration
against that manifest.

The contract was paused and unpaused through a developer-network governance
canary. The final recorded state is unpaused with no pending upgrade and no
campaign value in that canary. A CLI attempt to pass a code hash was rejected
before scheduling because that CLI path coerced the hash incorrectly; it is not
evidence of a scheduled upgrade. A future governance E2E must use typed bytes
through the reviewed write adapter and then cancel the canary commitment.

## Direct-mode coverage

The 50 direct tests cover the contract's deterministic and adversarial
boundaries, including:

- X ownership challenge binding and stable X user identity;
- Farcaster challenge, username proof, FID, and cast-hash binding;
- source-keyed profiles and cross-source campaign rejection;
- payable campaign creation with exact native GEN value;
- deterministic campaign, application, assignment, resolution, and withdrawal
  identifiers;
- creator application, brand selection, creator acceptance/decline, deadlines,
  and evidence submission;
- PASS, FAIL, retryable UNDETERMINED, refunds, fees, and conservation checks;
- external-source transient/malformed/inconsistent fail-safe behavior;
- pull credits and PENDING/EMITTED_UNCONFIRMED/CONFIRMED/RESTORED_FAILED
  withdrawal states;
- pause and exceptional recovery requirements; and
- exact-hash, paused, seven-day, dedicated-admin Root upgrade controls.

Direct mode proves contract logic under the test harness. It does **not** prove
StudioNet consensus provider availability, a browser wallet flow, a hosted
queue, or delivery of a native external value-transfer child transaction.

## Hosted service validation

### Marketplace operator

The isolated service at
[`services/vercel-genlayer-marketplace-operator/`](../services/vercel-genlayer-marketplace-operator/)
has passed its local TypeScript check, production build, production dependency
audit, and 30 tests. Coverage includes:

- exact Vercel OIDC and independent service-token authentication;
- fixed contract/protocol/schema/action/value pins;
- strict request bodies with no arbitrary method, target, arguments, or value;
- durable idempotency and singleton fenced signer behavior;
- at-least-once queue redelivery;
- exact nested StudioNet finality/receipt binding; and
- authoritative pre-state and post-state reconciliation.

It is deployed and enabled at the isolated Preview service alias, but is not
yet part of the unchanged public release alias.

### Withdrawal reconciler

The isolated service at
[`services/vercel-genlayer-withdrawal-reconciler/`](../services/vercel-genlayer-withdrawal-reconciler/)
has passed its local TypeScript check, production build, production dependency
audit, and 24 adversarial tests. Coverage includes:

- exact V2 withdrawal-confirmer/contract/protocol/schema pins;
- caller-supplied withdrawal ID only;
- derivation of recipient, amount, parent, child, and evidence from finalized
  chain state;
- unique child transfer and credited-value proof;
- repeated proof discovery under a signer fence;
- exact `confirm_withdrawal` call and post-state/accounting binding; and
- quarantine rather than automatic restoration on ambiguity.

It is deployed and enabled at the isolated Preview service alias, but is not
yet part of the unchanged public release alias.

## Web/API integration status

The active migration replaces the former Base marketplace paths with native
GenLayer preparation, direct user-signed writes, finalized receipt binding,
source-aware X/Farcaster identity and campaign flows, deployment-scoped
PostgreSQL projections, operator progression, and withdrawal reconciliation.
The web environment template and active documentation now contain no Base,
USDC, watcher, relay, or historical submitter secrets.

The exact integrated release tree passed 180 web unit tests, the optimized
Next.js build, 7 rendered-page tests, TypeScript, ESLint, and clean-install
reproducibility. The isolated Preview database is migrated through `0010` and
its verifier reports schema version 3 and the native StudioNet schema ready.
The operator passed
30 tests plus build/typecheck; the withdrawal reconciler passed 24 tests plus
build/typecheck. All three enabled Preview deployments fail closed on
unauthenticated service calls.

The fenced maintenance release is commit
`f6fa400447e9fd373923f006fe2722f0b5dba79d`, deployment
`dpl_bYGwE9hYzigk4RqVVu2GJ7PnDnJX`, and generation `1`. Neon binds that exact
deployment to StudioNet `61999`, the final V2 contract, the web project, and
Preview. Its first two `maintenance-v2` callbacks returned HTTP 200 at
`1787156516621` and `1787156818284`, 301,663 ms apart. The deployment had no
error/fatal logs. Both seeded pre-fence deployments were retired and returned
404, with no post-activation legacy maintenance activity.

## Required live E2E evidence — pending

The following are release blockers, not completed claims:

- [x] Deploy the marketplace operator disabled, verify auth/queue pins, then
  enable it in an isolated environment.
- [x] Deploy the withdrawal reconciler disabled, verify auth/queue pins, then
  enable it in an isolated environment.
- [x] Apply and verify native V2 migrations through the deployment-generation
  fence in `0010`.
- [x] Promote and prove fenced maintenance generation 1, then retire every
  seeded pre-fence deployment.
- [x] Deploy the native web build on an isolated URL with gates disabled, then
  enable in the documented order.
- [ ] Complete one genuine X ownership challenge and finalized V2 activation.
- [ ] Complete one genuine Farcaster ownership challenge and finalized V2
  activation.
- [ ] Complete one native-GEN campaign through create, apply, select, accept,
  submit, retention, and hosted resolution.
- [ ] Record a PASS or FAIL settlement and verify every accounting field.
- [ ] Complete request/execute withdrawal, prove the exact StudioNet native
  child transfer, and reach contract status `CONFIRMED`.
- [ ] Record actual transaction hashes, explorer/API links, contract post-state,
  queue operation IDs, and sanitized hosted logs.
- [ ] Run wrong-wallet, wrong-value, replay, source-outage, queue-redelivery, and
  unknown-broadcast recovery checks against the isolated deployment.
- [ ] Move the public alias only after all checks above pass.
- [ ] Record the three-minute demo without exposing secrets.

There is currently no recorded V2 native withdrawal child-transfer receipt in
this document. `EMITTED_UNCONFIRMED` must never be described as delivered. The
existing public site must not be described as V2 until the cutover evidence is
added here.

## StudioNet limitations

- StudioNet is temporary and may reset. Addresses, identities, state, and
  receipts are developer-network evidence rather than durable production data.
- StudioNet GEN is a developer token with no claimed monetary value.
- X and Farcaster are external availability dependencies. Transient or
  ambiguous retrieval remains UNDETERMINED.
- The deployed owner and upgrade administrator are EOAs suitable only for this
  developer-network rehearsal. `productionOwnerConfigured` is false.
- Hosted Vercel Queues are at-least-once; correctness depends on durable
  idempotency, exact receipt binding, and signer fencing.
- A seven-day delay gives reviewers time to inspect an upgrade but does not
  replace an independent audit.

## Mainnet gates

Before an immediately deployable mainnet release can be called production
ready, the team still must complete:

- a fresh target-network deployment manifest and network adapter;
- reviewed multisignature/governance owner and upgrade administrator,
  operational role separation, and a distinct treasury;
- an independent GenLayer contract review plus invariant/fuzz, integration,
  browser, load, and failure-injection testing;
- real target-network value-transfer and withdrawal reconciliation rehearsals;
- monitored operator/reconciler SLOs, alerts, DLQ/replay procedures, incident
  drills, and signer-fence recovery procedures;
- PostgreSQL point-in-time recovery, restore, deletion, and disaster-recovery
  drills; and
- applicable legal, privacy, support, and security response processes.

## Historical archive — not active V2 evidence

The repository preserves the former Base Sepolia + test USDC + APV2 resolver +
watcher relay prototype, including a historical ownership receipt. It is useful
only as an audit/regression archive and does not prove V2 identity, native GEN
custody, Farcaster support, resolution, or withdrawal delivery.

Historical sources are:

- [Base relay record](preview-base-sepolia-relay.md);
- [settlement service design](campaign-settlement-services.md);
- [watcher-key model](WATCHER-KEYS.md);
- [`deployments/base-sepolia.json`](../deployments/base-sepolia.json); and
- [`deployments/genlayer-bradbury.json`](../deployments/genlayer-bradbury.json).

Do not reuse their addresses, secrets, queues, transaction hashes, or success
claims in the V2 release checklist.
