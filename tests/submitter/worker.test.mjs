import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import worker from '../../services/bradbury-submitter/src/worker.mjs';
import { makeEnvelope, validConfigEnv } from './helpers.mjs';

function fakeNamespace(response = { replayed: false, submission: { status: 'SUBMITTED' } }) {
  const calls = [];
  return {
    calls,
    idFromName(name) {
      calls.push({ type: 'id', name });
      return name;
    },
    get(id) {
      calls.push({ type: 'get', id });
      return {
        async fetch(request, init) {
          calls.push({ type: 'fetch', request, init });
          return new Response(JSON.stringify(response), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          });
        },
      };
    },
  };
}

function authorizedHeaders(env, extra = {}) {
  return {
    authorization: `Bearer ${env.XPROOF_SUBMITTER_SHARED_SECRET}`,
    ...extra,
  };
}

test('private Worker fails closed without service authorization', async () => {
  const response = await worker.fetch(
    new Request('https://internal/healthz'),
    { ...validConfigEnv(), XPROOF_SUBMISSIONS: fakeNamespace() },
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'SERVICE_AUTHORIZATION_REQUIRED');
});

test('deployment config has no public Worker route and assigns no secret values', () => {
  const config = fs.readFileSync(
    new URL('../../services/bradbury-submitter/wrangler.toml', import.meta.url),
    'utf8',
  );
  assert.match(config, /^workers_dev\s*=\s*false$/m);
  assert.doesNotMatch(config, /^routes?\s*=/m);
  assert.doesNotMatch(config, /^XPROOF_SUBMITTER_SHARED_SECRET\s*=/m);
  assert.doesNotMatch(config, /^GENLAYER_SUBMITTER_PRIVATE_KEY\s*=/m);
  assert.match(config, /name\s*=\s*"XPROOF_SIGNER"/);
  assert.match(config, /class_name\s*=\s*"BradburySignerObject"/);
});

test('health response exposes only pinned public configuration', async () => {
  const env = validConfigEnv({ XPROOF_SUBMISSIONS: fakeNamespace() });
  const response = await worker.fetch(
    new Request('https://internal/healthz', { headers: authorizedHeaders(env) }),
    env,
  );
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(text.includes(env.XPROOF_SUBMITTER_SHARED_SECRET), false);
  assert.equal(text.includes(env.GENLAYER_SUBMITTER_PRIVATE_KEY), false);
  assert.match(text, /testnet-bradbury/);
});

test('routes a validated request only to the request-ID Durable Object', async () => {
  const namespace = fakeNamespace();
  const env = validConfigEnv({ XPROOF_SUBMISSIONS: namespace });
  const nowEpoch = Math.floor(Date.now() / 1_000);
  const issuedAtEpoch = nowEpoch - 60;
  const envelope = await makeEnvelope({
    issuedAtEpoch,
    expiresAtEpoch: issuedAtEpoch + 15 * 60,
    credentialExpiresAtEpoch: issuedAtEpoch + 30 * 24 * 60 * 60,
    postEpoch: issuedAtEpoch + 30,
  });
  const response = await worker.fetch(
    new Request('https://internal/v1/ownership-submissions', {
      method: 'POST',
      headers: authorizedHeaders(env, { 'content-type': 'application/json' }),
      body: JSON.stringify(envelope),
    }),
    env,
  );
  assert.equal(response.status, 202);
  assert.deepEqual(namespace.calls[0], { type: 'id', name: envelope.requestId });
});

test('rejects arbitrary routes and non-JSON submission bodies', async () => {
  const env = validConfigEnv({ XPROOF_SUBMISSIONS: fakeNamespace() });
  const unknown = await worker.fetch(
    new Request('https://internal/v1/arbitrary-call', { headers: authorizedHeaders(env) }),
    env,
  );
  assert.equal(unknown.status, 404);

  const wrongType = await worker.fetch(
    new Request('https://internal/v1/ownership-submissions', {
      method: 'POST',
      headers: authorizedHeaders(env, { 'content-type': 'text/plain' }),
      body: '{}',
    }),
    env,
  );
  assert.equal(wrongType.status, 415);
});

test('status and poll routes accept only a 32-byte request ID', async () => {
  const namespace = fakeNamespace();
  const env = validConfigEnv({ XPROOF_SUBMISSIONS: namespace });
  const envelope = await makeEnvelope();
  const status = await worker.fetch(
    new Request(`https://internal/v1/ownership-submissions/${envelope.requestId}`, {
      headers: authorizedHeaders(env),
    }),
    env,
  );
  assert.equal(status.status, 202);
  const poll = await worker.fetch(
    new Request(`https://internal/v1/ownership-submissions/${envelope.requestId}/poll`, {
      method: 'POST',
      headers: authorizedHeaders(env),
    }),
    env,
  );
  assert.equal(poll.status, 202);
  const invalid = await worker.fetch(
    new Request('https://internal/v1/ownership-submissions/not-a-hash', {
      headers: authorizedHeaders(env),
    }),
    env,
  );
  assert.equal(invalid.status, 404);
});
