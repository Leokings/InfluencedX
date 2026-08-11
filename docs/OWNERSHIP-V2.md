# APV2 X ownership protocol

APV2 proves that the controller of a Base wallet can publish from a specific
public X account without asking the creator for an X OAuth grant. The immutable
numeric X user ID is not supplied by the caller; GenLayer validators derive it
from the public profile and finalize its SHA-256 commitment.

## Challenge and tweet

`createOwnershipChallenge({ wallet, handle, ... })` returns a random
`APV2-<24 base64url characters>` challenge and `requestId: null`. The creator posts
the returned text exactly:

```text
XProof v2 w=<checksummed full wallet> n=<APV2 challenge> i=<issued epoch> e=<challenge expiry epoch> c=<credential expiry epoch>
```

The tweet deliberately does not contain a request ID because the X post ID does
not exist until after publication.

After the creator supplies the post URL, call
`finalizeOwnershipChallenge(challenge, postId)`. It computes:

```text
requestId = sha256(
  "xproof-x-ownership-v2" + "|" +
  lowercaseWallet + "|" +
  lowercaseHandleWithoutOptionalLeadingAt + "|" +
  decimalPostId + "|" +
  challenge + "|" +
  issuedAtEpoch + "|" +
  expiresAtEpoch + "|" +
  credentialExpiresAtEpoch
)
```

All text is UTF-8 and the digest is returned as lowercase `0x`-prefixed hex.
The post ID is part of the digest, so an attacker submitting a different post
gets a different request ID and cannot consume the legitimate one.

## GenLayer interface

The APV2 write call is:

```text
verify_ownership(
  request_id: str,
  base_wallet: str,
  expected_handle: str,
  post_id: str,
  challenge: str,
  issued_at_epoch: int,
  expires_at_epoch: int,
  credential_expires_at_epoch: int,
) -> None
```

The resolver normalizes the wallet and handle, recomputes the request ID, and
reverts on a mismatch before writing a result. Validators retrieve the exact X
post and public profile, require the APV2 protocol marker plus exact `w=`, `n=`,
`i=`, `e=`, and `c=` tokens, check the post-author and publication window, and
derive `x_user_id` and `identity_hash = sha256("x-user-id:" + x_user_id)` during
consensus.

Finalized ownership results retain the relay fields `kind`, `request_id`,
`base_wallet`, `identity_hash`, `handle`, `x_user_id`, `post_id`,
`challenge_hash`, `published_at_epoch`, `verified_at_epoch`,
`credential_expires_at_epoch`, `identity_match`, `author_match`,
`challenge_match`, `publication_in_window`, and `outcome`. APV2 additionally
records `issued_at_epoch`, `expires_at_epoch`, `request_match`, `wallet_match`,
`protocol_match`, and the three timestamp-token match flags.

Only a result whose complete evidence predicate passes can have outcome
`VERIFIED`. Public-source ambiguity remains `UNDETERMINED`; a definite marker,
author, timing, or profile failure is `REJECTED`.
