import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { decryptKeystoreJson } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';

import {
  APPLY_CONFIRMATION,
  RESUME_CONFIRMATION,
  RELAYER_MAX_BALANCE_WEI,
  WATCHERS,
  applyDisabledEnvironmentPlan,
  assertUnusedRelayerState,
  callerOidcPatch,
  createEncryptedRelayerMaterial,
  createVercelApi,
  databaseConnectionRequest,
  exactDatabaseBindingMetadata,
  previewSetupMode,
  relayEnvironment,
  stablePreviewOriginForDeployment,
  trustedSourcesPatch,
  watcherEnvironment,
  webEnvironment,
  waitForConfirmedRelayerState,
} from '../../scripts/configure-campaign-watchers-preview.mjs';

const WATCHER_KEYS = [
  `0x${'11'.repeat(32)}`,
  `0x${'22'.repeat(32)}`,
  `0x${'33'.repeat(32)}`,
];
const WATCHER_TOKENS = [
  'watcher-one-token-is-at-least-thirty-two-bytes',
  'watcher-two-token-is-at-least-thirty-two-bytes',
  'watcher-three-token-is-at-least-thirty-two-bytes',
];
const RELAY_TOKEN = 'relay-service-token-is-at-least-thirty-two-bytes';
const RELAYER_KEY = `0x${'44'.repeat(32)}`;
const RELAYER = privateKeyToAccount(RELAYER_KEY);
const CONFIG_EPOCH = '123e4567-e89b-42d3-a456-426614174000';

function entriesByKey(entries) {
  return Object.fromEntries(entries.map((entry) => [entry.key, entry]));
}

test('Trusted Sources allow only the exact Preview caller and Preview target', () => {
  const caller = { id: 'prj_exactCaller123', name: 'influencedx-caller' };
  assert.deepEqual(trustedSourcesPatch(caller), {
    ssoProtection: { deploymentType: 'preview' },
    trustedSources: {
      projects: {
        prj_exactCaller123: {
          label: 'influencedx-caller',
          customAllow: [{
            from: { slugs: ['preview'] },
            to: { slugs: ['preview'] },
          }],
        },
      },
      oidcProviders: {},
    },
  });
  assert.deepEqual(callerOidcPatch(), {
    oidcTokenConfig: { enabled: true, issuerMode: 'team' },
  });
  assert.doesNotMatch(JSON.stringify(trustedSourcesPatch(caller)), /production|development|all-custom/);
});

test('each Preview environment receives only its role-specific secrets and stays disabled', () => {
  const watcherBatches = WATCHERS.map((watcher, index) => entriesByKey(watcherEnvironment({
    watcher,
    privateKey: WATCHER_KEYS[index],
    serviceToken: WATCHER_TOKENS[index],
    configEpoch: CONFIG_EPOCH,
  })));
  for (const [index, batch] of watcherBatches.entries()) {
    assert.equal(batch.XPROOF_CAMPAIGN_WATCHER_ENABLED.value, 'false');
    assert.equal(batch.XPROOF_WATCHER_PRIVATE_KEY.value, WATCHER_KEYS[index]);
    assert.equal(batch.XPROOF_WATCHER_PRIVATE_KEY.type, 'sensitive');
    assert.equal(batch.XPROOF_WATCHER_SERVICE_TOKEN.value, WATCHER_TOKENS[index]);
    assert.equal(batch.XPROOF_WATCHER_SERVICE_TOKEN.type, 'sensitive');
    assert.equal(batch.XPROOF_BASE_RELAYER_PRIVATE_KEY, undefined);
    for (const entry of Object.values(batch)) assert.deepEqual(entry.target, ['preview']);
  }

  const relay = entriesByKey(relayEnvironment({
    relayerPrivateKey: RELAYER_KEY,
    relayerAddress: RELAYER.address,
    relayServiceToken: RELAY_TOKEN,
    watcherOrigins: [
      'https://influencedx-campaign-watcher-1-preview.vercel.app',
      'https://influencedx-campaign-watcher-2-preview.vercel.app',
      'https://influencedx-campaign-watcher-3-preview.vercel.app',
    ],
    watcherServiceTokens: WATCHER_TOKENS,
    configEpoch: CONFIG_EPOCH,
  }));
  assert.equal(relay.XPROOF_CAMPAIGN_RELAY_ENABLED.value, 'false');
  assert.equal(relay.XPROOF_CAMPAIGN_RELAY_BROADCAST_ENABLED.value, 'false');
  assert.equal(relay.DATABASE_URL, undefined);
  assert.equal(relay.XPROOF_BASE_RELAYER_PRIVATE_KEY.value, RELAYER_KEY);
  assert.equal(relay.XPROOF_BASE_RELAYER_PRIVATE_KEY.type, 'sensitive');
  assert.equal(relay.XPROOF_RELAYER_MAX_BALANCE_WEI.value, RELAYER_MAX_BALANCE_WEI.toString());
  for (const watcherKey of WATCHER_KEYS) {
    assert.equal(JSON.stringify(relay).includes(watcherKey), false);
  }

  const web = entriesByKey(webEnvironment({
    relayOrigin: 'https://influencedx-campaign-relay-preview.vercel.app',
    relayServiceToken: RELAY_TOKEN,
    configEpoch: CONFIG_EPOCH,
  }));
  assert.equal(web.XPROOF_CAMPAIGN_RELAY_BRIDGE_ENABLED.value, 'false');
  assert.equal(web.XPROOF_APP_ORIGIN.value, 'https://influencedx-preview.vercel.app');
  assert.equal(web.XPROOF_CAMPAIGN_RELAY_SERVICE_TOKEN.type, 'sensitive');
  assert.equal(web.XPROOF_SETTLEMENT_CONFIG_EPOCH.value, CONFIG_EPOCH);
  assert.equal(JSON.stringify(web).includes(RELAYER_KEY), false);
  assert.equal(JSON.stringify(web).includes('postgresql://'), false);
  assert.deepEqual(databaseConnectionRequest(), {
    projectId: 'prj_bMx328GNrJUIcRx5DwGpIeUEz9Jg',
    envVarEnvironments: ['preview'],
    makeEnvVarsSensitive: true,
  });
});

test('hosted database metadata requires the exact xproof-db project binding and scope', () => {
  const webProject = {
    id: 'prj_4W0EuXNi5nFD46ArUAbvk2YnTacu',
    name: 'influencedx',
  };
  const webEntry = {
    key: 'DATABASE_URL',
    type: 'encrypted',
    target: ['production', 'preview', 'development'],
    gitBranch: null,
    customEnvironmentIds: null,
    configurationId: null,
  };
  const webConnection = {
    projectId: webProject.id,
    project: webProject,
    envVarEnvironments: ['production', 'preview', 'development'],
    envVarPrefix: null,
  };
  const metadata = {
    entries: [webEntry],
    connections: [webConnection],
    project: webProject,
    expectedTargets: ['production', 'preview', 'development'],
    expectedType: 'encrypted',
  };
  assert.equal(exactDatabaseBindingMetadata(metadata), true);
  assert.equal(exactDatabaseBindingMetadata({
    ...metadata,
    entries: [{ ...webEntry, gitBranch: 'unsafe' }],
  }), false);
  assert.equal(exactDatabaseBindingMetadata({
    ...metadata,
    entries: [{ ...webEntry, target: ['preview'] }],
  }), false);
  assert.equal(exactDatabaseBindingMetadata({
    ...metadata,
    entries: [{ ...webEntry, type: 'sensitive' }],
  }), false);
  assert.equal(exactDatabaseBindingMetadata({
    ...metadata,
    connections: [{ ...webConnection, envVarEnvironments: ['preview'] }],
  }), false);
  assert.equal(exactDatabaseBindingMetadata({
    ...metadata,
    connections: [{ ...webConnection, projectId: 'prj_unrelated' }],
  }), false);
  assert.equal(exactDatabaseBindingMetadata({
    ...metadata,
    connections: [webConnection, webConnection],
  }), false);

  const relayProject = {
    id: 'prj_bMx328GNrJUIcRx5DwGpIeUEz9Jg',
    name: 'influencedx-campaign-relay',
  };
  const relayMetadata = {
    entries: [{
      ...webEntry,
      type: 'sensitive',
      target: ['preview'],
    }],
    connections: [{
      projectId: relayProject.id,
      project: relayProject,
      envVarEnvironments: ['preview'],
      envVarPrefix: null,
    }],
    project: relayProject,
    expectedTargets: ['preview'],
    expectedType: 'sensitive',
  };
  assert.equal(exactDatabaseBindingMetadata(relayMetadata), true);
  assert.equal(exactDatabaseBindingMetadata({
    ...relayMetadata,
    entries: [{ ...relayMetadata.entries[0], target: ['preview', 'production'] }],
  }), false);
  assert.equal(exactDatabaseBindingMetadata({
    ...relayMetadata,
    connections: [{ ...relayMetadata.connections[0], envVarPrefix: 'OTHER_' }],
  }), false);
});

test('only the exact stable READY Preview deployment is accepted', () => {
  const project = {
    id: 'prj_exactRelay123',
    name: 'influencedx-campaign-relay',
  };
  const deployment = {
    projectId: project.id,
    name: project.name,
    ownerId: 'team_2L0T4LCdFsCTFcckeTFWZRvN',
    readyState: 'READY',
    target: null,
  };
  assert.equal(stablePreviewOriginForDeployment({
    project,
    deployment,
  }), 'https://influencedx-campaign-relay-preview.vercel.app');
  assert.throws(() => stablePreviewOriginForDeployment({
    project,
    deployment: { ...deployment, target: 'production' },
  }), /READY non-production deployment/);
  assert.throws(() => stablePreviewOriginForDeployment({
    project,
    deployment: { ...deployment, projectId: 'prj_wrongProject123' },
  }), /different Vercel project/);
  assert.throws(() => stablePreviewOriginForDeployment({
    project,
    deployment: { ...deployment, ownerId: 'team_wrongTeam123' },
  }), /different Vercel team/);
});

test('fresh relayer material is encrypted and its password can be zeroized', async () => {
  const material = await createEncryptedRelayerMaterial({
    kdfParams: { N: 1_024, r: 8, p: 1 },
  });
  const passwordCopy = Buffer.from(material.password);
  try {
    assert.equal(material.keystore.includes(material.privateKey.slice(2)), false);
    assert.equal(material.keystore.includes(passwordCopy.toString('hex')), false);
    const decrypted = await decryptKeystoreJson(material.keystore, passwordCopy);
    assert.equal(privateKeyToAccount(decrypted.privateKey).address, material.account.address);
  } finally {
    material.password.fill(0);
    passwordCopy.fill(0);
  }
  assert.ok(material.password.every((byte) => byte === 0));
});

test('launcher is an explicit one-shot gate and does not persist plaintext token state', async () => {
  const source = await fs.readFile(
    new URL('../../scripts/configure-campaign-watchers-preview.mjs', import.meta.url),
    'utf8',
  );
  assert.equal(APPLY_CONFIRMATION, 'CONFIGURE INFLUENCEDX SETTLEMENT PREVIEW');
  assert.equal(RESUME_CONFIRMATION, 'RESUME INFLUENCEDX SETTLEMENT PREVIEW');
  assert.equal(previewSetupMode(['--apply']), 'fresh');
  assert.equal(previewSetupMode(['--resume', '--apply']), 'resume');
  assert.throws(() => previewSetupMode(['--resume']), /Refusing to mutate/);
  assert.match(source, /promptForKeystorePassword/);
  assert.match(source, /campaign-settlement-preview\.json/);
  assert.match(source, /Legacy plaintext campaign settlement state exists/);
  assert.doesNotMatch(source, /'--raw'/);
  assert.doesNotMatch(source, /'--silent'/);
  assert.doesNotMatch(source, /watcherServiceTokens:\s*WATCHERS\.map/);
  assert.doesNotMatch(source, /writeFile\([^\n]*relayServiceToken/);
  assert.doesNotMatch(source, /cmd\.exe/);
  const fundingSource = source.slice(
    source.indexOf('async function fundRelayer'),
    source.indexOf('export function previewSetupMode'),
  );
  assert.ok(fundingSource.indexOf('await persistFundingIntent')
    < fundingSource.indexOf('sendRawTransaction'));
  assert.ok(source.indexOf('await applyDisabledEnvironmentPlan')
    < source.indexOf('const deployer = await loadBaseSepoliaDeployer'));
});

test('funding fence requires zero balance plus zero latest and pending nonce', () => {
  assert.doesNotThrow(() => assertUnusedRelayerState({
    balance: 0n,
    latestNonce: 0,
    pendingNonce: 0,
  }));
  assert.throws(() => assertUnusedRelayerState({ balance: 1n, latestNonce: 0, pendingNonce: 0 }),
    /balance/);
  assert.throws(() => assertUnusedRelayerState({ balance: 0n, latestNonce: 1, pendingNonce: 1 }),
    /nonce/);
  assert.throws(() => assertUnusedRelayerState({ balance: 0n, latestNonce: 0, pendingNonce: 1 }),
    /nonce/);
});

test('confirmed funding tolerates a lagging latest-balance RPC response', async () => {
  const balances = [0n, 0n, 1_000_000_000_000_000n];
  let sleeps = 0;
  const publicClient = {
    getBalance: async () => balances.shift(),
    getTransactionCount: async () => 0,
  };
  const state = await waitForConfirmedRelayerState(publicClient, RELAYER.address, {
    attempts: 3,
    delayMs: 0,
    sleep: async () => { sleeps += 1; },
  });
  assert.equal(state.balance, 1_000_000_000_000_000n);
  assert.equal(sleeps, 2);
});

test('confirmed funding never retries past nonce use or excess balance', async () => {
  await assert.rejects(() => waitForConfirmedRelayerState({
    getBalance: async () => RELAYER_MAX_BALANCE_WEI + 1n,
    getTransactionCount: async () => 0,
  }, RELAYER.address, { attempts: 2, delayMs: 0 }), /low-balance policy/);
  let nonceCalls = 0;
  await assert.rejects(() => waitForConfirmedRelayerState({
    getBalance: async () => 0n,
    getTransactionCount: async () => {
      nonceCalls += 1;
      return nonceCalls === 1 ? 1 : 0;
    },
  }, RELAYER.address, { attempts: 2, delayMs: 0 }), /transaction nonce/);
});

test('disabled environment rollout uses one-entry upserts, false flags first, and verifies epoch', async () => {
  const records = new Map();
  const posts = [];
  const projects = Array.from({ length: 5 }, (_, index) => ({
    id: `prj_test${index + 1}`,
    name: `test-project-${index + 1}`,
  }));
  const safetyKeys = [
    'XPROOF_CAMPAIGN_WATCHER_ENABLED',
    'XPROOF_CAMPAIGN_WATCHER_ENABLED',
    'XPROOF_CAMPAIGN_WATCHER_ENABLED',
    'XPROOF_CAMPAIGN_RELAY_ENABLED',
    'XPROOF_CAMPAIGN_RELAY_BRIDGE_ENABLED',
  ];
  const batches = projects.map((project, index) => ({
    project,
    entries: [
      { key: safetyKeys[index], value: 'false', type: 'plain', target: ['preview'] },
      { key: 'XPROOF_SETTLEMENT_CONFIG_EPOCH', value: CONFIG_EPOCH, type: 'plain', target: ['preview'] },
      { key: `XPROOF_TOKEN_${index}`, value: `secret-${index}`, type: 'sensitive', target: ['preview'] },
    ],
  }));
  const api = async (endpoint, { method = 'GET', body } = {}) => {
    const projectId = /projects\/([^/]+)/.exec(endpoint)?.[1];
    if (!records.has(projectId)) records.set(projectId, new Map());
    const projectRecords = records.get(projectId);
    if (method === 'POST') {
      assert.equal(Array.isArray(body), false);
      posts.push({ projectId, key: body.key, value: body.value });
      const record = {
        ...body,
        target: projectId === projects[0].id ? 'preview' : body.target,
        id: `${projectId}-${body.key}`,
        customEnvironmentIds: [],
      };
      projectRecords.set(body.key, record);
      return { created: record, failed: [] };
    }
    const id = /\/env\/([^?]+)/.exec(endpoint)?.[1];
    if (id) return [...projectRecords.values()].find((entry) => entry.id === id);
    return { envs: [...projectRecords.values()] };
  };
  await applyDisabledEnvironmentPlan(api, batches);
  const firstNonSafety = posts.findIndex(({ key }) => !safetyKeys.includes(key));
  assert.equal(firstNonSafety, 5);
  assert.equal(posts.length, 20);
  assert.ok(posts.slice(5, 10).every(({ key, value }) => (
    key === 'XPROOF_SETTLEMENT_CONFIG_EPOCH' && value.startsWith('pending:')
  )));
  assert.equal(new Set(posts.slice(5, 10).map(({ value }) => value)).size, 5);
  assert.ok(posts.slice(-5).every(({ key }) => key === 'XPROOF_SETTLEMENT_CONFIG_EPOCH'));
  assert.ok(posts.slice(-5).every(({ value }) => value === CONFIG_EPOCH));

  records.get(projects[0].id).set('branch-override', {
    ...batches[0].entries[0],
    id: 'branch-override-id',
    gitBranch: 'unsafe-override',
    customEnvironmentIds: [],
  });
  await assert.rejects(applyDisabledEnvironmentPlan(api, batches), /branch-scoped or mixed/);
});

test('Vercel diagnostics expose only an allowlisted code, never raw API text or values', async () => {
  const privateValue = `0x${'ab'.repeat(32)}`;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stderr.end(`INVALID_VALUE raw-secret=${privateValue}`);
      child.stdout.end();
      child.emit('exit', 1);
    });
    return child;
  };
  const api = createVercelApi({ env: { APPDATA: 'C:\\bounded-test' }, spawnFn });
  await assert.rejects(
    api('/v10/projects/prj_secret/env?upsert=true', {
      method: 'POST',
      body: { key: 'SAFE_KEY', value: privateValue, type: 'sensitive', target: ['preview'] },
    }),
    (error) => {
      assert.match(error.message, /code=INVALID_VALUE/);
      assert.doesNotMatch(error.message, /raw-secret|ab{10}|SAFE_KEY/);
      return true;
    },
  );
});

test('environment failed response is rejected even when the CLI request succeeds', async () => {
  const projects = Array.from({ length: 5 }, (_, index) => ({
    project: { id: `prj_failed${index}`, name: `failed-${index}` },
    entries: [{
      key: 'XPROOF_CAMPAIGN_WATCHER_ENABLED',
      value: 'false',
      type: 'plain',
      target: ['preview'],
    }],
  }));
  await assert.rejects(
    applyDisabledEnvironmentPlan(async () => ({
      created: [],
      failed: [{ error: { code: 'INVALID_VALUE', message: 'raw secret must never escape' } }],
    }), projects),
    (error) => {
      assert.match(error.message, /code=INVALID_VALUE/);
      assert.doesNotMatch(error.message, /raw secret/);
      return true;
    },
  );
});
