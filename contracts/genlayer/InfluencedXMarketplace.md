# InfluencedX GenLayer marketplace V3

`InfluencedXMarketplace.py` is the authoritative GenLayer-only marketplace and
escrow state machine. `AdProofXResolver.py` remains in the repository only as a
historical deployed protocol; the new marketplace does not depend on it.

## Trust boundary

- GenLayer owns caller-bound creator credentials, immutable campaign terms,
  native GEN escrow, applications commitments, assignments, frozen submission
  evidence, consensus resolution, refunds, fees, credits, and withdrawals.
- The application database may index public contract state and retain private
  pitches, sessions, notifications, and encrypted/deletable supporting data. A
  private pitch is represented onchain only by `pitch_commitment`.
- X or Farcaster owns the raw public identity and post/cast evidence. A creator
  may bind both sources to one wallet. Stable X user IDs and Farcaster FIDs are
  unique per wallet; mutable handles/usernames are not treated as identities.
  Every campaign freezes `content_source`, and its application/assignment
  freezes that source's stable identity. Validators independently fetch the
  exact frozen evidence. No successful source plus a transient failure is
  `UNDETERMINED`; definitive missing evidence produces `FAIL` after retention.

## Native value model

Campaign creation is payable and requires `gl.message.value == budget_atto`.
One GEN is `10^18` atto-GEN. A PASS credits the selected creator minus the
campaign's snapshotted fee and credits the campaign's snapshotted treasury. A
FAIL credits the brand. Credits are pull-based.

Withdrawals deliberately use four observable states:

1. `PENDING`: value is reserved from the user's claimable balance.
2. `EMITTED_UNCONFIRMED`: an external native transfer to the EOA was emitted.
3. `CONFIRMED`: the narrowly scoped withdrawal confirmer supplied finalized
   transfer evidence.
4. `RESTORED_FAILED`: after the recovery delay, while paused, the owner supplied
   failure evidence, recapitalized the exact lost value, and restored the user
   credit.

GenLayer does not automatically return value from a failed child transfer.
`recapitalize_failed_withdrawal` therefore requires exact new native value and
is mandatory before restoration. It cannot silently consume another campaign's
escrow.

The contract enforces after every money transition:

```text
available + reserved + creator_paid + brand_refunded + fee == campaign budget
escrow + claimable + pending_withdrawal + emitted_unconfirmed == liability
contract_balance + emitted_unconfirmed >= liability
```

## Deterministic IDs

All IDs are lowercase `0x`-prefixed SHA-256 digests. Fields are joined with a
literal `|`; integers use base-10 strings.

- Ownership: `xproof-x-ownership-v2|wallet|handle|post|challenge|issued|expires|profile_expires`
- Farcaster ownership: `influencedx-farcaster-ownership-v1|wallet|username|fid|cast_hash|challenge|issued|expires|profile_expires`
- Campaign: `influencedx-campaign-v2|brand|client_nonce|terms_hash|budget_atto`
- Application: `influencedx-application-v1|campaign_id|creator`
- Assignment: `influencedx-assignment-v1|campaign_id|creator|agreed_rate_atto|agreement_hash`
- Resolution: `influencedx-resolution-v2|assignment_id|agreement_hash|submission_hash|content_source|post_id_or_cast_hash|round`
- Withdrawal: `influencedx-withdrawal-v1|account|next_nonce|amount_atto`

The campaign terms hash is the SHA-256 of canonical JSON (sorted keys and no
spaces) containing the normalized content source, title and brief, phrase arrays, disclosure
rule, three deadlines, retention, and retry limit. Public `compute_*` methods
are the canonical client-side source for all IDs.

Each terminal resolution also stores a deterministic
`influencedx-resolution-result-v3` evidence hash. It binds the request,
assignment, campaign, frozen terms, agreement, submission, post, creator
handle, stable identity, content source, round, outcome, whether semantic
evaluation ran, and every deterministic/semantic check. Validators compare
this hash directly; human-readable reasoning is fixed product copy and cannot
be supplied by a leader.

## Bounded resolution delivery

`resolve_assignment` is now the deterministic, onchain admission step. It
increments `resolution_attempts`, moves the assignment to `RESOLVING`, stores
the exact pending request and round, and emits two ordered finalized self
messages:

1. `execute_resolution_attempt` evaluates the frozen public evidence and
   records `PASS`, `FAIL`, or retryable `UNDETERMINED`.
2. `record_resolution_failure` is an idempotent fallback. It records
   `UNDETERMINED` only when the execution child did not advance the pending
   attempt, including when validator disagreement prevents that child from
   committing.

Deterministic checks are completed before semantic evaluation. If they already
prove the submission cannot pass, the semantic model is not called. Model
errors and malformed semantic results are recorded as retryable
`UNDETERMINED`, rather than reverting the attempt.

Finalized same-recipient transactions are ordered, so the fallback observes
the execution child's committed state. If message delivery itself is
interrupted, anyone can call `recover_resolution_failure` after the 15-minute
recovery delay. A pending attempt does not move escrow; only a terminal child
settles the reservation, while `UNDETERMINED` remains in the existing bounded
retry and refund flow.

## Deployment and administration

Constructor arguments are
`(treasury: Address, protocol_fee_bps: u256, upgrade_admin: Address, withdrawal_confirmer: Address)`.
The
fee is capped at 1,000 bps and snapshotted into each campaign. Treasury and
all constructor role addresses cannot be zero. Pause blocks new risk while
refund, withdrawal, and recovery paths stay available.

`confirm_withdrawal` is callable only by `withdrawal_confirmer`. That role has
no pause, fee, treasury, ownership, recovery, or upgrade authority. The owner
may rotate it with `set_withdrawal_confirmer`; exceptional recapitalization and
restoration remain owner-only. The contract rejects a confirmer that overlaps
the owner, pending owner, or upgrade administrator, including across owner
transfer and confirmer rotation.

For an in-place upgrade, the appended `withdrawal_confirmer` slot starts at the
zero address because constructors do not rerun. Confirmation therefore fails
closed until the owner initializes the role with `set_withdrawal_confirmer`.
A fresh deployment supplies the role as the fourth constructor argument.

The dedicated upgrade administrator is the only GenVM Root upgrader. An
upgrade must be scheduled by the exact SHA-256 of the new source, the
marketplace must already be paused, and execution is impossible until at least
604,800 seconds (seven full days) later. Rescheduling restarts the delay; the
owner or upgrade administrator may cancel. Execution rechecks pause, sender,
delay, code size, and exact bytes before replacing Root code. Storage layout is
append-only and constructors do not rerun during upgrades.

The public ABI is produced by:

```powershell
genvm-lint check contracts/genlayer/InfluencedXMarketplace.py --json
```

Direct-mode coverage is in
`tests/direct/test_influencedx_marketplace.py`; consensus validator behavior and
chain-layer transfer finalization must additionally be exercised on the target
GenLayer network before real-value launch.
