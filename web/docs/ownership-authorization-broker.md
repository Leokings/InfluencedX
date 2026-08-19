# Preview ownership-authorization broker

This internal endpoint exists only to move an already verified creator
ownership signature from InfluencedX's sealed Vercel evidence into a one-use
operator-owned RSA key for the Base Sepolia relay. It is not a general secret
export API.

The endpoint is `POST /api/internal/base-relay/ownership-authorization`. It
fails closed unless all of the following are true:

- `VERCEL_ENV=preview` (and `VERCEL_TARGET_ENV=preview` when present);
- `XPROOF_AUTHORIZATION_BROKER_ENABLED=true` in Preview only;
- `XPROOF_GENLAYER_CONTRACT`, `XPROOF_ATTESTATION_RECEIVER`, and
  `XPROOF_CREATOR_REGISTRY` exactly match the request;
- a matching, unexpired, unconsumed row exists in
  `ownership_authorization_grants`;
- the saved request and the trusted StudioNet status projection both say
  `FINALIZED` / `FINISHED_WITH_RETURN` / `VERIFIED`, with the exact request,
  transaction, resolver, receiver, registry, and creator wallet bindings;
- the evidence is present, unpurged, unexpired, and its digest, envelope,
  EIP-712 intent, and saved signature hash all match.

Production must not receive `XPROOF_AUTHORIZATION_BROKER_ENABLED=true`. The
code still rejects Production even if that variable is accidentally present.

## One-shot operator sequence

Keep the raw token and RSA private key in one local process. Never put either
in argv, an environment variable, a file, stdout, or a log.

1. Generate 32 random token bytes and a fresh 2048-4096-bit RSA-OAEP/SHA-256
   key pair in memory.
2. Use `buildOwnershipAuthorizationGrant` from
   `lib/ownership-authorization-broker.ts` to obtain the public insert values.
3. Insert that value into Preview Neon. The raw token is not in the value;
   only its SHA-256 digest is stored. Grant lifetime is at most 15 minutes.
4. POST the exact JSON body below over the protected Preview deployment.
5. Decrypt `ciphertext` in memory with the ephemeral private key and the OAEP
   label returned by `ownershipAuthorizationOaepLabel`.
6. Pass the recovered signature directly to the in-memory watcher/relayer
   pipeline. Zero buffers after use. The database grant is already consumed.

The request has exactly these fields:

```json
{
  "token": "43-character unpadded base64url",
  "requestId": "0x...",
  "genlayerTxHash": "0x...",
  "resolver": "0x...",
  "baseReceiver": "0x...",
  "baseRegistry": "0x...",
  "expectedWallet": "0x...",
  "ephemeralPublicKey": {
    "kty": "RSA",
    "alg": "RSA-OAEP-256",
    "e": "AQAB",
    "ext": true,
    "key_ops": ["encrypt"],
    "n": "base64url modulus"
  }
}
```

The successful response has exactly one field:

```json
{"ciphertext":"base64url RSA-OAEP ciphertext"}
```

`ownershipAuthorizationGrantInsertFields` documents the SQL column order:

`token_hash`, `request_id`, `genlayer_tx_hash`, `resolver_address`,
`base_receiver_address`, `base_registry_address`, `expected_wallet`,
`expires_at`, `consumed_at`, `consumer_key_fingerprint`, `created_at`.

The RSA-OAEP label binds version, request ID, GenLayer transaction, resolver,
receiver, registry, creator wallet, and the ephemeral public-key fingerprint.
If a request fails after its grant is consumed, create a new grant and key
pair; never make the old grant reusable.
