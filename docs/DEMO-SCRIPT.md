# InfluencedX GenLayer V2 three-minute demo

Record this demo only after the isolated V2 E2E and public cutover gates in
[the deployment runbook](DEPLOYMENT.md) pass. Every success state must come from
the public API plus matching finalized GenLayer contract state. Do not edit
database rows, use a hard-coded success fixture, reuse a historical Base
receipt, or describe `EMITTED_UNCONFIRMED` as paid.

## Recording checklist

- [ ] The public URL resolves to the exact tested V2 release commit.
- [ ] The live app pins StudioNet `61999`, marketplace
      `0x58D598B8323E9C1d041989DccE80E737109DE347`, protocol
      `INFLUENCEDX_MARKETPLACE_V2`, and schema `2`.
- [ ] Web migrations through `0009_genlayer_native_marketplace.sql` and
      `npm run db:verify` pass.
- [ ] Verification and marketplace mutation gates are enabled only on the
      tested release.
- [ ] Marketplace operator and withdrawal reconciler are deployed, healthy,
      enabled, and bound to the exact web workload identity.
- [ ] Separate brand and creator wallets have developer-network GEN and are
      clearly labeled.
- [ ] A genuine public X challenge/post and genuine public Farcaster
      challenge/cast are retrievable while logged out.
- [ ] A short source-specific campaign has completed enough real state in
      advance to avoid waiting for retention/finality during the recording.
- [ ] The native withdrawal used in the demo is contract status `CONFIRMED`,
      with exact parent, child, and confirmation hashes recorded.
- [ ] Explorer/API tabs are pre-opened to the actual V2 deployment and demo
      transactions.
- [ ] Wallet recovery material, private keys, `.env` files, database URLs,
      hosting settings, service tokens, terminal history, and raw private
      pitches are outside the capture area.
- [ ] Notifications are off, browser zoom is readable, and the finished video
      is at most three minutes.
- [ ] Cuts occur only between real completed states and are disclosed; no cut
      changes a pending state into an apparent success.

## Timed script

### 0:00–0:20 — Product and trust model

Show the InfluencedX landing/marketplace page and say:

> InfluencedX is a GenLayer creator marketplace. Brands escrow native GEN,
> creators prove an X or Farcaster identity, and GenLayer validators judge the
> published work against rules frozen when the campaign was created.

Briefly show the deployment banner/address and state that this demo uses
StudioNet developer tokens and temporary, resettable state—not mainnet value.

### 0:20–0:45 — Two identity sources

Show a creator profile with its source-keyed X and Farcaster records. Open one
actual finalized activation receipt for each source, or show the live contract
profile and the linked hashes if time is short.

Say:

> The wallet signs each activation directly. Validators retrieve the public
> challenge and bind the stable X user ID or Farcaster FID; the backend cannot
> invent that identity and a mutable handle is not the identity key.

Never show the one-time challenge before it is safely public/expired or expose
private session material.

### 0:45–1:15 — Create and fund with native GEN

Open Create Campaign. Show the chosen content source, semantic brief,
required/forbidden phrases, disclosure requirement, deadlines, retention, and
budget.

Open the wallet confirmation and point to StudioNet, the V2 contract,
`create_campaign`, and the exact GEN value. Then show the finalized campaign
state and V2 balance/accounting.

Say:

> Campaign creation freezes these terms and sends the exact GEN budget into the
> same GenLayer contract. There is no Base escrow, USDC approval, watcher, or
> cross-chain relay in V2.

### 1:15–1:50 — Apply, select, and accept

Switch to the creator wallet and apply with a rate and private pitch. Switch to
the brand, select that application, then return to the creator and accept the
assignment. Show one finalized transaction/state transition rather than waiting
through every wallet prompt in real time.

Say:

> Users sign their own lifecycle calls. The private pitch stays in the
> authorized application store while its commitment is onchain. The backend
> advances only after matching the exact sender, method, arguments, value,
> finalized receipt, and contract post-state.

### 1:50–2:25 — Publish and resolve

Show the genuine public X post or Farcaster cast while logged out. Submit its
canonical post ID or cast hash, then show the assignment's retained/submitted
state.

Cut to the real eligible resolution. Show the hosted operator operation and the
final V2 outcome. State only the actual result:

- PASS credits the creator less the snapshotted fee;
- FAIL credits the brand; or
- UNDETERMINED preserves funds for the contract's retry/refund rules.

Say:

> The operator cannot choose an arbitrary call; it can only trigger fixed,
> zero-value permissionless maintenance. Validators independently retrieve the
> frozen source and produce this bound outcome.

### 2:25–2:48 — Confirmed native withdrawal

Show the claimable credit, user-signed request and execute hashes, then the
withdrawal reconciler record and V2 withdrawal status `CONFIRMED`. Point briefly
to the exact native transfer child and owner confirmation receipt.

Say:

> InfluencedX never calls an emitted transfer paid. A separate reconciler proves
> the exact finalized child transfer, and only the contract's CONFIRMED state is
> displayed as delivered.

If confirmation is not complete, do not record a payment demo. State that it is
pending and omit any paid/refunded claim.

### 2:48–3:00 — Close

Show the architecture diagram or V2 deployment record and say:

> GenLayer owns identity, campaign custody, resolution, and settlement;
> PostgreSQL is a private application store and projection. StudioNet proves
> the testnet product flow today, while mainnet requires fresh governance,
> security review, and target-network deployment evidence.

End on the public URL and repository README.

## Submission evidence

- Public V2 URL and exact source commit used for the recording.
- Public repository URL and three-minute captioned video.
- Marketplace V2 address, deployment transaction, source hash, and manifest.
- One finalized X activation and one finalized Farcaster activation.
- One native-GEN campaign trail: create, apply, select, accept, submit, and
  terminal resolution.
- One credit/withdrawal trail with parent, child, confirmation, and final
  `CONFIRMED` state.
- Hosted operator/reconciler operation IDs and sanitized status evidence.
- Architecture diagram, exact test commands/results/date, and clear StudioNet
  limitation.

Keep an unedited source recording privately through the judging period. Never
publish secrets or private creator pitches as supporting evidence.
