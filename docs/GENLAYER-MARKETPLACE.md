# InfluencedX Marketplace V2 protocol and operations

This document is the operator-facing reference for the active GenLayer-only
protocol. The source of truth is
[`contracts/genlayer/InfluencedXMarketplace.py`](../contracts/genlayer/InfluencedXMarketplace.py);
the source-level design record is
[`contracts/genlayer/InfluencedXMarketplace.md`](../contracts/genlayer/InfluencedXMarketplace.md).

## Deployment identity

| Field | Frozen StudioNet value |
| --- | --- |
| Network / chain | `studionet` / `61999` |
| Contract | `0x58D598B8323E9C1d041989DccE80E737109DE347` |
| Deployment transaction | `0x899c619e51775eed7c442ddb1c6f1fa8073a25005681935d3dda763aef2fc24a` |
| Protocol | `INFLUENCEDX_MARKETPLACE_V2` |
| Storage schema | `2` |
| Source SHA-256 | `0xf6dbcfaf11456096c11bf8dbcc729238d3b31156e842c5ba01f694915c4d3323` |
| Native unit | GEN / 18 decimals |
| Upgrade delay | `604800` seconds |

The frozen address above is the fresh deployment of the current ABI. Its
constructor initialized a dedicated `withdrawal_confirmer` that is distinct
from the owner and upgrade administrator. The hosted reconciler is restricted
to that role and cannot pause, change fees or treasury, transfer ownership, or
schedule an upgrade. Future code changes still require the onchain seven-day,
hash-bound, pause-gated upgrade path; constructors do not rerun during an
in-place upgrade.

Always compare these values with
[`deployments/genlayer-studionet.json`](../deployments/genlayer-studionet.json)
and live `get_config()` before enabling writes. V1 at
`0x36462a0FCF2b77745d3D0C2B69eC8158F19FDE11` is retired and must never receive
new product calls.

## Candidate caller matrix

| Operation | Expected caller | Native value | Hosted automation |
| --- | --- | ---: | --- |
| `activate_creator` | creator wallet | `0` | Never |
| `activate_farcaster_creator` | creator wallet | `0` | Never |
| `create_campaign` | brand wallet | exact `budget_atto` | Never |
| `apply_to_campaign`, `withdraw_application` | creator wallet | `0` | Never |
| `select_creator`, `cancel_campaign`, `refund_unallocated` | campaign brand | `0` | Never |
| `accept_assignment`, `decline_assignment`, `submit_evidence` | selected creator | `0` | Never |
| `resolve_assignment`, `expire_assignment`, `finalize_campaign` | permissionless | `0` | Marketplace operator allowlist |
| `refund_undetermined` | contract-authorized lifecycle caller | `0` | Not in the operator allowlist |
| `request_withdrawal`, `execute_withdrawal` | credit owner | `0` | Never |
| `confirm_withdrawal` | withdrawal confirmer | `0` | Withdrawal reconciler only |
| `recapitalize_failed_withdrawal`, `restore_failed_withdrawal` | contract owner | exact policy value / `0` | Manual governance only |
| pause, fee, treasury, withdrawal-confirmer rotation, owner transfer | contract owner | `0` | Manual governance only |
| schedule/cancel/execute upgrade | upgrade admin (owner may cancel) | `0` | Manual governance only |

The web app prepares user calls but never holds a user private key. The two
hosted services use distinct keys, databases or isolated schemas, service
tokens, Vercel workload identities, and queue topics.

## Identity sources

### X

`activate_creator` binds a wallet, normalized handle, public challenge post,
challenge timestamps, and profile expiry. Validators fetch the public post and
profile and derive the immutable numeric X user ID. The handle is display data;
the stable ID and identity hash prevent a renamed or transferred handle from
silently replacing the verified identity.

### Farcaster

`activate_farcaster_creator` binds a wallet, normalized username, positive FID,
public challenge cast hash, challenge timestamps, and profile expiry. Validators
check the username proof and cast evidence. The FID is the stable identity; the
username is display data.

A creator may activate both sources. A campaign chooses exactly one source and
only an active identity for that source can apply. X content IDs are numeric
post IDs; Farcaster content IDs are 20-byte cast hashes.

Renewal may update a mutable handle or username only when the source's stable X
user ID or Farcaster FID remains unchanged. A wallet cannot replace its stable
identity for an already-bound source.

## Campaign and assignment states

```text
CAMPAIGN: OPEN -> CANCELLED
                 \-> CLOSED

APPLICATION: APPLIED -> WITHDRAWN
                     \-> SELECTED
                     \-> DECLINED

ASSIGNMENT: SELECTED -> ACCEPTED -> SUBMITTED
                                  -> DECLINED
                                  -> EXPIRED
             SUBMITTED -> UNDETERMINED -> retry SUBMITTED
                       -> SETTLED_PASS
                       -> SETTLED_FAIL
             UNDETERMINED -> REFUNDED after the contract delay/rules
```

Campaign terms include source, title, semantic brief, required and forbidden
phrases, disclosure requirement, application/selection/submission deadlines,
retention, and bounded UNDETERMINED retry limit. The terms hash and campaign ID
are deterministic. Applications commit private pitches rather than publishing
them onchain.

Resolution freezes assignment, agreement, submission, source, stable identity,
content ID, and retry round into a deterministic request. Validator equivalence
uses a deterministic evidence hash; human-readable reasoning is not allowed to
replace the bound checks.

## Resolution outcomes

- **PASS:** credit the creator the agreed rate less the campaign's snapshotted
  fee and credit the snapshotted treasury.
- **FAIL:** credit the brand under the frozen campaign accounting.
- **UNDETERMINED:** preserve funds and follow bounded retry/delay rules. It is
  used for transient, ambiguous, malformed, or inconsistent public-source
  evidence and must never be displayed as FAIL.

The external source remains mutable and potentially unavailable. Resolution
must be requested only after the frozen retention period. A definitive missing
result is accepted only under the contract's exact multi-provider/source rules.

## Native GEN accounting

`create_campaign` is the only normal user action with native value. Its value
must equal the exact displayed `budget_atto`; value on any zero-value method is
rejected. One GEN equals `10^18` atto-GEN.

The contract enforces:

```text
available + reserved + creator_paid + brand_refunded + fee == campaign budget
escrow + claimable + pending_withdrawal + emitted_unconfirmed == liability
contract_balance + emitted_unconfirmed >= liability
```

Credits are pull-based. A withdrawal is:

1. `PENDING` after the user reserves claimable credit;
2. `EMITTED_UNCONFIRMED` after the external value transfer is emitted;
3. `CONFIRMED` only after exact finalized delivery evidence is reconciled; or
4. `RESTORED_FAILED` only through the paused, delayed, recapitalized manual
   recovery path.

Never present `EMITTED_UNCONFIRMED` as paid. The reconciler's `FINALIZED`
projection is acceptable only when the matching contract withdrawal itself is
`CONFIRMED` with the same evidence hash.

## Seven-day upgrades

The upgrade administrator schedules the SHA-256 of the complete candidate code
while V2 is paused. `execute_upgrade` is impossible before seven full days and
rechecks pause, caller, deadline, byte length, and exact code hash. Rescheduling
restarts the timer. The owner or upgrade administrator can cancel.

An upgrade review must include:

- `genvm-lint` and direct/integration results for the exact candidate bytes;
- an append-only storage-layout comparison;
- published source hash, intended changes, and rollback/incident plan;
- monitoring of the complete seven-day review period;
- a post-upgrade `get_config()`, schema, source, and representative read check;
  and
- a new immutable deployment/upgrade record without rewriting the V2 manifest.

The seven-day delay is a minimum review window, not a security audit.

## Service isolation

The [marketplace operator](../services/vercel-genlayer-marketplace-operator/README.md)
and [withdrawal reconciler](../services/vercel-genlayer-withdrawal-reconciler/README.md)
are disabled by default. Both require exact Vercel OIDC claims plus independent
32-byte service tokens. Their air-gapped Vercel Queue consumers treat messages
as hostile and use durable idempotency and signer fencing.

Queue topics are:

- web progression: `influencedx-studionet-campaign-progression-v3`;
- operator: `influencedx-genlayer-marketplace-ops-v1`; and
- withdrawal reconciliation: `influencedx-genlayer-withdrawal-reconciliation-v1`.

Do not reuse the historical StudioNet submitter, Base relay, or watcher topics.

## Operator checks

Before enabling a hosted mutation gate, record:

- manifest, chain ID, RPC origin, address, protocol, schema, and `get_config()`
  all agree;
- database migrations and deployment-scoped uniqueness checks pass;
- service caller team/project/environment claims are exact;
- service token and signer keys are distinct and server-only;
- operator signer has no owner or upgrade role;
- after the candidate ABI is deployed and initialized, the withdrawal signer
  derives to the exact configured `withdrawal_confirmer` and to no governance
  role;
- queue consumer route and topic are exact;
- disabled deployment rejects work;
- wrong OIDC, token, body fields, address, method, arguments, value, or receipt
  all fail closed; and
- alerts cover signer fencing, poison messages, poll exhaustion, and manual
  reconciliation.

Follow [the deployment runbook](DEPLOYMENT.md) for sequencing. Public cutover is
pending until the E2E evidence in [the test report](TEST-REPORT.md) is complete.
