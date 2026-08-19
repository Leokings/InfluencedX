# InfluencedX StudioNet boundary

InfluencedX Marketplace V2 currently runs on GenLayer StudioNet. StudioNet is a
developer network: its GEN token has no claimed monetary value, persistence is
temporary, and the network may reset.

## Active V2 pins

| Setting | Value |
| --- | --- |
| Network | `studionet` |
| Chain ID | `61999` |
| RPC | `https://studio.genlayer.com/api` |
| Explorer | `https://explorer-studio.genlayer.com` |
| Marketplace | `0x58D598B8323E9C1d041989DccE80E737109DE347` |
| Deployment transaction | `0x899c619e51775eed7c442ddb1c6f1fa8073a25005681935d3dda763aef2fc24a` |
| Protocol | `INFLUENCEDX_MARKETPLACE_V2` |
| Storage schema | `2` |
| Native asset | `GEN`, 18 decimals |
| Upgrade delay | `604800` seconds |

The canonical record is
[`deployments/genlayer-studionet.json`](../deployments/genlayer-studionet.json).
A runtime must compare the manifest with live schema, source, deployment receipt,
and `get_config()` before enabling mutations. A page label, screenshot, database
row, or environment variable alone is not deployment evidence.

The same manifest preserves a separately deployed APV2 resolver at
`0x0913b5593Ff16974E2fd616cA678A4986Cb48600`. Marketplace V2 does not call or
depend on that resolver; V2 implements X and Farcaster identity, campaign
resolution, and custody inside the marketplace contract. The resolver remains
historical/deployment evidence only for the former ownership protocol.

Marketplace V1 at `0x36462a0FCF2b77745d3D0C2B69eC8158F19FDE11` is retired.
It lacks the complete V2 source-keyed identity, Farcaster, deterministic time,
and native seven-day upgrade boundaries. Never send a new product write to V1.

## What StudioNet proves

A finalized StudioNet receipt can prove that validators reached consensus and
the recorded V2 call changed developer-network state. The frozen deployment
receipt and live `get_config()` check are valid developer-network evidence.

StudioNet does not, by itself, prove:

- that the public web alias is running the same release;
- that hosted operator or reconciler services are deployed and enabled;
- that X or Farcaster remained available for a specific future request;
- that a native external value-transfer child reached its EOA recipient;
- durable state after a network reset; or
- mainnet security, governance, liquidity, or real-value custody.

Those boundaries require the exact end-to-end evidence listed in
[the test report](TEST-REPORT.md).

## Wallet and value rules

- All user product writes target chain `61999` and the V2 address above.
- `create_campaign` carries the exact displayed budget in atto-GEN
  (`1 GEN = 10^18 atto-GEN`). Other normal user writes carry zero value.
- Developer-network GEN should be obtained only through the current official
  StudioNet account/faucet flow and must not be purchased or represented as
  valuable.
- The browser must display the chain, contract, method, arguments, and native
  value before signing.
- The backend accepts a change only after exact finalized receipt and V2
  post-state reconciliation.

## Native withdrawal limitation

`execute_withdrawal` emits an external native value transfer and records
`EMITTED_UNCONFIRMED`. The parent transaction alone is not proof that the EOA
was credited. The hosted withdrawal reconciler must find the unique finalized
child transfer, verify exact recipient/amount/linkage/credited value, and obtain
a finalized `withdrawal_confirmer` `confirm_withdrawal` receipt. The deployed
V2 contract already separates that restricted role from owner and upgrade
authority. Only V2 status `CONFIRMED` is a delivered
withdrawal.

The complete live StudioNet native withdrawal canary is still pending in
[the verification report](TEST-REPORT.md). Do not infer it from direct-mode
tests or reuse a historical Base payment receipt.

## Source availability boundary

Validators retrieve public X or Farcaster data during identity and campaign
consensus. Authentication blocks, rate limits, server failures, malformed
success responses, provider disagreement, and missing timestamps are
UNDETERMINED. Definitive missing evidence is accepted only under the contract's
explicit source-specific rules.

This boundary favors safety over automatic settlement availability. A source
outage may delay a campaign; it must not automatically penalize a creator.

## Reset procedure

If StudioNet resets or any pinned source/receipt/state can no longer be
verified:

1. disable web mutations, marketplace operator, and withdrawal reconciler;
2. mark all prepared calls, queue jobs, projections, identities, and campaign
   state under the old deployment scope as retired;
3. lint, directly test, review, and deploy the approved contract source;
4. write a new immutable deployment manifest instead of editing this one;
5. create a fresh database projection scope for the new chain/deployment;
6. update all three hosted projects while their gates remain false;
7. complete fresh X, Farcaster, native campaign, and confirmed withdrawal E2E;
   and
8. cut over only after new receipts and state are recorded.

Never replay an old prepared call, relabel an old receipt, or merge pre-reset
and post-reset projection rows.

## Mainnet portability

The product is structured so the chain/RPC/address/protocol/schema manifest can
be replaced for a future GenLayer mainnet deployment, but mainnet is not an
environment-variable-only switch. The StudioNet owner, upgrade administrator,
treasury, service signers, GEN, addresses, and receipts have no mainnet
authority. Follow [the deployment runbook](DEPLOYMENT.md) and complete its
mainnet gates before handling real value.

## Historical network material

Base Sepolia, test USDC, the Bradbury resolver, watchers, and the former relay
are archived in [the historical relay record](preview-base-sepolia-relay.md)
and historical manifests. They are not part of the active StudioNet V2
architecture, configuration, or E2E acceptance criteria.
