import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { decryptKeystoreJson } from 'ethers';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  createWatcherKeystoreSet,
  decryptWatcherAccount,
  encryptWatcherPrivateKey,
  loadWatcherAccountFromFiles,
  parseWatcherKeystore,
  writeWatcherKeystore,
} from '../../src/relay/watcher-keystore.mjs';

const FAST_TEST_KDF = Object.freeze({ N: 1_024, r: 8, p: 1 });
const PASSWORD = 'fixture-password-is-not-a-real-secret';
const PRIVATE_KEY = `0x${'11'.repeat(32)}`;

function typedPayload() {
  return {
    domain: {
      name: 'XProofAttestationReceiver',
      version: '2',
      chainId: 84_532,
      verifyingContract: '0x1111111111111111111111111111111111111111',
    },
    types: {
      WatcherFixture: [{ name: 'resultHash', type: 'bytes32' }],
    },
    primaryType: 'WatcherFixture',
    message: { resultHash: `0x${'ab'.repeat(32)}` },
  };
}

test('encrypted watcher account signs the same EIP-712 payload used by relay-watcher', async () => {
  const keystore = await encryptWatcherPrivateKey({
    privateKey: PRIVATE_KEY,
    password: PASSWORD,
    salt: Buffer.alloc(32, 0x22),
    iv: Buffer.alloc(16, 0x33),
    uuid: Buffer.alloc(16, 0x34),
    kdfParams: FAST_TEST_KDF,
  });
  const serialized = JSON.stringify(keystore);
  assert.equal(serialized.includes(PRIVATE_KEY.slice(2)), false);
  assert.equal(serialized.includes(PASSWORD), false);
  assert.equal(keystore.version, 3);
  assert.equal(`0x${keystore.address}`, privateKeyToAccount(PRIVATE_KEY).address.toLowerCase());
  assert.equal((await decryptKeystoreJson(serialized, PASSWORD)).privateKey, PRIVATE_KEY);

  const account = await decryptWatcherAccount({ keystore, password: PASSWORD });
  const payload = typedPayload();
  const signature = await account.signTypedData(payload);
  assert.equal(await recoverTypedDataAddress({ ...payload, signature }), account.address);
});

test('wrong passwords, ciphertext tampering, and address tampering fail closed', async () => {
  const keystore = await encryptWatcherPrivateKey({
    privateKey: PRIVATE_KEY,
    password: PASSWORD,
    salt: Buffer.alloc(32, 0x44),
    iv: Buffer.alloc(16, 0x55),
    uuid: Buffer.alloc(16, 0x56),
    kdfParams: FAST_TEST_KDF,
  });

  await assert.rejects(
    decryptWatcherAccount({ keystore, password: 'a-different-fixture-password' }),
    /Unable to decrypt watcher keystore/,
  );

  const tamperedCiphertext = structuredClone(keystore);
  const replacement = tamperedCiphertext.Crypto.ciphertext.endsWith('00') ? '01' : '00';
  tamperedCiphertext.Crypto.ciphertext = `${tamperedCiphertext.Crypto.ciphertext.slice(0, -2)}${replacement}`;
  await assert.rejects(
    decryptWatcherAccount({ keystore: tamperedCiphertext, password: PASSWORD }),
    /Unable to decrypt watcher keystore/,
  );

  const tamperedAddress = structuredClone(keystore);
  tamperedAddress.address = '2222222222222222222222222222222222222222';
  await assert.rejects(
    decryptWatcherAccount({ keystore: tamperedAddress, password: PASSWORD }),
    /Unable to decrypt watcher keystore/,
  );
});

test('testnet bootstrap creates exactly three unique encrypted watcher identities', async () => {
  const passwords = [
    Buffer.from('watcher-one-fixture-password'),
    Buffer.from('watcher-two-fixture-password'),
    Buffer.from('watcher-three-fixture-password'),
  ];
  const keystores = await createWatcherKeystoreSet({ passwords, kdfParams: FAST_TEST_KDF });
  assert.equal(keystores.length, 3);
  assert.equal(new Set(keystores.map(({ address }) => address.toLowerCase())).size, 3);
  for (const keystore of keystores) {
    assert.equal(parseWatcherKeystore(keystore).xproof.network, 'testnet-only');
    assert.equal(JSON.stringify(keystore).includes('privateKey'), false);
  }
});

test('file loader accepts only encrypted keystore and password paths', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xproof-watcher-fixture-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keystorePath = path.join(directory, 'watcher.keystore.json');
  const passwordPath = path.join(directory, 'watcher.password');
  const keystore = await encryptWatcherPrivateKey({
    privateKey: PRIVATE_KEY,
    password: PASSWORD,
    salt: Buffer.alloc(32, 0x66),
    iv: Buffer.alloc(16, 0x77),
    uuid: Buffer.alloc(16, 0x78),
    kdfParams: FAST_TEST_KDF,
  });
  writeWatcherKeystore(keystorePath, keystore);
  fs.writeFileSync(passwordPath, `${PASSWORD}\n`, { mode: 0o600, flag: 'wx' });

  const account = await loadWatcherAccountFromFiles({ keystorePath, passwordFilePath: passwordPath });
  assert.equal(account.address.toLowerCase(), `0x${keystore.address}`);
  await assert.rejects(
    loadWatcherAccountFromFiles({ keystorePath: undefined, passwordFilePath: passwordPath }),
    /ADPROOF_WATCHER_KEYSTORE_PATH is required/,
  );
});

test('bootstrap rejects password reuse', async () => {
  await assert.rejects(
    createWatcherKeystoreSet({
      passwords: [PASSWORD, PASSWORD, 'third-fixture-password-is-distinct'],
      kdfParams: FAST_TEST_KDF,
    }),
    /different password/,
  );
});
