# InfluencedX StudioNet boundary

InfluencedX currently resolves ownership, creator metrics, and campaign work on
GenLayer StudioNet. Base Sepolia continues to hold creator commitments,
campaign agreements, test-USDC custody, and settlement state.

## Pinned values

| Setting | Value |
| --- | --- |
| Network | `studionet` |
| Chain ID | `61999` |
| RPC | `https://studio.genlayer.com/api` |
| APV2 resolver | `0x0913b5593Ff16974E2fd616cA678A4986Cb48600` |
| Deployment transaction | `0xc723b84f49e6842419ac926808d962c4611678b02fbb5b1b1cdba6fe94920591` |
| Deployment state | `FINALIZED` / `MAJORITY_AGREE` |

The canonical public record is
[`../deployments/genlayer-studionet.json`](../deployments/genlayer-studionet.json).
Do not use a UI label, screenshot, database row, or the historical Bradbury
manifest as runtime configuration.

## What the cutover changes

- New GenLayer submissions use StudioNet and the resolver above.
- The Base Sepolia attestation receiver accepts only results bound to the
  current resolver after its owner-controlled source update.
- Hosted submitter, watcher, relay, web, and database defaults must use the same
  network/resolver pair before mutation gates are enabled.
- A proof signed or submitted for the former resolver cannot be replayed as a
  StudioNet proof. Start a fresh ownership or campaign request after cutover.

Some internal identifiers retain `bradbury` in migration filenames, PostgreSQL
table names, source paths, and stable error codes. They are compatibility
identifiers for existing data and deployments, not active network selectors.
Renaming them destructively would risk losing reconciliation history.

## Reset limitation

StudioNet is gasless and intended for development. Its state is temporary and
may be reset. After a reset:

1. deploy and verify a fresh resolver;
2. write a new immutable StudioNet manifest;
3. keep all mutation and relay gates disabled;
4. migrate the hosted network/resolver pair and update the Base receiver source;
5. run a fresh end-to-end ownership and campaign proof before re-enabling the
   public workflow.

StudioNet receipts must never be presented as durable production or mainnet
evidence.
