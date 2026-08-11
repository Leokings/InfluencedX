import { Client } from 'pg';

import { CURRENT_PREVIEW_RELAY } from './current-preview-relay.mjs';

if (process.env.VERCEL_ENV !== 'preview' || process.env.VERCEL_TARGET_ENV !== 'preview') {
  throw new Error('Preview relay status can only be read with the Preview environment.');
}

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  application_name: 'xproof-preview-relay-status',
});

try {
  await client.connect();
  const result = await client.query({
    text: `
      select base_relay_status, base_relay_tx_hash, base_relay_error_code,
        base_confirmed_at, base_registry_address, base_profile_id,
        base_profile_active, base_profile_verified, base_profile_expires_at,
        sealed_evidence_ciphertext is not null as sealed_ciphertext_present,
        sealed_evidence_hash is not null as sealed_hash_present,
        sealed_evidence_purged_at
      from verification_requests
      where finalized_request_id = $1
      limit 1
    `,
    values: [CURRENT_PREVIEW_RELAY.requestId],
  });
  process.stdout.write(`${JSON.stringify(result.rows[0] ?? null)}\n`);
} finally {
  await client.end().catch(() => {});
}
