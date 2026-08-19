# InfluencedX campaign settlement coordinator

Private Vercel Function that turns a persisted FINALIZED StudioNet campaign
result from the pinned APV2 resolver into a fenced Base Sepolia
`submitCampaignResolution` transaction.

The caller supplies only `requestId`. The coordinator reloads the application,
committed campaign terms, submission, Base assignment, and finalized GenLayer
projection from Postgres. It requests all three independent watchers, verifies
at least the live receiver threshold (never below two) distinct enabled
signatures over one identical EIP-712 message, independently repeats Base and
GenLayer binding checks, and simulates the exact receiver call.

The runtime fails closed unless the GenLayer network is `studionet`, chain ID
is `61999`, RPC is `https://studio.genlayer.com/api`, and resolver is
`0x0913b5593Ff16974E2fd616cA678A4986Cb48600`. Legacy-network jobs cannot pass
the new RPC, recipient, and resolver bindings. StudioNet state is temporary, so
the resolver and every hosted binding must be cut over together after a reset.

`0006_campaign_settlement_relay.sql` is required. Its one-request/one-round
fence allows pre-broadcast retries only after lease expiry. Once broadcast
starts, a missing or ambiguous result becomes `RECONCILIATION_REQUIRED` and can
never be blindly broadcast again. Confirmed PASS/FAIL mirrors PAID/REFUNDED;
UNDETERMINED returns the campaign to SUBMITTED and preserves the completed
round in the relay table.

Deploy this directory as its own Vercel project. It is the only service that
receives `XPROOF_BASE_RELAYER_PRIVATE_KEY`; the account is rejected if it
matches a watcher and its balance cannot exceed `XPROOF_RELAYER_MAX_BALANCE_WEI`.

Cutover order:

1. Run `npm test` and `npm run build` in both service directories.
2. Apply migration 0006 once; never run it from a Vercel build.
3. Deploy and enable three watcher projects with independent secrets.
4. Deploy the coordinator with broadcast disabled and verify simulation-only.
5. Fund only the dedicated relayer with minimal Base Sepolia ETH, set its key,
   and enable broadcast on Preview.
6. Enable the web bridge last.

Repository builds and tests never migrate, deploy, upload secrets, or broadcast.
