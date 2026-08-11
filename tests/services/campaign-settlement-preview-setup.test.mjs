import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { decryptKeystoreJson } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';

import {
  APPLY_CONFIRMATION,
  RELAYER_MAX_BALANCE_WEI,
  WATCHERS,
  callerOidcPatch,
  createEncryptedRelayerMaterial,
  relayEnvironment,
  selectStablePreviewOrigin,
  trustedSourcesPatch,
  watcherEnvironment,
  webEnvironment,
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
    databaseUrl: 'postgresql://fixture:fixture@localhost/fixture',
    relayerPrivateKey: RELAYER_KEY,
    relayerAddress: RELAYER.address,
    relayServiceToken: RELAY_TOKEN,
    watcherOrigins: [
      'https://influencedx-campaign-watcher-1-preview.vercel.app',
      'https://influencedx-campaign-watcher-2-preview.vercel.app',
      'https://influencedx-campaign-watcher-3-preview.vercel.app',
    ],
    watcherServiceTokens: WATCHER_TOKENS,
  }));
  assert.equal(relay.XPROOF_CAMPAIGN_RELAY_ENABLED.value, 'false');
  assert.equal(relay.XPROOF_CAMPAIGN_RELAY_BROADCAST_ENABLED.value, 'false');
  assert.equal(relay.XPROOF_BASE_RELAYER_PRIVATE_KEY.value, RELAYER_KEY);
  assert.equal(relay.XPROOF_BASE_RELAYER_PRIVATE_KEY.type, 'sensitive');
  assert.equal(relay.XPROOF_RELAYER_MAX_BALANCE_WEI.value, RELAYER_MAX_BALANCE_WEI.toString());
  for (const watcherKey of WATCHER_KEYS) {
    assert.equal(JSON.stringify(relay).includes(watcherKey), false);
  }

  const web = entriesByKey(webEnvironment({
    relayOrigin: 'https://influencedx-campaign-relay-preview.vercel.app',
    relayServiceToken: RELAY_TOKEN,
  }));
  assert.equal(web.XPROOF_CAMPAIGN_RELAY_BRIDGE_ENABLED.value, 'false');
  assert.equal(web.XPROOF_CAMPAIGN_RELAY_SERVICE_TOKEN.type, 'sensitive');
  assert.equal(JSON.stringify(web).includes(RELAYER_KEY), false);
  assert.equal(JSON.stringify(web).includes('postgresql://'), false);
});

test('only the exact stable READY Preview alias is accepted', () => {
  assert.equal(selectStablePreviewOrigin({
    projectName: 'influencedx-campaign-relay',
    deployments: [{
      readyState: 'READY',
      target: null,
      alias: [
        'influencedx-campaign-relay-preview.vercel.app',
        'influencedx-campaign-relay.vercel.app',
      ],
    }],
  }), 'https://influencedx-campaign-relay-preview.vercel.app');
  assert.throws(() => selectStablePreviewOrigin({
    projectName: 'influencedx-campaign-relay',
    deployments: [{
      readyState: 'READY',
      target: 'production',
      alias: ['influencedx-campaign-relay-preview.vercel.app'],
    }],
  }), /exactly one READY fixed Preview alias/);
  assert.throws(() => selectStablePreviewOrigin({
    projectName: 'influencedx-campaign-relay',
    deployments: [{
      readyState: 'READY',
      target: null,
      alias: ['influencedx-campaign-relay-git-main-team.vercel.app'],
    }],
  }), /exactly one READY fixed Preview alias/);
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
  assert.match(source, /argv\.length === 1 && argv\[0\] === '--apply'/);
  assert.match(source, /promptForKeystorePassword/);
  assert.match(source, /campaign-settlement-preview\.json/);
  assert.match(source, /Legacy plaintext campaign settlement state exists/);
  assert.match(source, /'--raw'/);
  assert.doesNotMatch(source, /'--silent'/);
  assert.doesNotMatch(source, /watcherServiceTokens:\s*WATCHERS\.map/);
  assert.doesNotMatch(source, /writeFile\([^\n]*relayServiceToken/);
  assert.doesNotMatch(source, /cmd\.exe/);
});
