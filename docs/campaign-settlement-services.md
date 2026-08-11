# InfluencedX automatic campaign settlement runbook

This runbook is for Base Sepolia + GenLayer Bradbury Preview. It does not
authorize a Mainnet cutover.

## Project topology

| Vercel project | Root directory | Private key held | Trusted caller |
| --- | --- | --- | --- |
| InfluencedX web | `web` | none for settlement | browser wallet sessions |
| campaign watcher 1 | `services/vercel-campaign-watcher` | watcher 1 only | relay coordinator Preview project |
| campaign watcher 2 | `services/vercel-campaign-watcher` | watcher 2 only | relay coordinator Preview project |
| campaign watcher 3 | `services/vercel-campaign-watcher` | watcher 3 only | relay coordinator Preview project |
| campaign relay | `services/vercel-campaign-relay` | dedicated low-balance Base relayer only | InfluencedX web Preview project |

The three watcher projects deploy the same immutable source revision, but must
use different Vercel project IDs, origins, service tokens, signer keys, and
watcher addresses. The coordinator never receives watcher private keys. A
watcher never receives `DATABASE_URL` or the relayer key.

## Authentication and Trusted Sources

Enable Vercel Deployment Protection on all four private service projects. Each
server-to-server request sends the same short-lived Vercel OIDC token in:

- `Authorization: Bearer <token>` for the application's exact claim check; and
- `x-vercel-trusted-oidc-idp-token: <token>` for Vercel Deployment Protection.

Do not replace either header with a permanent bypass token. The application
also requires a 32-byte-or-longer service token, unique per boundary.

Configure exact claims, never team-wide/wildcard callers:

- every watcher: `XPROOF_CALLER_*` identifies the campaign relay Preview
  project and `XPROOF_WATCHER_SERVICE_TOKEN` is unique to that watcher;
- relay coordinator: `XPROOF_CALLER_*` identifies the InfluencedX web Preview
  project and `XPROOF_RELAY_SERVICE_TOKEN` matches the web bridge secret;
- web: its Vercel workload identity calls only the relay coordinator origin.

Do not add browser origins, public webhooks, arbitrary cron projects, Production
environments, or the Bradbury submitter as trusted callers.

## Environment variables

Watcher project (repeat independently for 1/2/3):

```text
XPROOF_CAMPAIGN_WATCHER_ENABLED
XPROOF_CAMPAIGN_WATCHER_STAGE
XPROOF_SETTLEMENT_CONFIG_EPOCH
XPROOF_BASE_CHAIN_ID
XPROOF_BASE_SEPOLIA_RPC_URL
XPROOF_GENLAYER_RPC_URL
XPROOF_BASE_ESCROW
XPROOF_BASE_RECEIVER
XPROOF_GENLAYER_RESOLVER
XPROOF_WATCHER_PRIVATE_KEY            [Sensitive]
XPROOF_WATCHER_ADDRESS
XPROOF_WATCHER_SERVICE_TOKEN          [Sensitive, unique]
XPROOF_CALLER_TEAM_SLUG
XPROOF_CALLER_TEAM_ID
XPROOF_CALLER_PROJECT_NAME
XPROOF_CALLER_PROJECT_ID
XPROOF_CALLER_ENVIRONMENT
```

Relay coordinator:

```text
DATABASE_URL                           [Sensitive]
XPROOF_CAMPAIGN_RELAY_ENABLED
XPROOF_CAMPAIGN_RELAY_STAGE
XPROOF_CAMPAIGN_RELAY_BROADCAST_ENABLED
XPROOF_SETTLEMENT_CONFIG_EPOCH
XPROOF_BASE_CHAIN_ID
XPROOF_BASE_SEPOLIA_RPC_URL
XPROOF_GENLAYER_RPC_URL
XPROOF_BASE_ESCROW
XPROOF_BASE_RECEIVER
XPROOF_GENLAYER_RESOLVER
XPROOF_BASE_RELAYER_PRIVATE_KEY        [Sensitive]
XPROOF_BASE_RELAYER_ADDRESS
XPROOF_RELAYER_MAX_BALANCE_WEI
XPROOF_RELAY_SERVICE_TOKEN             [Sensitive]
XPROOF_WATCHER_1_URL
XPROOF_WATCHER_1_ADDRESS
XPROOF_WATCHER_1_SERVICE_TOKEN         [Sensitive]
XPROOF_WATCHER_2_URL
XPROOF_WATCHER_2_ADDRESS
XPROOF_WATCHER_2_SERVICE_TOKEN         [Sensitive]
XPROOF_WATCHER_3_URL
XPROOF_WATCHER_3_ADDRESS
XPROOF_WATCHER_3_SERVICE_TOKEN         [Sensitive]
XPROOF_CALLER_TEAM_SLUG
XPROOF_CALLER_TEAM_ID
XPROOF_CALLER_PROJECT_NAME
XPROOF_CALLER_PROJECT_ID
XPROOF_CALLER_ENVIRONMENT
```

InfluencedX web additions:

```text
XPROOF_CAMPAIGN_RELAY_BRIDGE_ENABLED
XPROOF_SETTLEMENT_CONFIG_EPOCH
XPROOF_APP_ORIGIN
XPROOF_CAMPAIGN_RELAY_URL
XPROOF_CAMPAIGN_RELAY_SERVICE_TOKEN    [Sensitive]
```

The checked-in `.env.example` files contain every non-secret pin and no live
credential.

## Migration and verification

Migration `0006_campaign_settlement_relay.sql` must be applied exactly once
after 0005. Inject `DATABASE_URL` from the Preview secret manager, then run from
`web` without placing the URL on the command line:

```powershell
npm.cmd run db:migrate
npm.cmd run db:verify
```

`db:verify` is read-only and now requires the 21-column fenced relay table.
Neither command belongs in `vercel-build`.

## Safe key setup

1. Generate or import three independent watcher keys through an approved secret
   manager/offline ceremony. Record only their public addresses in normal
   configuration.
2. Put each watcher private key in only its matching Vercel project as a
   Sensitive variable. Never export the three keys into one machine/process.
3. Generate a fresh Base-only relayer account. It must not equal a watcher,
   deployer, owner/Safe, treasury, submitter, brand, or creator account.
4. Keep the relayer unfunded while testing with broadcast disabled. Immediately
   before cutover, fund it with only the Base Sepolia ETH required for a small
   number of settlement transactions and keep its balance below
   `XPROOF_RELAYER_MAX_BALANCE_WEI` (example cap: 0.01 ETH).
5. Never paste private keys into chat, source, logs, tickets, screenshots,
   browser storage, or shell arguments.

## Preview cutover

### One-shot credential and environment setup

After all five projects have a READY Preview deployment, assign these exact
fixed Preview aliases:

- `influencedx-preview.vercel.app`
- `influencedx-campaign-watcher-1-preview.vercel.app`
- `influencedx-campaign-watcher-2-preview.vercel.app`
- `influencedx-campaign-watcher-3-preview.vercel.app`
- `influencedx-campaign-relay-preview.vercel.app`

The setup deliberately accepts only those fixed aliases; it rejects generated,
Production, stale, or lookalike URLs. Then run the reviewed setup ceremony once
from `adproof/` in a real PowerShell terminal:

```powershell
npm.cmd run settlement:configure:preview -- --apply
```

The command first validates every Vercel project identity and stable Preview
alias, the existing three encrypted watcher keystores, the Base receiver's
2-of-3 configuration, the Preview database source, and the fresh relayer's
zero balance plus zero latest and pending nonce. It then requires the exact
visible confirmation phrase. The encrypted Base deployer password is requested
without echoing only after every Vercel environment entry and disabled safety
flag has been written and verified.

It stores only a fresh encrypted relayer keystore, its random binary password,
and public funding metadata beneath gitignored
`.secrets/campaign-settlement-preview/`. The password file is a plaintext
testnet-secret backup protected by owner-only filesystem ACLs; handle it like a
private key and never copy it to shared storage. Watcher keys and the relayer
key are decrypted only in this short-lived ceremony process. Four unique
service tokens exist only in memory and travel to Vercel through stdin; they
are never written or printed. Each key is uploaded only to its matching
Preview project.

Environment variables are upserted one at a time. All watcher, relay,
broadcast, and bridge flags are forced to `false` across the five projects
before any trust-link token rotates. A new readable
`XPROOF_SETTLEMENT_CONFIG_EPOCH` is stamped last on all five projects, so equal
epochs prove that every unreadable token copy converged. No deployment is
triggered by this ceremony.

If the ceremony stops after creating `.secrets/campaign-settlement-preview/`,
do not run the new-wallet command again. Resume the exact persisted relayer:

```powershell
npm.cmd run settlement:resume:preview
```

Recovery revalidates the hosted Neon connection, OIDC/Trusted Sources, fixed
aliases, Base wiring, environment metadata, and all `false` flags. It rewrites
the complete linked token set with fresh in-memory values and a new epoch; it
never invents a second relayer. Funding is last. The exact bounded transaction
is signed and stored as an owner-only replayable intent before broadcast, so a
crash can reconcile the known hash instead of signing or paying twice.

Once the five Preview projects are redeployed, the hosted watcher/relay/web
services do not depend on this laptop remaining online. The local encrypted
files are recovery backups for the testnet ceremony, not runtime workers.

This is a deliberate Base Sepolia bootstrap exception to the normal
one-watcher-per-host rule. It is not a Mainnet key ceremony. The setup command
leaves watcher enablement, relay enablement, relay broadcast, and the web bridge
set to `false`; environment changes require fresh Preview deployments.

### Activation order

1. Verify both service packages: root `npm run test:services` and
   `npm run build:campaign-settlement-services`.
2. Apply and verify 0006.
3. Deploy/enable all three watchers; confirm each configured public address is
   enabled on the receiver and the receiver threshold is at least two.
4. Deploy the coordinator with
   `XPROOF_CAMPAIGN_RELAY_BROADCAST_ENABLED=false`; exercise a finalized fixture
   through simulation only.
5. Add minimal relayer gas and enable coordinator broadcast on Preview.
6. Enable the web bridge last. Its existing RESOLVING poll calls the coordinator
   after the GenLayer projection reaches FINALIZED and retries the same request
   ID until Base is mirrored.

If a transaction hash or receipt becomes ambiguous, stop. The durable job is
`RECONCILIATION_REQUIRED`; investigate that hash/onchain request before any
manual state repair. Never delete or reset the fence to force a rebroadcast.
