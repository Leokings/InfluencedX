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
| Source SHA-256 | `0xcdb7a7126cb59705bddf8862c49d9ce6d49c9c18e792d4851c071ad403d10705` |
| Release source commit | `8271a92172eb5c014a930ef31611fb956908de16` |
| GenVM lint | PASS; public ABI contains 50 methods (22 view, 28 write) |
| Direct suite | PASS; 58 tests |
| Deployment | `0xb72FE7272A5aEdf3c6Ba893394EbeF818fd86Fbb` |
| Deployment transaction | `0x05ff78998a2b389c7e102f6f09b893dbd16d376f3c18f9748b2b8ef9de5e7998` |
| Deployed at | `2026-08-19T21:45:34.887910Z` |
| Deployment receipt | `FINALIZED`, `MAJORITY_AGREE`, successful leader return |
| Protocol / schema | `INFLUENCEDX_MARKETPLACE_V2` / `2` |
| Native asset / fee | GEN (18 decimals) / 250 bps |
| Upgrade control | Dedicated upgrade administrator; `604800` second minimum delay |

The canonical record is
[`deployments/genlayer-studionet.json`](../deployments/genlayer-studionet.json).
Live read-only checks verified owner, treasury, upgrade administrator, fee,
protocol/schema, native unit, pause state, and upgrade-delay configuration
against that manifest.

The fresh bundle-only deployment was read back as unpaused with no identities,
campaigns, withdrawals, pending upgrade, balance, or liability. Seven-day
upgrade behavior is covered in direct tests; a future governance E2E must use
typed bytes through the reviewed write adapter and cancel the canary
commitment afterward.

The retired pre-public deployment
`0xEaCeBa807a7A4dc370f3B5a8e45539596b8551b4` (transaction
`0x8881290fcbe992a222995fccc0f2994e3752bd4e4aad35e6d25628e3c6df21d2`)
held no campaign, profile, withdrawal, or native-value state requiring
migration. It was replaced after its 100-item Farcaster recent-casts request
exceeded the provider limit. The replacement uses 50, and the web finality
adapter now prefers immutable transaction creation time over current time.

## Direct-mode coverage

The 58 direct tests cover the contract's deterministic and adversarial
boundaries, including:

- atomic X + Farcaster ownership, stable IDs, and all-or-nothing activation;
- exact 65-byte Farcaster username-proof encodings (hex 132 including `0x`,
  and padded base64 88);
- the provider-compatible 50-item Farcaster recent-casts query boundary;
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

The exact integrated release tree passed 188 web unit tests, the optimized
Next.js build, 7 rendered-page tests, TypeScript, ESLint, and clean-install
reproducibility. The isolated Preview database must be migrated through `0012`
before the fresh contract build is enabled; the previous hosted proof was
through `0010`. Migration `0012` retires unfinished old-contract work and
removes only the two retired marketplaces' maintenance generations. After cutover,
its verifier reports schema version 3 and the native StudioNet schema ready.
The operator passed
30 tests plus build/typecheck; the withdrawal reconciler passed 24 tests plus
build/typecheck. All three enabled Preview deployments fail closed on
unauthenticated service calls.

The fenced maintenance release at commit
`f6fa400447e9fd373923f006fe2722f0b5dba79d`, deployment
`dpl_bYGwE9hYzigk4RqVVu2GJ7PnDnJX`, and generation `1` is historical evidence
for the retired marketplace only. Its first two `maintenance-v2` callbacks returned HTTP 200 at
`1787156516621` and `1787156818284`, 301,663 ms apart. The deployment had no
error/fatal logs. Both seeded pre-fence deployments were retired and returned
404, with no post-activation legacy maintenance activity. The fresh contract
starts with no active generation and requires a new address-pinned deployment
promotion from observed generation `0`.

## Required live E2E evidence — pending

The following are release blockers, not completed claims:

- [ ] Apply operator migration `0003`, repin the service to the fresh address,
  deploy disabled, verify auth/queue pins, then enable it in isolation.
- [ ] Apply withdrawal migration `0005`, repin the reconciler to the fresh
  address, deploy disabled, verify auth/queue pins, then enable it in isolation.
- [ ] Apply and verify native V2 web migrations through contract-cutover
  migration `0012`.
- [ ] Promote and prove a fresh-contract maintenance generation from observed
  generation `0`; do not reuse the retired contract's generation `1`.
- [ ] Deploy the fresh-address native web build on the isolated URL with gates
  disabled, then enable in the documented order.
- [ ] Complete one genuine X challenge and Farcaster challenge in a single
  finalized V2 bundle activation.
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
