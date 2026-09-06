# InfluencedX V3 StudioNet review evidence

## Candidate identity

- Contract: [`0x492175c248168DDB9571CBF4c6A14296e3348181`](https://explorer-studio.genlayer.com/address/0x492175c248168DDB9571CBF4c6A14296e3348181)
- Deployment: [`0x3e3b7e8a10ab46c5e19638c3efd6816d78911d10213188571cbd4393f6494da8`](https://explorer-studio.genlayer.com/tx/0x3e3b7e8a10ab46c5e19638c3efd6816d78911d10213188571cbd4393f6494da8)
- Protocol: `INFLUENCEDX_MARKETPLACE_V3`
- Storage schema: `3`
- Exact deployed source SHA-256: `0x6e97a6f97ff96af9cd14f2b06e0ac86db4b2965b1bba49f4e7548dd77fe6f2e6`
- Deployment status: `FINALIZED`, `MAJORITY_AGREE`, successful contract return

The reviewer-facing application is active on V3 at
[`influencedx-native-preview.vercel.app`](https://influencedx-native-preview.vercel.app).
The prior V2 deployment is retained only as a rollback reference.

## Reviewer preview activation

- Stable application URL: [`influencedx-native-preview.vercel.app`](https://influencedx-native-preview.vercel.app)
- Web deployment: `dpl_EGRbfUZS7DJWCM1XUWkjzzXKxVzG`
- Marketplace operator deployment: `dpl_Hd5jUhMsDJQMcQJLY4Hy5qCVMLeY`
- Withdrawal reconciler deployment: `dpl_CDQWSvi5k5k8ZfPx4QmvDjCxtahd`
- Maintenance activation: generation `2`, promoted and active
- Live smoke check: marketplace `200`, V3 address present, V2 address absent
- Projection check: campaign API `200` with no V2 campaign leakage
- Mutation-gate check: authenticated-origin route reached request validation

## Wallet-session persistence and active reviewer campaign

Commit `d537426` moves marketplace wallet state into one root provider and
restores the signed, site-wide session independently of wallet-injection timing.
The authenticated cookie remains `HttpOnly`, `Secure`, `SameSite=Strict`, and
`Path=/`; route navigation does not require another signature. Verify-flow
authorization and sign-out refresh the shared wallet state so the marketplace
and identity routes remain synchronized.

- Live cross-route check: the same authorized wallet restored on Create,
  Verify, and Dashboard after full route loads
- Browser result: no application error overlay on the reviewer campaign
- Web unit suite: 282 tests passed, including one root wallet provider and
  route-wide restoration coverage
- Lint: passed
- Production build: passed
- Reviewer campaign: [`660ddc9d-00a5-4e72-9748-833b47ce7c2f`](https://influencedx-native-preview.vercel.app/marketplace/campaigns/660ddc9d-00a5-4e72-9748-833b47ce7c2f)
- On-chain campaign: `0x4d84fee99e5354cda2ef24013278eb1f2c0cf313d6bd95fbf88a197629e48837`
- Finalized funding: [`0x3d8757dc048749925734dd1cd225ec7f9a7488e0ed99a4681e16f6f595da2288`](https://explorer-studio.genlayer.com/tx/0x3d8757dc048749925734dd1cd225ec7f9a7488e0ed99a4681e16f6f595da2288)
- Live state: `OPEN`, `FUNDED`, applications close October 6, 2026

## Bounded resolution verification

- `resolve_assignment` commits the attempt and exact pending request before
  nondeterministic work begins.
- It emits ordered finalized `execute_resolution_attempt` and
  `record_resolution_failure` self-messages.
- The first child short-circuits semantic evaluation when deterministic checks
  already fail.
- Semantic errors and malformed model output become recorded retryable
  `UNDETERMINED` outcomes.
- The second child records validator-disagreement or execution-child failure as
  retryable `UNDETERMINED` if the first child did not advance state.
- A permissionless 15-minute recovery closes the path if both automatic child
  deliveries are interrupted.
- Direct-mode suite: 64 tests passed.
- GenVM lint: 53 ABI methods; 22 view and 31 write methods.
- Operator suite: 34 tests passed, including parent/child polling and exact
  pending-state accounting.
- Web unit suite: 281 tests passed, including retryable journal handling for
  the pending child stage.

## Finalized V3 native-value canary

The isolated candidate accepted one atto-GEN as campaign escrow, cancelled the
campaign into brand credit, reserved that credit for withdrawal, emitted the
external transfer, and the child transfer finalized with `value_credited=true`.

- Campaign: `0xa25446d2f064b44a987544cb325b90f69a8dcae2acbaac6404eef97dad9cad7a`
- Fund campaign: [`0xfd3fb49980f481b0277ae1c17651886a477608c6e62e0126959b27a7d47335eb`](https://explorer-studio.genlayer.com/tx/0xfd3fb49980f481b0277ae1c17651886a477608c6e62e0126959b27a7d47335eb)
- Cancel and credit brand: [`0xcd9911ce25ef70c3ccc7ec46efad16a1e4e7643b7d1513b8b06dac925dabdf66`](https://explorer-studio.genlayer.com/tx/0xcd9911ce25ef70c3ccc7ec46efad16a1e4e7643b7d1513b8b06dac925dabdf66)
- Request withdrawal: [`0xde19ce44530c5085f5f0982a25b473de4eb590813bc02ed6476ec885dec50fa9`](https://explorer-studio.genlayer.com/tx/0xde19ce44530c5085f5f0982a25b473de4eb590813bc02ed6476ec885dec50fa9)
- Execute withdrawal: [`0x9c5c19f68722219789622c672c409d2bc768f40c89c6f8a5ea870138546e39a2`](https://explorer-studio.genlayer.com/tx/0x9c5c19f68722219789622c672c409d2bc768f40c89c6f8a5ea870138546e39a2)
- Finalized emitted transfer: [`0x3b42d68dcc4719c27a43109e5a89c1c26cd356d46e3b7e26a0e6818d8e4ff124`](https://explorer-studio.genlayer.com/tx/0x3b42d68dcc4719c27a43109e5a89c1c26cd356d46e3b7e26a0e6818d8e4ff124)
- Withdrawal: `0x85e54dbac42ff96a3d91e3bfacc349053e7837d4e873955273b0f791a381bb21`
- Evidence hash: `0x8c12c61226dc3e25020fe9416e88e8c383d9c9458f783891d43554908d2d711d`

This earlier one-atto exploratory liability remains `EMITTED_UNCONFIRMED`; its
emitted child is finalized and credited. The submitted full-lifecycle canary
below has its own finalized `confirm_withdrawal` receipt.

## Finalized identity activation

The lifecycle uses a persistent, encrypted StudioNet-only signer. Validators
independently verified both public identities in one atomic bundle transaction.

- Wallet: [`0x1fB2b8daEB8B1E547F5Ef8328f94b3ce7c309A9F`](https://explorer-studio.genlayer.com/address/0x1fB2b8daEB8B1E547F5Ef8328f94b3ce7c309A9F)
- X proof: [`@plain3rd` post `2095949720933786077`](https://x.com/plain3rd/status/2095949720933786077)
- Farcaster proof: [`@milechain` cast `0x563855c3`](https://farcaster.xyz/milechain/0x563855c3)
- Full Farcaster cast hash: `0x563855c38743aa03f1eecb32844cb751549b4284`
- Activation: [`0x59ba036e0b3ecc50dc585ece31d8cc8de63ce243942053852168265faade6e0f`](https://explorer-studio.genlayer.com/tx/0x59ba036e0b3ecc50dc585ece31d8cc8de63ce243942053852168265faade6e0f)
- Bundle request: `0x9bf0ce11ab4dc24a068a70fb5f53b11f610f766292969d19b2f94345e674df3f`
- X request: `0xafc096b84485a2c364aa5b3263f1dd73c777e3d72ffa536bf930102fc274f0c4`
- Farcaster request: `0x5e8b255bce3b4b81f0cccaf8816f67504aa64c645c47acacdc0a3d8f5beb8124`
- Result: `VERIFIED`; profile active for both `X` and `FARCASTER`

## Finalized funded campaign lifecycle

The same verified wallet acted as the test brand and creator. The campaign
funded 100 atto-GEN, reserved the full amount for the accepted assignment,
and used a public Farcaster cast published after acceptance.

- Campaign: `0x9e52fb167f7e949554e4dc93304b3954dfdba24379d88e96ca890486f18faaea`
- Fund campaign: [`0x93d22158ca148afdbbed002b1327aa8f6954499ef79f97ec8fae22cff8e84a2d`](https://explorer-studio.genlayer.com/tx/0x93d22158ca148afdbbed002b1327aa8f6954499ef79f97ec8fae22cff8e84a2d)
- Creator application: [`0x992f71e8dfcaf717a39905612ed25072ac1c2a70bb00b229249b43d5f2689bd2`](https://explorer-studio.genlayer.com/tx/0x992f71e8dfcaf717a39905612ed25072ac1c2a70bb00b229249b43d5f2689bd2)
- Creator selection: [`0x9a7c0cb1efd9a1fa0a86b1624b57a092db7b65c117ec4882da37de55c112d6d7`](https://explorer-studio.genlayer.com/tx/0x9a7c0cb1efd9a1fa0a86b1624b57a092db7b65c117ec4882da37de55c112d6d7)
- Assignment acceptance: [`0xd917d21d10b440bcd0485eceb3e8a7e401460bc099379c4c7182e34a8dc1e03b`](https://explorer-studio.genlayer.com/tx/0xd917d21d10b440bcd0485eceb3e8a7e401460bc099379c4c7182e34a8dc1e03b)
- Assignment: `0x6003d34da6eb9a43c50b628d95b865ede095d7276dd753b503385bb6ae2a2ed8`
- Campaign evidence: [`@milechain` cast `0x7878cb2b`](https://farcaster.xyz/milechain/0x7878cb2b)
- Full evidence cast hash: `0x7878cb2b583714ff9662706b50370093fe080131`
- Submission: [`0x18d7a5bac177f55867bc3b9c58158626787f29c826a437706796fb426b053e42`](https://explorer-studio.genlayer.com/tx/0x18d7a5bac177f55867bc3b9c58158626787f29c826a437706796fb426b053e42)
- Resolution request: `0x1d554b4d9a0077950eb4d5f052c510397c239196cad568b667274e6a31118bec`
- Resolution parent: [`0x280c6a92e043a1adc7cb340ce050d0c1a500b89e0adcda8fa33c801d78e35dc5`](https://explorer-studio.genlayer.com/tx/0x280c6a92e043a1adc7cb340ce050d0c1a500b89e0adcda8fa33c801d78e35dc5)
- Evaluation child: [`0x88574c47c128e16688815f198d808a2fdeaf8bec771bedfaf4e7c61639930fc5`](https://explorer-studio.genlayer.com/tx/0x88574c47c128e16688815f198d808a2fdeaf8bec771bedfaf4e7c61639930fc5)
- Ordered fallback child: [`0xe1d2a69e0c024fcc1f87d4d4b5eb47533034a4bda53fcbe8e785ca624aeecde3`](https://explorer-studio.genlayer.com/tx/0xe1d2a69e0c024fcc1f87d4d4b5eb47533034a4bda53fcbe8e785ca624aeecde3)
- Final assignment state: `SETTLED_PASS`, outcome `PASS`, attempts `1`
- Deterministic checks: author, cast hash, stable FID, publication window,
  both required phrases, forbidden phrase absence, and `#ad` all passed
- Semantic check: evaluated and passed
- Resolution evidence hash: `0x32208ad6464f170638baac275a2f350dc1be0f63475ec4e711f08846303f634f`
- Settlement: creator credit `98` atto-GEN; protocol fee `2` atto-GEN

## Finalized and confirmed creator withdrawal

- Withdrawal: `0xca46af640a00a3daf49aec2fe7d4a2e4fbf56f068d99f5127a479d41939aa258`
- Request withdrawal: [`0xa92865a16b94f4e83568902c3a302efeb1935af46232129b1881c7d17787fa13`](https://explorer-studio.genlayer.com/tx/0xa92865a16b94f4e83568902c3a302efeb1935af46232129b1881c7d17787fa13)
- Execute withdrawal: [`0x2b9278f6099870f29a6da8e66799723a9131fe3f7d37055007e1e0f108bb7796`](https://explorer-studio.genlayer.com/tx/0x2b9278f6099870f29a6da8e66799723a9131fe3f7d37055007e1e0f108bb7796)
- Finalized emitted transfer: [`0x79e83b9565d45c6e34cd07839b1aee124104f431af655de77be287b13132d84e`](https://explorer-studio.genlayer.com/tx/0x79e83b9565d45c6e34cd07839b1aee124104f431af655de77be287b13132d84e)
- Transfer result: recipient matched; amount `98` atto-GEN;
  parent linkage matched; `value_credited=true`
- Transfer evidence hash: `0x3cf197036e9362c26e0cdf9d0a6d00dd15cdd482e8e12139f8c8f49f1e3e55ad`
- Isolated-candidate confirmer rotation: [`0xb3d6e744f4cb29fe46520af36e169aa09d197b27eea633f2090f2b9000f286ff`](https://explorer-studio.genlayer.com/tx/0xb3d6e744f4cb29fe46520af36e169aa09d197b27eea633f2090f2b9000f286ff)
- Finalized `confirm_withdrawal`: [`0x5aa41e2a1bbd5a2dde151f8c9d2b1bbc983fbdc284327e69d782477db28fdc3b`](https://explorer-studio.genlayer.com/tx/0x5aa41e2a1bbd5a2dde151f8c9d2b1bbc983fbdc284327e69d782477db28fdc3b)
- Hosted-service confirmer restoration: [`0x321730ce272f979e711b5bcc9033ee30b6831f2648409aab9c048f4ab7499fa2`](https://explorer-studio.genlayer.com/tx/0x321730ce272f979e711b5bcc9033ee30b6831f2648409aab9c048f4ab7499fa2)
- Contract withdrawal state: `CONFIRMED`; reconciled at epoch `1788551732`

The restricted confirmer verified the finalized credited child and bound its
evidence hash into V3. This completes the funded campaign, submission,
resolution, withdrawal, emitted transfer, and on-chain confirmation path. The
review signer was used only to prove the submitted canary. V3 was then restored
to the existing restricted hosted confirmer at
`0xaafc5d9075a404d82b8ee1692f7ff802168c5dd8` for the reviewer-preview cutover.
