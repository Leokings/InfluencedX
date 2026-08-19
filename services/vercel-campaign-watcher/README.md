# InfluencedX campaign watcher

Private Vercel Function that signs one `CampaignResolution` only after it
independently re-reads the finalized StudioNet transaction/result from the
pinned APV2 resolver and the exact live Base Sepolia receiver, escrow
assignment, campaign terms commitment, and submission commitment.

Deploy this directory three times as independent Vercel projects (watcher 1,
watcher 2, watcher 3). Each deployment must have a different
`XPROOF_WATCHER_PRIVATE_KEY`, matching address, service token, project ID, and
origin. A watcher project must never contain another watcher key, the Base
relayer key, or the StudioNet submitter key.

Ingress requires both a short-lived Vercel OIDC JWT bound to the exact relay
coordinator deployment and that watcher deployment's unique 32-byte-or-longer
service token.

The response contains only the recovered public signer, EIP-712 digest,
signature, and public settlement message. It never returns or persists private
keys, raw X evidence, service tokens, or complete GenLayer results.

The runtime fails closed unless the GenLayer network is `studionet`, chain ID
is `61999`, RPC is `https://studio.genlayer.com/api`, and resolver is
`0x0913b5593Ff16974E2fd616cA678A4986Cb48600`. StudioNet state is temporary, so
the resolver and every hosted binding must be cut over together after a reset.

Run `npm test` and `npm run build` before deploying. Set
`XPROOF_CAMPAIGN_WATCHER_ENABLED=true` only after every binding has been set on
Preview and the configured address is enabled on the deployed receiver.
