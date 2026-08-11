# InfluencedX verification report

Protocol checks began on 2026-08-08 against Base Sepolia (`84532`) and GenLayer
Bradbury; deployment state was verified on 2026-08-09. The submission package
and application test status were refreshed on 2026-08-11.

## Passing checks

### Current web application validation (2026-08-11)

- `cd web && npm test` passes 78 unit tests, the optimized Next.js 16.3.0
  production build and TypeScript check, and 5 rendered-page/static-asset smoke
  tests. The temporary smoke-test server exits at completion.
- `cd web && npm run lint` passes with no ESLint errors or warnings.
- The application-rate UI tests prove that creator metric wallets are
  normalized and deduplicated, public-profile reads are capped at four in
  parallel, only current sanitized snapshots produce a pay range, and missing
  or expired snapshots never produce placeholder pay/risk figures.
- All 16 repository Markdown files have resolving local links, and both public
  deployment manifests parse as JSON.

- Solidity compilation succeeds with Solidity `0.8.36` and pinned OpenZeppelin `5.4.0`.
- Local EVM tests pass: 2 tests. The main flow verifies a 2-of-3 creator
  attestation, metrics expiry isolation, test-USDC escrow, pull withdrawals,
  replay/source rejection, onchain 2-of-3 minimum policy, and four assignments.
  Three requests are outstanding at once and resolve independently as PASS,
  FAIL, and UNDETERMINED.
- Relay tests pass: 16 tests, including source method/request binding and 25
  concurrently prepared/signed campaign resolutions with unique request IDs
  and nested canonical evidence hashing.
- Service tests pass: 22 tests, covering APV2 marketplace behavior, encrypted
  deployer loading, guarded watcher parsing, crash-safe deployment resumption,
  Windows journal replacement, and positive/negative deployment verification.
- GenLayer direct tests pass: 13 tests covering APV2 ownership, request-envelope
  mismatch rejection, exact wallet/timestamp markers, validator-derived X
  identity, metrics, disclosure, retention, protected accounts, rate limiting,
  deleted posts, renamed accounts, and current edited text.
- `genvm-lint` accepts the resolver with its exact pinned GenVM dependency.
- Base Sepolia preflight returned chain ID `84532`; Circle test USDC at
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e` has bytecode and reports `USDC`
  with 6 decimals.
- A pre-APV2 resolver is deployed on Bradbury at
  `0x1dA39c42a76fbF902d1BA20131DdE72d91888Acd`. Five validators agreed on a live,
  unauthenticated public X metrics result. The deployment and validation
  transactions are FINALIZED with `FINISHED_WITH_RETURN`.
- The production relay source reader successfully consumed that finalized live
  transaction and confirmed the resolver address, `snapshot_metrics` method,
  exact request ID, METRICS result kind, and VERIFIED outcome.
- The current APV2 resolver deployment transaction
  `0xcbad3920c328c5fd88e38a306683a90e23264d20f851944ef8a4ba19eb2b504b`
  is FINALIZED on Bradbury at
  `0x017311b35dbB9802883bDaE7Fb0Efd7Bd77cB0b2`. Its deployed ABI exposes the
  expected eight-argument `verify_ownership` interface.
- The Base Sepolia creator registry, escrow, and attestation receiver are
  deployed at `0x10079EF049D283BC3f212CCaC4291b3aC2719C48`,
  `0x7e9B6B757d1Ef12509889826B2f2A42906661927`, and
  `0x15dDbCd98F97065746a1c35f88BB670a7A942264` respectively.
- The read-only live verifier returned `ok: true`. It confirmed all deployment
  and wiring receipts, exact creation inputs, registry runtime bytecode,
  immutable escrow/receiver configuration, owners, Base USDC, treasury, 250
  bps fee, APV2 resolver commitment, three enabled watchers, threshold two, and
  unpaused contracts.
- The current APV2 ownership request finalized on Bradbury with
  `FINISHED_WITH_RETURN`, outcome `VERIFIED`, and every request, author,
  identity, post, protocol, wallet, challenge, timestamp, and publication-window
  check set to true.
- The 2-of-3 watcher relay was simulated and broadcast to Base Sepolia in
  transaction
  `0x0b26bffd19643ea816b740432c0293eee26bccbf6b0b7cb0407cb1c3063c6406`.
  The receiver consumed the exact attestation and ownership intent, and the
  registry created active creator profile `1` for wallet
  `0x63038a310a46AC61A59c1bC5eAD5fe41040eF38e`.

## Public X stress run

Report generated at `2026-08-08T19:24:54.268Z`:

- 25 configured public accounts over 2 passes.
- 50 profile requests and 50 current-post direct/oEmbed pairs.
- 24 edge-case observations.
- 20 maximum simultaneous HTTP requests.
- 50 public profiles, 50 public posts, 2 protected observations, and 6
  unavailable observations.
- 0 rate-limit and 0 transient responses during this run.
- 25 profiles were stable between the two same-day passes.
- Renamed-handle, deleted/nonexistent, suspended, protected, old-post,
  image/video, and explicit self-thread fixtures were exercised.

The `text`/`mixed`/`video` counters are page-level signals, not authoritative
target-post media classifications: public X pages can embed conversation data.
Likewise, a conversation page is not sufficient by itself to classify a post
as a thread. The explicit thread fixture verifies root/reply IDs and author.

## Open production gates

- `adproof/` is not yet a dedicated public repository: the enclosing Git remote
  belongs to another project. Create a clean InfluencedX repository before
  publishing. The workflows already use standalone-root paths. The earlier
  nested `web/.git` metadata has been moved to the ignored recoverable backup
  documented in `DEPLOYMENT.md`, so the complete web source tree can be staged
  by the new repository.
- No stable public InfluencedX URL, three-minute demo video, or complete fresh
  campaign explorer trail is recorded in this repository yet. The live APV2
  ownership proof is complete, but the submission package still needs one
  create/fund/apply/select/accept/submit/resolve/settle campaign rehearsal.
- The multi-day observation is scheduled in `.github/workflows/x-stress.yml`,
  with previous-report cache restoration, but the current comparison is
  same-day. The workflow must be committed/pushed and run on different UTC
  dates before that row can pass.
- The Base contracts use the same EOA as deployer, owner, and treasury for this
  testnet integration. A production deployment still requires a fresh deployer,
  multisignature owner, distinct treasury, independently hosted watcher keys,
  and a separate low-balance relayer.
- The PostgreSQL migrations have not been applied to a production database;
  backup/restore and deletion-function drills remain required.
- The current APV2 resolver **has** been exercised through a live ownership
  consensus transaction and its result created Base registry profile `1` in
  transaction
  `0x0b26bffd19643ea816b740432c0293eee26bccbf6b0b7cb0407cb1c3063c6406`.
  The earlier XDevelopers `snapshot_metrics` call remains historical evidence
  only; the pre-APV2 address must never receive APV2 ownership calls.
- Campaign GenLayer submission is implemented as an idempotent OIDC-authenticated
  queue/poll bridge, but the final watcher-quorum campaign settlement remains an
  explicit operator boundary. A hosted release must demonstrate the terminal
  Bradbury result and final Base receipt before claiming automatic payment.
- No independent Solidity audit, invariant fuzzing campaign, watcher host
  failover exercise, incident runbook drill, or production submitter/relay
  service has been completed.
- `npm audit --omit=dev` reports 0 runtime vulnerabilities. The complete
  development/test tree reports 9 findings under Ganache and Solidity compiler
  tooling; those packages must not be shipped in the production runtime image.

Public X access used no OAuth token, API token, login cookie, or creator account
secret. That removes an authentication dependency, not the X dependency itself:
X still controls public-page availability and markup. Transient or ambiguous
retrieval must remain UNDETERMINED rather than FAIL.
