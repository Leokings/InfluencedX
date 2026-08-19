# InfluencedX three-minute demo

The demo must show live API/chain-backed state. Do not edit database rows, use
hard-coded campaign fixtures, or describe a pending transaction as funded,
verified, paid, or refunded.

## Recording checklist

Complete these before pressing Record:

- [ ] A stable public InfluencedX URL is reachable in a private/incognito window.
- [ ] The deployed address table in the root README matches the live build.
- [ ] Preview database migrations and `npm run db:verify` pass.
- [ ] Preview verification, marketplace, and StudioNet submitter gates are enabled.
- [ ] The isolated submitter is healthy and the exact Vercel OIDC identity matches.
- [ ] Brand wallet has Base Sepolia ETH and enough Base Sepolia test USDC.
- [ ] Creator wallet has Base Sepolia ETH and an active public creator profile.
- [ ] Brand and creator are separate browser profiles or clearly labeled wallets.
- [ ] One short campaign is already funded for the main walkthrough; retain a
      separate blank form to show what brands commit.
- [ ] A compliant public X post is ready, canonical, and retrievable while logged out.
- [ ] Two independent testnet watchers and the low-balance Base relayer are ready
      if the recording claims final Base settlement.
- [ ] Wallet recovery phrases, private keys, `.env` files, hosting environment
      pages, database URLs, keystore paths/passwords, and terminal history are
      closed and excluded from capture.
- [ ] Browser zoom is readable, notifications are off, and transaction explorer
      tabs are pre-opened.
- [ ] The final video is at most three minutes and contains no long confirmation
      waits; cut only between real completed states and identify the cut.

## Timed script

### 0:00-0:20 — Problem and trust model

Show the landing page and say:

> InfluencedX is an X creator marketplace. Brands escrow test USDC on Base
> Sepolia, creators prove control of a public X identity without OAuth, and
> GenLayer evaluates the published work against rules frozen when the campaign
> was funded.

Point briefly to “Base Sepolia” and “GenLayer StudioNet.” State that this is a
developer-network submission, StudioNet state is temporary/resettable, and the
current GenLayer-to-Base transport uses a 2-of-3 watcher quorum.

### 0:20-0:45 — Live ownership proof

Open the public creator profile. Show the wallet, X handle commitment,
credential status/expiry, and only evidence-backed sanitized metrics. Open the
[recorded Base proof transaction](https://sepolia.basescan.org/tx/0x0b26bffd19643ea816b740432c0293eee26bccbf6b0b7cb0407cb1c3063c6406)
and identify active registry profile `1`.

Say:

The linked profile was created during the earlier Bradbury phase and is retained
as historical evidence. Do not describe it as a StudioNet proof. For the current
walkthrough, use a fresh profile whose APV2 result finalized on StudioNet and
say:

> This state came from a live APV2 result finalized on StudioNet and relayed to
> the Base registry; it is not a UI fixture.

### 0:45-1:15 — Brand creates and funds a campaign

Open Create Campaign. Show budget, deliverables, disclosure requirement,
required/forbidden phrases, semantic brief, and deadline. Explain that these
become one canonical terms document and hash.

Open the pre-created campaign and show the real funding receipt. If recording a
fresh transaction, show the exact test-USDC approval and campaign-create wallet
prompts, then the API-backed `FUNDED` state after receipt confirmation.

### 1:15-1:50 — Marketplace agreement

Switch to the verified creator wallet, explicitly showing the wallet control.
Apply with a pitch and creator-set rate. Switch to the brand wallet, select that
application, and show the Base transaction confirmation. Switch back to the
creator and accept the exact agreement through the wallet.

Say:

> Pitches are private to the owning brand. Selection and acceptance are not
> database toggles; each state waits for its pinned Base event.

### 1:50-2:25 — Submit public work and request resolution

Show the public X post logged out, paste its canonical
`https://x.com/<handle>/status/<id>` URL, and submit the evidence commitment.
After the retention gate, request resolution and show the Base request receipt.

Show the StudioNet lifecycle changing from queued/submitted/polling to finalized.
State the actual result (`PASS`, `FAIL`, or `UNDETERMINED`) only after the API
reports terminal finality.

### 2:25-2:45 — Base settlement

If two watchers have relayed the finalized result, open the final Base receipt
and show the campaign state plus escrow accounting. Describe pull-based payout
or brand credit according to the actual event.

If that receipt is not complete, say:

> GenLayer finality is complete; the explicit watcher-quorum Base settlement is
> still pending, so InfluencedX does not label this campaign paid or refunded.

Do not substitute a local simulation for a live settlement claim.

### 2:45-3:00 — Close

Show the architecture diagram or deployed-address table and say:

> Base holds agreements and test funds, GenLayer judges public X evidence, and
> PostgreSQL holds deletable marketplace data. The submission is Base Sepolia
> plus StudioNet today; mainnet requires new contracts, independent review, and a
> stronger cross-chain operations plan.

End on the public URL and repository README.

## Evidence to include with the submission

- Public InfluencedX URL and commit hash used for the recording.
- Dedicated public repository URL.
- Three-minute video URL with captions or clear narration.
- Base registry, escrow, receiver, test-USDC, and live-proof explorer links.
- StudioNet resolver address and deployment transaction.
- Architecture diagram and concise testnet disclaimer.
- Exact test commands and the date/commit on which they passed.
- One fresh-wallet ownership proof and one complete campaign transaction trail.

Keep an unedited copy of the recording privately until submission judging ends.
