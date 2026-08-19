# InfluencedX GenLayer marketplace V2

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
3. `CONFIRMED`: the owner reconciler supplied finalized transfer evidence.
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
`influencedx-resolution-result-v2` evidence hash. It binds the request,
assignment, campaign, frozen terms, agreement, submission, post, creator
handle, stable identity, content source, round, outcome, and every deterministic/semantic check. Validators
compare this hash directly; human-readable reasoning is fixed product copy and
cannot be supplied by a leader.

## Deployment and administration

Constructor arguments are
`(treasury: Address, protocol_fee_bps: u256, upgrade_admin: Address)`. The
fee is capped at 1,000 bps and snapshotted into each campaign. Treasury and
two-step owner-transfer addresses cannot be zero. Pause blocks new risk while
refund, withdrawal, and recovery paths stay available.

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
