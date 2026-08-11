# Testnet watcher key setup

InfluencedX's Base receiver requires two signatures from three enabled watcher
addresses. Watchers are independent attestors, not deployers. Never reuse the
GenLayer/Base deployer, contract owner, treasury, creator, or relayer account as
a watcher.

This bootstrap is intentionally limited to Base Sepolia and GenLayer Bradbury.
It creates three distinct secp256k1 keys, immediately encrypts each one as a
standard Web3 Secret Storage v3 keystore using a separate scrypt-derived key,
and writes only encrypted JSON keystores. Private keys exist transiently in
process memory but are never written to disk, placed in environment variables,
or printed. Standard output contains only the 2-of-3 threshold and the three
public addresses.

## Generate the encrypted testnet keystores

Prepare three different password files outside the checkout. Each password must
be at least 16 bytes. Restrict each file to its intended operator; on Linux use
mode `0600`, and on Windows grant access only to that watcher service account.
Do not place passwords beside their keystores.

From `adproof/`, run:

```powershell
npm run watchers:setup:testnet -- `
  --password-file C:\XProof-Secrets\watcher-1.password `
  --password-file C:\XProof-Secrets\watcher-2.password `
  --password-file C:\XProof-Secrets\watcher-3.password
```

The default destination is `adproof/.secrets/testnet-watchers/`, which is
gitignored. The command refuses to overwrite an existing destination. If
`--output-dir` points inside the checkout, it must remain under
`adproof/.secrets/`. An external secret volume is preferable.

Copy each encrypted keystore to a different watcher host. Deliver its password
through a separate secret-management channel, then remove the bootstrap copies
from the generation machine according to the testnet key-handling procedure.
Generating all three on one computer is only a testnet bootstrap convenience;
production keys must be generated independently on their final hosts or in
separate HSM/KMS trust domains.

Use the three printed addresses, in the printed order, for
`BASE_WATCHER_ADDRESSES`. Do not deploy the receiver until all addresses are
different and all three operators can independently produce a signature.

## Run one watcher

Each watcher host receives exactly one encrypted keystore and one separately
mounted password file. Configure only file paths:

```dotenv
ADPROOF_WATCHER_KEYSTORE_PATH=C:\XProof-Watcher\watcher-1.keystore.json
ADPROOF_WATCHER_KEYSTORE_PASSWORD_FILE=C:\run\secrets\watcher-1.password
```

Then use the existing relay command:

```powershell
npm run relay:watch -- --resolver <BRADBURY_RESOLVER> --tx <GENLAYER_TX> --request-id <REQUEST_ID> --receiver <BASE_RECEIVER> --ownership-signature <CREATOR_SIGNATURE> --output <UNIQUE_OUTPUT_FILE>
```

`relay-watcher.mjs` decrypts the key only in memory, signs the exact EIP-712
attestation, and writes the existing signature bundle format. For an ownership
verification it also requires `--ownership-signature <CREATOR_SIGNATURE>` and a
`BASE_SEPOLIA_RPC_URL`. Before signing, every watcher independently verifies the
creator signature against the exact finalized request, wallet, X handle/post,
challenge, credential expiry, receiver, Base chain, and GenLayer resolver. This
verification supports both EOAs and deployed EIP-1271 wallets. The watcher also
checks the receiver configuration and current Base replay state. It no longer
accepts `ADPROOF_WATCHER_PRIVATE_KEY`.

## 2-of-3 operating rule

- Run each watcher under a different service account and preferably a different
  provider or host.
- Give watchers no Base ETH; watcher addresses only sign. The separate relayer
  pays transaction gas.
- A watcher must independently read the finalized Bradbury result before
  signing. Never distribute a pre-approved result from the app server.
- Collect any two matching bundles and submit them with `relay-submit.mjs`.
- If a keystore or password is exposed, disable that watcher on the receiver,
  enroll a new independent address, and never reuse the compromised key.
- Before mainnet, replace this testnet file-keystore bootstrap with independently
  administered HSM/KMS or equivalent signing infrastructure and complete a key
  ceremony and recovery drill.
