import assert from 'node:assert/strict';
import test from 'node:test';

import { loadSubmitterConfig, publicConfig } from '../../services/bradbury-submitter/src/config.mjs';
import { requireServiceAuthorization } from '../../services/bradbury-submitter/src/service-auth.mjs';
import { validConfigEnv } from './helpers.mjs';

test('requires an explicit testnet kill-switch and pinned resolver', () => {
  assert.throws(
    () => loadSubmitterConfig(validConfigEnv({ XPROOF_SUBMITTER_ENABLED: 'false' })),
    (error) => error.code === 'SUBMITTER_CONFIGURATION_INVALID',
  );
  assert.throws(
    () => loadSubmitterConfig(validConfigEnv({ XPROOF_GENLAYER_RESOLVER: `0x${'22'.repeat(20)}` })),
    /pinned APV2 Bradbury resolver/,
  );
});

test('rejects missing or malformed service secrets and signer keys', () => {
  assert.throws(
    () => loadSubmitterConfig(validConfigEnv({ XPROOF_SUBMITTER_SHARED_SECRET: 'too-short' })),
    /32-512/,
  );
  assert.throws(
    () => loadSubmitterConfig(validConfigEnv({ GENLAYER_SUBMITTER_PRIVATE_KEY: `0x${'00'.repeat(32)}` })),
    /non-zero/,
  );
});

test('never includes either secret in public configuration', () => {
  const env = validConfigEnv();
  const visible = JSON.stringify(publicConfig(loadSubmitterConfig(env)));
  assert.equal(visible.includes(env.XPROOF_SUBMITTER_SHARED_SECRET), false);
  assert.equal(visible.includes(env.GENLAYER_SUBMITTER_PRIVATE_KEY), false);
});

test('accepts only the exact private bearer token', async () => {
  const secret = validConfigEnv().XPROOF_SUBMITTER_SHARED_SECRET;
  await requireServiceAuthorization(
    new Request('https://internal/healthz', { headers: { authorization: `Bearer ${secret}` } }),
    secret,
  );
  await assert.rejects(
    requireServiceAuthorization(
      new Request('https://internal/healthz', { headers: { authorization: 'Bearer incorrect' } }),
      secret,
    ),
    (error) => error.status === 401 && error.code === 'SERVICE_AUTHORIZATION_REQUIRED',
  );
});
