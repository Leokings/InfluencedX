# InfluencedX deployment and rollback runbook

This runbook deploys the submission build against the already-recorded Base
Sepolia and GenLayer Bradbury contracts. It does not authorize a mainnet launch
or a contract redeployment.

## 1. Pin the testnet boundary

| Setting | Required value |
| --- | --- |
| Base chain ID | `84532` |
| Base RPC | A dedicated Base Sepolia RPC (the public RPC is acceptable only for light test use) |
| Base Sepolia test USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Creator registry | `0x10079EF049D283BC3f212CCaC4291b3aC2719C48` |
| Campaign escrow | `0x7e9B6B757d1Ef12509889826B2f2A42906661927` |
| Attestation receiver | `0x15dDbCd98F97065746a1c35f88BB670a7A942264` |
| Bradbury APV2 resolver | `0x017311b35dbB9802883bDaE7Fb0Efd7Bd77cB0b2` |
| Watcher policy | Three enabled addresses, threshold two |

Before every release, compare those values with
[`../deployments/base-sepolia.json`](../deployments/base-sepolia.json) and
[`../deployments/genlayer-bradbury.json`](../deployments/genlayer-bradbury.json),
then run the read-only verifier:

```powershell
cd C:\path\to\adproof
npm ci
npm run contracts:compile
npm run verify:base-sepolia
```

Do not copy an address from a browser screenshot or a frontend label.

## 2. Create a clean source boundary

The current `adproof/` directory sits inside a different workspace repository.
Before publishing, create a dedicated InfluencedX repository and make this
directory its root. Do not carry the parent workspace history or remote into the
submission repository.

`web/` may retain local nested Git metadata from an earlier standalone web
checkout. If `web/.git` exists, preserve that metadata outside the source tree
before initializing the InfluencedX repository; otherwise a recursive `git add`
can record `web/` as an embedded repository instead of committing the
application files. From `adproof/`, use a recoverable move into the
already-ignored `.secrets/` tree:

```powershell
$sourceRoot = (Resolve-Path .).Path
$nestedGit = (Resolve-Path .\web\.git -ErrorAction Stop).Path
$backupRoot = Join-Path $sourceRoot '.secrets\repo-backups'
$backupGit = Join-Path $backupRoot 'web.git'

if (-not $nestedGit.StartsWith($sourceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Nested Git metadata resolved outside the InfluencedX source root.'
}
if (Test-Path -LiteralPath $backupGit) {
  throw "Refusing to overwrite the existing backup at $backupGit"
}

New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
Move-Item -LiteralPath $nestedGit -Destination $backupGit
```

Keep that backup local until the new repository has been cloned elsewhere and
the complete `web/` tree is confirmed. The committed workflows are already
root-relative; do not prepend `adproof/` to their paths.

The repository root `.gitignore` excludes:

- every `.env` variant except committed `.env.example` templates;
- `.secrets/`, keystores, password files, PEM/P12/PFX/key files;
- `.vercel/`, `.wrangler/`, Next.js output, logs, reports, and deployment
  journals.

Confirm ignore behavior without opening the files:

```powershell
git check-ignore -v web/.env.local .secrets/example.keystore.json `
  web/.vercel/project.json reports/example.json deployments/example.journal.json
```

Review filenames and staged paths before every commit. Never stage
`web/.env.local`, a database URL, an auth secret, a private key, a keystore, a
password file, an exported wallet, or Vercel project metadata. Public addresses
and transaction hashes in `deployments/*.json` are intentional.

## 3. Provision and migrate PostgreSQL

Use a managed PostgreSQL/Neon database with TLS, restricted application and
migration roles, backups, point-in-time recovery, and a tested deletion path.
Inject `DATABASE_URL` into the migration shell; do not put it in a command line,
commit, screenshot, or demo recording.

```powershell
cd web
npm ci
npm run db:migrate
npm run db:verify
```

The migration history in `web/drizzle-postgres/` includes ownership state,
rate-limit buckets, submitter state, one-time Base relay grants, marketplace
campaigns/applications/profiles, GenLayer campaign-submission columns, and the
durable fenced campaign-settlement relay and campaign-progression lease records.
`db:verify` is the release gate; a partially migrated database must not receive
traffic.

Run a restore rehearsal and the X-derived-data deletion job before treating the
database as production-ready.

## 4. Configure the web deployment

Create a Vercel project with `web/` as its root directory, Node.js 24, the Next.js
framework preset, and `npm run build` as the build command. Use separate Preview
and Production environment values.

Server-only secret groups are documented in [`../web/.env.example`](../web/.env.example):

- database/session/rate-limit/cron secrets;
- the ownership evidence-sealing keyring;
- submitter URL and OIDC bridge gates;
- Base Sepolia RPC and deployed contract addresses;
- exact public origin and independent verification/marketplace mutation gates.

None of these values may use the `NEXT_PUBLIC_` prefix. Start with both mutation
gates and the submitter bridge disabled. Deploy, verify the read-only pages, then
enable only the Preview gates required for the controlled testnet rehearsal:

- `XPROOF_VERIFICATION_MUTATIONS_ENABLED=true`
- `XPROOF_MARKETPLACE_MUTATIONS_ENABLED=true`
- `XPROOF_PREVIEW_CAMPAIGN_RETENTION_SECONDS=300` only when a controlled,
  same-day Base Sepolia rehearsal needs a five-minute resolution gate. This is
  a server-only default: the request body cannot select a sub-day retention,
  the exact effective value is committed into the campaign terms hash, and a
  configured override fails closed unless the runtime is Vercel Preview.
- `XPROOF_SUBMITTER_BRIDGE_ENABLED=true` only after the isolated submitter is
  healthy and its exact HTTPS origin is configured
- `XPROOF_AUTHORIZATION_BROKER_ENABLED=true` only for the operator-assisted
  Preview ownership relay

Production mutations remain disabled until the final security/cutover review.
Deploying `web/vercel.json` also registers the air-gapped Vercel Queues consumer
for `influencedx-campaign-progression-v1`. The confirmed Base request publishes
only its request, campaign, and application IDs; the consumer reclaims the exact
binding through a fenced Neon lease before contacting GenLayer or the Base relay.
No browser, laptop process, signer key, or watcher key participates in that
worker. Queue retries are bounded and the database remains the authoritative
idempotency boundary.

The daily cleanup cron and optional authenticated progression-recovery route
additionally require an independent `CRON_SECRET`. The recovery route is not a
minute cron and is not part of the normal queue path.

## 5. Deploy the isolated Bradbury submitter

Deploy `services/vercel-bradbury-submitter/` as a separate Vercel project. It is
the only hosted process that may hold the funded Bradbury testnet signer. Follow
its [service README](../services/vercel-bradbury-submitter/README.md) and use the
safe names in its `.env.example`.

Required controls:

1. Keep the signer key server-only and scoped to Bradbury testnet.
2. Validate the exact Vercel team, project, environment, issuer, audience, and
   submitter stage claims from the short-lived OIDC token.
3. Allow only the pinned resolver and fixed ownership/campaign methods.
4. Keep the application database reader away from the private submission-job
   table.
5. Leave the service disabled until migrations and reconciliation checks pass.

Do not replace Vercel OIDC with a long-lived shared bearer token.

## 6. Preview release sequence

1. Run all commands in [the verification report](TEST-REPORT.md).
2. Migrate and verify the Preview database.
3. Deploy the isolated submitter with its enable gate still false.
4. Deploy the web project with all mutation gates false.
5. Confirm the landing page, campaign directory empty/loading/error states,
   public creator profile, contract links, and Base Sepolia chain prompt.
6. Enable the submitter, then Preview verification and marketplace mutations.
7. Complete one fresh-wallet ownership proof and confirm both Bradbury finality
   and the Base registry receipt.
8. Complete one full campaign rehearsal: create, approve/fund, apply, select,
   accept, submit a canonical X URL, request resolution, and reach Bradbury
   finality.
9. Have two independent watchers relay the campaign result and confirm the final
   Base settlement receipt before calling the rehearsal paid or refunded.
10. Run the [three-minute demo checklist](DEMO-SCRIPT.md) without showing any
    secret-bearing terminal, hosting settings page, or wallet recovery material.

Every displayed state must come from the API or chain receipt. Do not use a demo
fixture to label a campaign funded, verified, paid, or refunded.

## 7. Rollback and reconciliation

If a release fails:

1. Disable marketplace, verification, submitter, and authorization-broker gates.
2. Stop new jobs, but do not delete database rows or rebroadcast transactions.
3. Restore the previous known-good Vercel deployment.
4. Reconcile every prepared or submitted transaction by hash against Base or
   Bradbury before retrying it.
5. Resume an idempotent request only after the database state matches the chain.
6. Rotate a secret only if exposure is suspected; keep retiring evidence keys
   available until every ciphertext sealed under them has expired or completed.

Base and GenLayer transactions are immutable. A web rollback never rolls back a
campaign, ownership proof, or escrow event.

## 8. Contract redeployment and mainnet gates

The current testnet deployment deliberately uses the same EOA as deployer,
owner, and treasury, and the watcher threshold is 2-of-3. If contracts must be
redeployed, use the guarded scripts and journal described by their `--help`
output, write a new immutable manifest, and never overwrite the existing
addresses. Use a distinct low-balance relayer and the encrypted watcher setup in
[WATCHER-KEYS.md](WATCHER-KEYS.md).

A mainnet launch additionally requires, at minimum:

- fresh deployments with a multisignature owner and distinct treasury;
- independently operated watcher hosts, alerting, failover, and a reviewed
  GenLayer-to-Base transport decision;
- independent Solidity/GenLayer review, invariant/fuzz testing, incident drills,
  and escrow accounting review;
- dedicated RPC providers, observability, database backup/restore and deletion
  drills, legal/privacy review, and a controlled production cutover.

Base Sepolia ETH, Base Sepolia test USDC, and Bradbury state have no monetary
value. Passing this runbook makes the submission reproducible; it does not turn
the testnet deployment into a production mainnet system.
