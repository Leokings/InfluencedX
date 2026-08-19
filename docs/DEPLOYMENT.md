# InfluencedX deployment and rollback runbook

This runbook deploys the submission build against the recorded Base Sepolia
contracts and the current GenLayer StudioNet resolver. It does not authorize a
mainnet launch or a Base contract redeployment. StudioNet is temporary and may
be reset; treat every StudioNet deployment and proof as replaceable demo state.

The current hosted submission build is
[influencedx-preview.vercel.app](https://influencedx-preview.vercel.app). Its
six Preview deployments are enabled: web, StudioNet submitter, three isolated
watchers, and the settlement coordinator/low-balance Base relayer. These hosted
services do not depend on a developer laptop remaining online.

## 1. Pin the developer-network boundary

| Setting | Required value |
| --- | --- |
| Base chain ID | `84532` |
| Base RPC | A dedicated Base Sepolia RPC (the public RPC is acceptable only for light test use) |
| Base Sepolia test USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Creator registry | `0x10079EF049D283BC3f212CCaC4291b3aC2719C48` |
| Campaign escrow | `0x7e9B6B757d1Ef12509889826B2f2A42906661927` |
| Attestation receiver | `0x15dDbCd98F97065746a1c35f88BB670a7A942264` |
| GenLayer network | StudioNet (`61999`) |
| GenLayer RPC | `https://studio.genlayer.com/api` |
| StudioNet APV2 resolver | `0x0913b5593Ff16974E2fd616cA678A4986Cb48600` |
| Receiver cutover transaction | [`0x6b203216de54bf5be136c8eb66f90c55c0479887fe743be643088682290bc839`](https://sepolia.basescan.org/tx/0x6b203216de54bf5be136c8eb66f90c55c0479887fe743be643088682290bc839) |
| Receiver current state | StudioNet resolver pinned; unpaused |
| Watcher policy | Three enabled addresses, threshold two |

Before every release, compare those values with
[`../deployments/base-sepolia.json`](../deployments/base-sepolia.json) and
[`../deployments/genlayer-studionet.json`](../deployments/genlayer-studionet.json),
then run the read-only verifier:

```powershell
cd C:\path\to\adproof
npm ci
npm run contracts:compile
npm run verify:base-sepolia
```

Do not copy an address from a browser screenshot or a frontend label.

## 2. Preserve the dedicated source boundary

The project has a dedicated public repository at
[github.com/Leokings/InfluencedX](https://github.com/Leokings/InfluencedX).
The repository root is the InfluencedX source boundary and the `origin` remote
must continue to point to `Leokings/InfluencedX`; do not publish it through an
unrelated parent workspace or restore nested `web/.git` metadata into the
source tree. The committed workflows are root-relative.

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

Before publishing, confirm the remote and source boundary without printing any
secret-bearing files:

```powershell
git remote -v
git status --short
git ls-files web
```

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

None of these values may use the `NEXT_PUBLIC_` prefix. For a new environment,
start with both mutation gates and every bridge disabled, deploy, and verify the
read-only pages before enabling them. The current controlled Preview has these
gates enabled after migration, binding, and simulation checks:

- `XPROOF_VERIFICATION_MUTATIONS_ENABLED=true`
- `XPROOF_MARKETPLACE_MUTATIONS_ENABLED=true`
- `XPROOF_PREVIEW_CAMPAIGN_RETENTION_SECONDS=300` only when a controlled,
  same-day Base Sepolia rehearsal needs a five-minute resolution gate. This is
  a server-only default: the request body cannot select a sub-day retention,
  the exact effective value is committed into the campaign terms hash, and a
  configured override fails closed unless the runtime is Vercel Preview.
- `XPROOF_SUBMITTER_BRIDGE_ENABLED=true` after the isolated submitter is
  healthy and its exact HTTPS origin is configured
- `XPROOF_AUTHORIZATION_BROKER_ENABLED=true` for the scoped Preview ownership
  relay authorization path
- `XPROOF_CAMPAIGN_RELAY_BRIDGE_ENABLED=true` after all three watcher services
  and the coordinator simulation/broadcast gates pass

These are Preview testnet settings, not authorization for a Production/mainnet
release. Deploying `web/vercel.json` registers the air-gapped Vercel Queues
consumer for `influencedx-studionet-campaign-progression-v2`. The confirmed
Base request publishes only its request, campaign, and application IDs; the
consumer reclaims the exact binding through a fenced Neon lease before
contacting GenLayer or the Base relay. No browser, laptop process, signer key,
or watcher key participates in that worker. Queue retries are bounded and the
database remains the authoritative idempotency boundary.

The daily cleanup cron and optional authenticated progression-recovery route
additionally require an independent `CRON_SECRET`. The recovery route is not a
minute cron and is not part of the normal queue path.

The old
[`../deployments/genlayer-bradbury.json`](../deployments/genlayer-bradbury.json)
record is historical evidence only. Never copy its resolver into current
configuration.

## 5. Deploy the isolated StudioNet submitter

Deploy `services/vercel-bradbury-submitter/` as a separate Vercel project. It is
the only hosted process that may hold the StudioNet signer. The directory name
is retained as an internal compatibility path; it does not select the network.
Follow
its [service README](../services/vercel-bradbury-submitter/README.md) and use the
safe names in its `.env.example`.

Required controls:

1. Keep the signer key server-only and scoped to StudioNet. StudioNet calls are
   gasless, so do not fund this key with real assets.
2. Validate the exact Vercel team, project, environment, issuer, audience, and
   submitter stage claims from the short-lived OIDC token.
3. Allow only the pinned resolver and fixed ownership/campaign methods.
4. Keep the application database reader away from the private submission-job
   table.
5. Leave the service disabled until migrations and reconciliation checks pass.

Its Vercel Queues consumer is pinned to
`influencedx-studionet-submissions-v1`; do not reuse the historical queue topic
or point the consumer at another GenLayer network.

Do not replace Vercel OIDC with a long-lived shared bearer token.

## 6. Preview release sequence

1. Run all commands in [the verification report](TEST-REPORT.md).
2. Migrate and verify the Preview database.
3. Deploy the isolated submitter with its enable gate still false.
4. Deploy the web project with all mutation gates false.
5. Confirm the landing page, campaign directory empty/loading/error states,
   public creator profile, contract links, and Base Sepolia chain prompt.
6. Enable the three watchers, coordinator simulation, coordinator broadcast,
   submitter, web bridges, and finally Preview verification/marketplace
   mutations in that order.
7. Complete one fresh-wallet ownership proof and confirm both StudioNet finality
   and the Base registry receipt.
8. Complete one full campaign rehearsal: create, approve/fund, apply, select,
   accept, submit a canonical X URL, request resolution, and reach StudioNet
   finality.
9. Allow the hosted coordinator to collect at least two matching watcher
   signatures and relay the result automatically. Confirm the final Base
   settlement receipt before calling the rehearsal paid or refunded.
10. Run the [three-minute demo checklist](DEMO-SCRIPT.md) without showing any
    secret-bearing terminal, hosting settings page, or wallet recovery material.

Every displayed state must come from the API or chain receipt. Do not use a demo
fixture to label a campaign funded, verified, paid, or refunded.

The infrastructure portion of this sequence is live on Preview. Steps 7-10
remain the submission-evidence gap: record a fresh StudioNet ownership flow, a
complete campaign through the final Base receipt, and the three-minute demo
video.

## 7. Rollback and reconciliation

If a release fails:

1. Disable marketplace, verification, submitter, and authorization-broker gates.
2. Stop new jobs, but do not delete database rows or rebroadcast transactions.
3. Restore the previous known-good Vercel deployment.
4. Reconcile every prepared or submitted transaction by hash against Base or
   StudioNet before retrying it.
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

Base Sepolia ETH, Base Sepolia test USDC, and StudioNet state have no monetary
value. StudioNet state is also resettable and must not be treated as durable.
Passing this runbook makes the submission reproducible; it does not turn the
developer-network deployment into a production mainnet system.
