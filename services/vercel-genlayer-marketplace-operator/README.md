# InfluencedX GenLayer Marketplace Operator

An isolated, disabled-by-default StudioNet service for three permissionless marketplace maintenance calls:

- `resolve_assignment(assignment_id, request_id)`
- `expire_assignment(assignment_id)`
- `finalize_campaign(campaign_id)`

It cannot accept a target, method, arbitrary argument array, or native value from a caller. The target is the configured marketplace contract, the method is selected from the fixed allowlist, arguments are derived from a strict request shape, and the only write adapter hard-codes `value: 0n`.

The service is address- and protocol-driven for Marketplace V2, deployed on
StudioNet at `0x58D598B8323E9C1d041989DccE80E737109DE347` with protocol
`INFLUENCEDX_MARKETPLACE_V2` and storage schema `2`. It deliberately does
**not** operate retired V1 at `0x36462a0FCF2b77745d3D0C2B69eC8158F19FDE11`.
Keep it disabled until the exact address, ABI, live `get_config()`, database
migration, queue, signer separation, and authorized caller deployment have all
been verified.

## Security boundary

Public ingress (`POST /v1/operations`) and status (`GET /v1/operations/:operationId`) require both:

1. a Vercel OIDC token whose issuer, audience, subject, owner/team, project, and environment claims exactly match configuration; and
2. the independent `x-influencedx-service-token` header.

The push consumer is configured as a Vercel Queue trigger on `influencedx-genlayer-marketplace-ops-v1`. Vercel makes a route with a `queue/v2beta` trigger inaccessible from the public internet. Messages are still treated as hostile: only `{schemaVersion, operationId}` is accepted and the durable envelope and fingerprints are revalidated before the signer is touched.

The PostgreSQL signer gate is singleton and fenced. Its two-minute lease exists only during read-only precheck. The lease becomes non-expiring before broadcast. If broadcasting returns an error, or the process crashes before the hash is persisted, the operation is quarantined and the signer stays fenced until manual reconciliation. This is intentionally availability-sacrificing.

Before signing, the operator re-reads the exact contract and checks StudioNet chain `61999`, `get_config()` protocol/schema identity, action eligibility, request binding, and deadlines. After the transaction reaches `FINALIZED`, it requires the live StudioNet nested receipt fields:

```text
consensus_data.leader_receipt[0].execution_result = SUCCESS
consensus_data.leader_receipt[0].result.status = return
```

That exact pair is recorded as `FINISHED_WITH_RETURN`. The transaction hash, signer, contract, decoded method, decoded arguments, and raw native value must also match. The operator then re-reads finalized contract state and verifies the exact state/accounting transition before reporting `FINALIZED`.

## Required environment

All variables are required when enabled:

| Variable | Exact purpose |
| --- | --- |
| `INFLUENCEDX_MARKETPLACE_OPERATOR_ENABLED` | Must be exactly `true`; any other value keeps the service disabled. |
| `INFLUENCEDX_MARKETPLACE_OPERATOR_STAGE` | `studionet` |
| `INFLUENCEDX_GENLAYER_NETWORK` | `studionet` |
| `INFLUENCEDX_GENLAYER_CHAIN_ID` | `61999` |
| `INFLUENCEDX_GENLAYER_MARKETPLACE_ADDRESS` | `0x58D598B8323E9C1d041989DccE80E737109DE347`; non-zero lower/upper input is normalized to lower case. |
| `INFLUENCEDX_GENLAYER_MARKETPLACE_PROTOCOL` | `INFLUENCEDX_MARKETPLACE_V2`, matching live `get_config().protocol_version`. |
| `INFLUENCEDX_GENLAYER_MARKETPLACE_SCHEMA_VERSION` | `2`, matching live `get_config().storage_schema_version`. |
| `GENLAYER_MARKETPLACE_OPERATOR_PRIVATE_KEY` | Dedicated zero-fund StudioNet operator key. Never reuse an owner/governance key. |
| `DATABASE_URL` | Private PostgreSQL connection URL. |
| `INFLUENCEDX_OPERATOR_SERVICE_TOKEN` | Independent random 32-byte hex token. |
| `INFLUENCEDX_OPERATOR_CALLER_TEAM_SLUG` | Exact allowed Vercel team slug. |
| `INFLUENCEDX_OPERATOR_CALLER_TEAM_ID` | Exact allowed Vercel `team_...` ID. |
| `INFLUENCEDX_OPERATOR_CALLER_PROJECT_NAME` | Exact caller project name. |
| `INFLUENCEDX_OPERATOR_CALLER_PROJECT_ID` | Exact caller `prj_...` ID. |
| `INFLUENCEDX_OPERATOR_CALLER_ENVIRONMENT` | `preview` or `production`, and must match `VERCEL_ENV`. |

Vercel Queue uses the deployment workload's OIDC automatically. Outside Vercel, the queue SDK additionally needs its standard `VERCEL_QUEUE_API_TOKEN`; that is not an ingress credential.

## Integration contract

`POST /v1/operations` accepts exactly one of:

```json
{"schemaVersion":1,"action":"resolve_assignment","assignmentId":"0x…64 lowercase hex…","requestId":"0x…64 lowercase hex…"}
```

```json
{"schemaVersion":1,"action":"expire_assignment","assignmentId":"0x…64 lowercase hex…"}
```

```json
{"schemaVersion":1,"action":"finalize_campaign","campaignId":"0x…64 lowercase hex…"}
```

Extra fields are rejected. The response is `202` for a new operation or `200` for an idempotent replay and contains the deterministic `operation.operationId`. Poll `GET /v1/operations/:operationId` with the same two credentials. No private envelope or state snapshot is returned.

The web/backend integration must create requests only after reading the authoritative v2 contract state. Replaying the same action and arguments produces the same operation ID. An operation in `PRECHECK_FAILED` can be replayed after its deadline becomes eligible. `RECONCILIATION_REQUIRED` is terminal and requires an operator investigation; never create a replacement job or signer key to bypass it.

## Setup and verification

```powershell
npm ci
npm run migrate
npm run lint
npm test
npm run build
npm audit --omit=dev
```

Deploy this directory as its own Vercel project only after v2 is deployed and verified. Run the migration against a private database, configure every exact environment binding, leave `INFLUENCEDX_MARKETPLACE_OPERATOR_ENABLED=false`, deploy, verify the queue trigger exists, then enable it in a new deployment.

## Governance boundary

Owner-only withdrawal reconciliation (`confirm_withdrawal` / `restore_failed_withdrawal`), pause/unpause, fee changes, treasury changes, and upgrades are intentionally excluded. They require a separate governance service/process, distinct keys, independent approvals, a seven-day timelock, and an audit trail. Do not add those methods to this operator's signer adapter or queue topic.

Vercel Queues currently provides at-least-once delivery and an air-gapped push consumer when configured with a `queue/v2beta` trigger. See the [Vercel Queues documentation](https://vercel.com/docs/queues).
