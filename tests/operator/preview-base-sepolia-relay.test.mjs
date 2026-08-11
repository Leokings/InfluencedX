import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';

import { getAddress, keccak256, stringToHex, zeroHash } from 'viem';

import {
  assertPreviewOperatorEnvironment,
  CURRENT_PREVIEW_RELAY,
  normalizePreviewDeploymentUrl,
} from '../../scripts/operator/current-preview-relay.mjs';
import {
  acquirePreviewAutomationBypass,
  createOwnershipAuthorizationMaterial,
  decryptOwnershipAuthorization,
  ownershipAuthorizationPublicKeyFingerprint,
  requestOwnershipAuthorizationCiphertext,
} from '../../scripts/operator/preview-authorization-client.mjs';
import {
  bindingFromRelayConfiguration,
  runPreviewBaseSepoliaRelay,
} from '../../scripts/operator/preview-base-sepolia-relay.mjs';
import {
  assertExactPreviewRelayState,
  PreviewRelayStore,
} from '../../scripts/operator/preview-relay-store.mjs';
import { BASE_SEPOLIA_RELAY_CONFIRMATION } from '../../src/relay/in-memory-base-relay.mjs';

const configuration = CURRENT_PREVIEW_RELAY;
const binding = bindingFromRelayConfiguration(configuration);
const previewUrl = 'https://influencedx-safe-preview-leokings588.vercel.app';
const creatorSignature = `0x${'ab'.repeat(65)}`;
const grantToken = Buffer.alloc(32, 0x33).toString('base64url');
const transactionHash = keccak256(stringToHex('operator-base-transaction'));

function authorizationLabel(publicJwk) {
  const fingerprint = ownershipAuthorizationPublicKeyFingerprint(publicJwk);
  return Buffer.from([
    'xproof:ownership-authorization:v1',
    binding.requestId,
    binding.genlayerTxHash,
    binding.resolver.toLowerCase(),
    binding.baseReceiver.toLowerCase(),
    binding.baseRegistry.toLowerCase(),
    binding.expectedWallet.toLowerCase(),
    fingerprint,
  ].join('|'), 'utf8');
}

test('ephemeral RSA-OAEP grant round-trips the creator signature without private-key export', async () => {
  const material = await createOwnershipAuthorizationMaterial({
    binding,
    nowMs: 1_800_000_000_000,
    ttlMs: 300_000,
    randomBytesFn: () => Buffer.alloc(32, 0x44),
  });
  assert.equal(material.token.length, 43);
  assert.match(material.grant.tokenHash, /^[0-9a-f]{64}$/);
  assert.equal(material.grant.requestId, binding.requestId);
  assert.equal(material.privateKey.extractable, false);
  assert.deepEqual(Object.keys(material.publicJwk).sort(), ['alg', 'e', 'ext', 'key_ops', 'kty', 'n']);

  const plaintext = Buffer.from(creatorSignature.slice(2), 'hex');
  const ciphertext = Buffer.from(await webcrypto.subtle.encrypt(
    { name: 'RSA-OAEP', label: authorizationLabel(material.publicJwk) },
    await webcrypto.subtle.importKey(
      'jwk',
      material.publicJwk,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt'],
    ),
    plaintext,
  )).toString('base64url');
  plaintext.fill(0);
  const recovered = await decryptOwnershipAuthorization({
    ciphertext,
    privateKey: material.privateKey,
    publicJwk: material.publicJwk,
    binding,
  });
  assert.equal(recovered, creatorSignature);
});

test('automation bypass is accepted only for the exact READY non-production deployment', async () => {
  const bypass = await acquirePreviewAutomationBypass({
    previewUrl,
    projectId: configuration.vercelProjectId,
    teamSlug: configuration.vercelTeamSlug,
    runVercelApi: async () => ({
      id: configuration.vercelProjectId,
      latestDeployments: [{
        url: new URL(previewUrl).hostname,
        readyState: 'READY',
        target: null,
      }],
      protectionBypass: {
        'automation-secret-for-test': { scope: 'automation-bypass' },
      },
    }),
  });
  assert.equal(bypass, 'automation-secret-for-test');

  await assert.rejects(
    acquirePreviewAutomationBypass({
      previewUrl,
      projectId: configuration.vercelProjectId,
      teamSlug: configuration.vercelTeamSlug,
      runVercelApi: async () => ({
        id: configuration.vercelProjectId,
        latestDeployments: [{
          url: new URL(previewUrl).hostname,
          readyState: 'READY',
          target: 'production',
        }],
        protectionBypass: {
          'automation-secret-for-test': { scope: 'automation-bypass' },
        },
      }),
    }),
    /Production deployments cannot be used/,
  );
});

test('broker request keeps grant and bypass out of argv and sanitizes network errors', async () => {
  const material = await createOwnershipAuthorizationMaterial({
    binding,
    nowMs: 1_800_000_000_000,
    ttlMs: 300_000,
    randomBytesFn: () => Buffer.alloc(32, 0x55),
  });
  const expectedCiphertext = 'A'.repeat(342);
  let captured;
  const result = await requestOwnershipAuthorizationCiphertext({
    previewUrl,
    brokerPath: configuration.brokerPath,
    projectId: configuration.vercelProjectId,
    teamSlug: configuration.vercelTeamSlug,
    binding,
    token: material.token,
    publicJwk: material.publicJwk,
    acquireBypass: async () => 'preview-bypass-test-secret',
    fetchFn: async (url, init) => {
      captured = { url: String(url), init, body: JSON.parse(init.body.toString('utf8')) };
      return new Response(JSON.stringify({ ciphertext: expectedCiphertext }), { status: 200 });
    },
  });
  assert.equal(result, expectedCiphertext);
  assert.equal(captured.body.token, material.token);
  assert.equal(captured.init.headers['x-vercel-protection-bypass'], 'preview-bypass-test-secret');
  assert.equal(captured.url, `${previewUrl}${configuration.brokerPath}`);

  await assert.rejects(
    requestOwnershipAuthorizationCiphertext({
      previewUrl,
      brokerPath: configuration.brokerPath,
      projectId: configuration.vercelProjectId,
      teamSlug: configuration.vercelTeamSlug,
      binding,
      token: material.token,
      publicJwk: material.publicJwk,
      acquireBypass: async () => 'preview-bypass-test-secret',
      fetchFn: async () => {
        throw new Error(`leak ${material.token} preview-bypass-test-secret`);
      },
    }),
    (error) => {
      assert.equal(error.message, 'The Preview authorization broker request failed');
      assert.equal(error.message.includes(material.token), false);
      assert.equal(error.message.includes('preview-bypass-test-secret'), false);
      return true;
    },
  );
});

function fakePublicPreflight() {
  return {
    publicClient: { safe: true },
    attestation: {
      primaryType: 'CreatorVerification',
      message: {
        attestationId: binding.requestId,
        wallet: binding.expectedWallet,
        identityHash: keccak256(stringToHex('operator-identity')),
        handleHash: keccak256(stringToHex('operator-handle')),
        verificationPostHash: keccak256(stringToHex('operator-post')),
        metricsHash: zeroHash,
        verifiedAt: 1_800_000_000n,
        expiresAt: 1_802_592_000n,
      },
    },
  };
}

function fakeProfile(publicPreflight = fakePublicPreflight()) {
  return {
    profileId: '1',
    identityHash: publicPreflight.attestation.message.identityHash,
    handleHash: publicPreflight.attestation.message.handleHash,
    verificationPostHash: publicPreflight.attestation.message.verificationPostHash,
    expiresAtMs: Number(publicPreflight.attestation.message.expiresAt * 1_000n),
  };
}

function ceremonyFixture({
  relayerFailure,
  walletFailure,
  profileFailure,
  brokerFailure,
  prepareFailure,
} = {}) {
  const calls = [];
  const persisted = [];
  const output = [];
  const publicPreflight = fakePublicPreflight();
  const store = {
    connect: async () => calls.push('store.connect'),
    close: async () => calls.push('store.close'),
    readExactState: async () => calls.push('store.preflight'),
    createGrantAndMarkQuorum: async ({ grant }) => {
      calls.push('store.grant');
      persisted.push(grant);
    },
    deleteGrantIfUnconsumed: async () => calls.push('store.cleanup-grant'),
    markBroadcasting: async () => calls.push('store.broadcasting'),
    recordBroadcastHash: async ({ transactionHash: hash }) => {
      calls.push('store.hash');
      assert.equal(hash, transactionHash);
    },
    markConfirmed: async ({ profile }) => {
      calls.push('store.confirmed-and-purged');
      assert.deepEqual(profile, fakeProfile(publicPreflight));
    },
    markReconciliationRequired: async ({ transactionHash: hash }) => {
      calls.push(`store.reconcile:${hash ?? 'unknown'}`);
    },
  };
  const dependencies = {
    now: () => 1_800_000_100_000,
    store,
    preflightPublic: async () => {
      calls.push('public.preflight');
      return publicPreflight;
    },
    createAuthorizationMaterial: async () => {
      calls.push('authorization.create');
      return {
        token: grantToken,
        privateKey: { private: true },
        publicJwk: { public: true },
        grant: {
          tokenHash: '11'.repeat(32),
          requestId: binding.requestId,
        },
      };
    },
    requestAuthorizationCiphertext: async ({ token }) => {
      calls.push('authorization.request');
      assert.equal(token, grantToken);
      if (brokerFailure) throw new Error(`broker exposed ${grantToken}`);
      return 'ciphertext-test-only';
    },
    decryptAuthorization: async () => {
      calls.push('authorization.decrypt');
      return creatorSignature;
    },
    verifyAuthorization: async ({ authorization }) => {
      calls.push('authorization.verify');
      assert.equal(authorization, creatorSignature);
    },
    prepareRelay: async (input) => {
      calls.push('watchers.open-and-simulate');
      assert.equal(input.ownershipIntentSignature, creatorSignature);
      if (prepareFailure) throw new Error(`watcher dependency leaked ${creatorSignature}`);
      return {
        summary: {
          network: 'base-sepolia',
          status: 'SIMULATED',
          requestId: binding.requestId,
        },
        dispose: () => calls.push('prepared.dispose'),
        broadcast: async ({ loadRelayerAccount }) => {
          calls.push('broadcast.enter');
          const account = await loadRelayerAccount();
          const wallet = input.dependencies.createWalletClient({
            account,
            rpcUrl: configuration.rpcUrl,
          });
          const hash = await wallet.writeContract({ safe: true });
          return {
            ...this?.summary,
            status: 'CONFIRMED',
            hash,
            blockNumber: '1',
          };
        },
      };
    },
    promptConfirmation: async () => {
      calls.push('confirmation');
      return BASE_SEPOLIA_RELAY_CONFIRMATION;
    },
    loadRelayerAccount: async () => {
      calls.push('relayer.prompt-once');
      if (relayerFailure) throw new Error(`password leak ${creatorSignature}`);
      return { address: configuration.simulationAccount };
    },
    createWalletClient: () => ({
      writeContract: async () => {
        calls.push('wallet.write');
        if (walletFailure) throw new Error(`rpc leak ${creatorSignature}`);
        return transactionHash;
      },
    }),
    verifyProfile: async () => {
      calls.push('registry.verify');
      if (profileFailure) throw new Error(`profile leak ${creatorSignature}`);
      return fakeProfile(publicPreflight);
    },
  };
  return {
    calls,
    persisted,
    output,
    dependencies,
    writable: { write: (value) => output.push(value) },
  };
}

test('one-shot ceremony performs every public/signature precheck before watcher files and purges on confirmation', async () => {
  const fixture = ceremonyFixture();
  const result = await runPreviewBaseSepoliaRelay({
    configuration,
    previewUrl,
    databaseUrl: 'postgres://not-used',
    output: fixture.writable,
    dependencies: fixture.dependencies,
  });
  assert.equal(result.baseVerified, true);
  assert.equal(result.hash, transactionHash);
  assert.ok(fixture.calls.indexOf('public.preflight') < fixture.calls.indexOf('watchers.open-and-simulate'));
  assert.ok(fixture.calls.indexOf('store.preflight') < fixture.calls.indexOf('watchers.open-and-simulate'));
  assert.ok(fixture.calls.indexOf('authorization.verify') < fixture.calls.indexOf('watchers.open-and-simulate'));
  assert.ok(fixture.calls.indexOf('relayer.prompt-once') < fixture.calls.indexOf('store.broadcasting'));
  assert.ok(fixture.calls.indexOf('store.broadcasting') < fixture.calls.indexOf('wallet.write'));
  assert.ok(fixture.calls.indexOf('store.hash') < fixture.calls.indexOf('registry.verify'));
  assert.ok(fixture.calls.indexOf('registry.verify') < fixture.calls.indexOf('store.confirmed-and-purged'));
  assert.equal(fixture.calls.filter((value) => value === 'relayer.prompt-once').length, 1);
  assert.equal(JSON.stringify(fixture.persisted).includes(grantToken), false);
  const publicOutput = fixture.output.join('');
  assert.equal(publicOutput.includes(grantToken), false);
  assert.equal(publicOutput.includes(creatorSignature), false);
});

test('wrong relayer password remains retryable and is never mislabeled as ambiguous broadcast', async () => {
  const fixture = ceremonyFixture({ relayerFailure: true });
  await assert.rejects(
    runPreviewBaseSepoliaRelay({
      configuration,
      previewUrl,
      databaseUrl: 'postgres://not-used',
      output: fixture.writable,
      dependencies: fixture.dependencies,
    }),
    (error) => {
      assert.match(error.message, /proof remains retryable/);
      assert.equal(error.message.includes(creatorSignature), false);
      return true;
    },
  );
  assert.equal(fixture.calls.includes('store.broadcasting'), false);
  assert.equal(fixture.calls.some((value) => value.startsWith('store.reconcile:')), false);
  assert.equal(fixture.calls.filter((value) => value === 'relayer.prompt-once').length, 1);
});

test('an ambiguous write is quarantined without leaking creator or watcher material', async () => {
  const fixture = ceremonyFixture({ walletFailure: true });
  await assert.rejects(
    runPreviewBaseSepoliaRelay({
      configuration,
      previewUrl,
      databaseUrl: 'postgres://not-used',
      output: fixture.writable,
      dependencies: fixture.dependencies,
    }),
    (error) => {
      assert.equal(error.message, 'Base relay requires reconciliation before any retry');
      assert.equal(error.message.includes(creatorSignature), false);
      return true;
    },
  );
  assert.ok(fixture.calls.includes('store.reconcile:unknown'));
  assert.equal(fixture.calls.includes('store.confirmed-and-purged'), false);
});

test('receipt-success/profile-read failure retains evidence and quarantines the known transaction', async () => {
  const fixture = ceremonyFixture({ profileFailure: true });
  await assert.rejects(
    runPreviewBaseSepoliaRelay({
      configuration,
      previewUrl,
      databaseUrl: 'postgres://not-used',
      output: fixture.writable,
      dependencies: fixture.dependencies,
    }),
    new RegExp(`reconciliation by transaction hash ${transactionHash}`),
  );
  assert.ok(fixture.calls.includes(`store.reconcile:${transactionHash}`));
  assert.equal(fixture.calls.includes('store.confirmed-and-purged'), false);
});

test('broker failure burns or removes the one-time grant and never opens watcher files', async () => {
  const fixture = ceremonyFixture({ brokerFailure: true });
  await assert.rejects(
    runPreviewBaseSepoliaRelay({
      configuration,
      previewUrl,
      databaseUrl: 'postgres://not-used',
      output: fixture.writable,
      dependencies: fixture.dependencies,
    }),
    (error) => {
      assert.match(error.message, /Preview authorization broker failed without exposing/);
      assert.equal(error.message.includes(grantToken), false);
      return true;
    },
  );
  assert.ok(fixture.calls.includes('store.cleanup-grant'));
  assert.equal(fixture.calls.filter((value) => value === 'authorization.request').length, 1);
  assert.equal(fixture.calls.includes('watchers.open-and-simulate'), false);
});

test('watcher/simulation dependency crashes are sanitized and leave no child process or broadcast fence', async () => {
  const fixture = ceremonyFixture({ prepareFailure: true });
  await assert.rejects(
    runPreviewBaseSepoliaRelay({
      configuration,
      previewUrl,
      databaseUrl: 'postgres://not-used',
      output: fixture.writable,
      dependencies: fixture.dependencies,
    }),
    (error) => {
      assert.equal(
        error.message,
        'Watcher quorum and Base simulation failed without exposing ceremony secrets',
      );
      assert.equal(error.message.includes(creatorSignature), false);
      return true;
    },
  );
  assert.ok(fixture.calls.includes('store.close'));
  assert.equal(fixture.calls.includes('store.broadcasting'), false);
  assert.equal(fixture.calls.some((value) => value.startsWith('store.reconcile:')), false);
});

test('Preview environment and URL gates fail closed for production or ambient credentials', () => {
  assert.doesNotThrow(() => assertPreviewOperatorEnvironment({
    VERCEL_ENV: 'preview',
    VERCEL_TARGET_ENV: 'preview',
    DATABASE_URL: 'postgres://preview',
  }));
  assert.throws(() => assertPreviewOperatorEnvironment({
    VERCEL_ENV: 'production',
    VERCEL_TARGET_ENV: 'production',
    DATABASE_URL: 'postgres://production',
  }), /disabled outside/);
  assert.throws(() => assertPreviewOperatorEnvironment({
    VERCEL_ENV: 'preview',
    VERCEL_TARGET_ENV: 'preview',
    DATABASE_URL: 'postgres://preview',
    BASE_RELAYER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  }), /must not be present/);
  assert.equal(normalizePreviewDeploymentUrl(`${previewUrl}/`), previewUrl);
  assert.throws(() => normalizePreviewDeploymentUrl('https://influencedx.example.com'), /exact HTTPS/);
});

test('DB exact-state gate distinguishes FINALIZED lifecycle from successful execution', () => {
  const nowMs = 1_800_000_100_000;
  const verification = {
    id: 'verification',
    status: 'READY_FOR_GENLAYER',
    request_expires_at: nowMs + 100_000,
    wallet: binding.expectedWallet,
    finalized_request_id: binding.requestId,
    receiver_contract: binding.baseReceiver,
    genlayer_contract: binding.resolver,
    intent_signature_status: 'VERIFIED',
    sealed_ciphertext_present: true,
    sealed_hash_present: true,
    sealed_evidence_expires_at: nowMs + 100_000,
    sealed_evidence_purged_at: null,
    submission_status: 'FINALIZED',
    genlayer_tx_hash: binding.genlayerTxHash,
    genlayer_outcome: 'VERIFIED',
    genlayer_error_code: null,
    genlayer_finalized_at: new Date(),
    credential_expires_at: nowMs + 100_000,
    base_relay_status: 'NOT_STARTED',
    base_relay_tx_hash: null,
    base_confirmed_at: null,
    base_profile_verified: false,
  };
  const bradbury = {
    request_id: binding.requestId,
    status: 'FINALIZED',
    network: 'testnet-bradbury',
    resolver: binding.resolver,
    function_name: 'verify_ownership',
    lifecycle_status: 'FINALIZED',
    execution_result: 'FINISHED_WITH_RETURN',
    result_outcome: 'VERIFIED',
    tx_hash: binding.genlayerTxHash,
    error_code: null,
    finalized_at: new Date(),
  };
  assert.doesNotThrow(() => assertExactPreviewRelayState({
    verification,
    bradbury,
    binding,
    nowMs,
  }));
  assert.throws(() => assertExactPreviewRelayState({
    verification,
    bradbury: { ...bradbury, execution_result: 'FAILED' },
    binding,
    nowMs,
  }), /not FINALIZED with a successful VERIFIED execution/);
});

test('CONFIRMED persistence atomically purges the sealed-evidence pair', async () => {
  const statements = [];
  const client = {
    connect: async () => {},
    end: async () => {},
    query: async (query) => {
      statements.push(query);
      if (typeof query === 'object' && /update verification_requests/.test(query.text)) {
        return { rows: [{ id: 'verification' }] };
      }
      return { rows: [] };
    },
  };
  const store = new PreviewRelayStore({
    databaseUrl: 'postgres://unused',
    clientFactory: () => client,
  });
  await store.connect();
  await store.markConfirmed({
    binding,
    transactionHash,
    profile: fakeProfile(),
    nowMs: 1_800_000_200_000,
  });
  await store.close();
  const update = statements.find((value) => typeof value === 'object' && /update verification_requests/.test(value.text));
  assert.match(update.text, /sealed_evidence_ciphertext = null/);
  assert.match(update.text, /sealed_evidence_hash = null/);
  assert.match(update.text, /sealed_evidence_purged_at = \$3/);
  assert.match(update.text, /base_relay_status = 'CONFIRMED'/);
  assert.deepEqual(statements.filter((value) => typeof value === 'string'), ['begin', 'commit']);
});

test('no-broadcast reconciliation resets only the exact quarantined proof', async () => {
  const statements = [];
  const client = {
    connect: async () => {},
    end: async () => {},
    query: async (query) => {
      statements.push(query);
      return { rows: [{ id: 'verification' }] };
    },
  };
  const store = new PreviewRelayStore({
    databaseUrl: 'postgres://unused',
    clientFactory: () => client,
  });
  await store.connect();
  await store.resetAfterProvenNoBroadcast({
    binding,
    nowMs: 1_800_000_300_000,
  });
  await store.close();
  const update = statements[0];
  assert.match(update.text, /base_relay_status = 'QUORUM_PENDING'/);
  assert.match(update.text, /base_relay_status = 'RECONCILIATION_REQUIRED'/);
  assert.match(update.text, /base_relay_error_code = 'BASE_RELAY_UNCERTAIN'/);
  assert.match(update.text, /base_relay_tx_hash is null/);
  assert.match(update.text, /base_profile_verified is false/);
  assert.match(update.text, /sealed_evidence_ciphertext is not null/);
  assert.deepEqual(update.values, [
    binding.requestId,
    1_800_000_300_000,
    binding.genlayerTxHash,
    binding.resolver,
    binding.baseReceiver,
    binding.expectedWallet,
  ]);
});

test('authenticated Vercel API transport preserves raw JSON output', async () => {
  const source = await fs.readFile(
    new URL('../../scripts/operator/preview-authorization-client.mjs', import.meta.url),
    'utf8',
  );
  const apiArguments = source.slice(
    source.indexOf("const args = ["),
    source.indexOf("return new Promise", source.indexOf("const args = [")),
  );
  assert.match(apiArguments, /'--raw'/);
  assert.doesNotMatch(apiArguments, /'--silent'/);
});
