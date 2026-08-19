# RETIRED: Bradbury ownership proof -> Base Sepolia

> **Do not run this procedure after the StudioNet cutover.** It is retained only
> to explain the historical Base transaction recorded in the verification
> report. Its proof, transaction hash, and resolver are bound to Bradbury and
> cannot be replayed or relabeled as StudioNet evidence. New ownership proofs
> must be submitted through the hosted StudioNet pipeline and finalized against
> resolver `0x0913b5593Ff16974E2fd616cA678A4986Cb48600`.

The historical one-shot operator relayed the then-pinned InfluencedX ownership proof from
GenLayer Bradbury to the deployed Base Sepolia attestation receiver. It is not a
generic relayer and it refuses Production.

## Prerequisites

- `web/.vercel/.env.preview.local` was freshly pulled from the InfluencedX **Preview**
  environment. The launcher deletes any inherited `DATABASE_URL`,
  `VERCEL_ENV`, and `VERCEL_TARGET_ENV` before Node loads this file.
- Migration `0004_base_relay_authorization.sql` is applied to Preview Neon.
- The target is the latest READY InfluencedX Vercel Preview deployment and its
  authorization broker is enabled.
- The encrypted testnet watcher files and funded Base Sepolia relayer keystore
  are present under `.secrets/`. The relayer password is known to the operator.

## Disabled entry point

The npm launch entry was removed during the StudioNet cutover so this historical
Bradbury ceremony cannot be invoked accidentally. The source remains only for
audit and regression-test provenance.

The program performs, in order:

1. Exact Preview DB, terminal Bradbury lifecycle, and successful execution
   checks.
2. Base Sepolia contract, resolver, registry, replay, deadline, and watcher
   configuration checks using public data only.
3. A five-minute, single-use database grant containing only a SHA-256 token
   digest and the exact public proof/contract/wallet binding.
4. In-memory RSA-OAEP authorization recovery from the protected Preview route.
5. Creator-signature verification against the exact Base ownership intent.
6. Only then, decryption of two testnet watcher keystores, independent Bradbury
   reads/signatures, and a Base Sepolia simulation.
7. The exact text confirmation
   `BROADCAST XPROOF BASE SEPOLIA` and one hidden relayer-keystore prompt.
8. Fenced broadcast, receipt confirmation, exact registry profile reads, and an
   atomic `CONFIRMED` database update.

The creator signature, raw one-time grant, Vercel bypass, watcher signatures,
passwords, and private keys are never put in command arguments, environment
variables, files, stdout, stderr, or error causes. The Vercel API helper and DB
connection are bounded and closed; the launcher creates no background process.

## Failure semantics

- Wrong/cancelled relayer password: no `BROADCASTING` fence and the proof stays
  retryable.
- RPC/write uncertainty after the `BROADCASTING` fence:
  `RECONCILIATION_REQUIRED`; do not retry until the receiver and transaction
  state are inspected.
- Known transaction but missing receipt/profile/DB confirmation:
  `RECONCILIATION_REQUIRED` with the transaction hash retained.
- Exact confirmed profile: `CONFIRMED`, profile facts persisted, and the sealed
  creator-evidence ciphertext/hash atomically purged.

The existing Vercel automation bypass is read into memory through an
authenticated project API call. It is not revoked by this ceremony because it
may be shared with other Preview automation; it is never printed or persisted
locally.
