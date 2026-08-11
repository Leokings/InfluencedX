import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { encryptKeystoreJson } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';

import {
  loadBaseSepoliaRelayer,
  promptForRelayerKeystorePassword,
} from '../../scripts/lib/base-relayer-account.mjs';

const PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const PASSWORD = 'test-only relayer keystore password';
const EXPECTED_ADDRESS = privateKeyToAccount(PRIVATE_KEY).address;

async function withKeystore(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xproof-relayer-keystore-test-'));
  const keystorePath = path.join(directory, 'relayer.keystore.json');
  const keystore = await encryptKeystoreJson(
    { address: EXPECTED_ADDRESS, privateKey: PRIVATE_KEY },
    PASSWORD,
    { scrypt: { N: 1024, r: 8, p: 1 } },
  );
  await fs.writeFile(keystorePath, keystore, { mode: 0o600 });
  try {
    await run({ directory, keystore, keystorePath });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('decrypts a Web3 Secret Storage v3 relayer keystore from a password file', async () => {
  await withKeystore(async ({ directory, keystorePath }) => {
    const passwordPath = path.join(directory, 'relayer.password');
    await fs.writeFile(passwordPath, `${PASSWORD}\r\n`, { mode: 0o600 });

    const account = await loadBaseSepoliaRelayer({
      env: {
        BASE_RELAYER_KEYSTORE_PATH: keystorePath,
        BASE_RELAYER_KEYSTORE_PASSWORD_FILE: passwordPath,
      },
    });

    assert.equal(account.address, EXPECTED_ADDRESS);
  });
});

test('uses the hidden-prompt seam and zeroizes its password buffer', async () => {
  await withKeystore(async ({ keystorePath }) => {
    const suppliedPassword = Buffer.from(PASSWORD);
    const account = await loadBaseSepoliaRelayer({
      env: { BASE_RELAYER_KEYSTORE_PATH: keystorePath },
      promptPassword: async () => suppliedPassword,
    });

    assert.equal(account.address, EXPECTED_ADDRESS);
    assert.ok(suppliedPassword.every((byte) => byte === 0));
  });
});

test('zeroizes bytes read from the password file', async () => {
  await withKeystore(async ({ keystore }) => {
    const passwordBytes = Buffer.from(`${PASSWORD}\n`);
    const account = await loadBaseSepoliaRelayer({
      env: {
        BASE_RELAYER_KEYSTORE_PATH: 'relayer.json',
        BASE_RELAYER_KEYSTORE_PASSWORD_FILE: 'relayer.password',
      },
      cwd: 'C:\\isolated-test',
      stat: async (filePath) => ({
        isFile: () => true,
        mode: 0o600,
        size: filePath.endsWith('.json') ? Buffer.byteLength(keystore) : passwordBytes.length,
      }),
      readFile: async (filePath, encoding) => {
        if (encoding === 'utf8') return keystore;
        assert.match(filePath, /relayer\.password$/);
        return passwordBytes;
      },
    });

    assert.equal(account.address, EXPECTED_ADDRESS);
    assert.ok(passwordBytes.every((byte) => byte === 0));
  });
});

test('fails closed for mixed raw-key and keystore sources', async () => {
  await assert.rejects(
    loadBaseSepoliaRelayer({
      env: {
        BASE_RELAYER_PRIVATE_KEY: PRIVATE_KEY,
        BASE_RELAYER_ALLOW_TEST_ONLY_RAW_KEY: 'true',
        BASE_RELAYER_KEYSTORE_PATH: 'relayer.json',
      },
    }),
    /Choose one relayer credential source/,
  );
});

test('raw private-key compatibility requires an exact test-only opt-in', async () => {
  await assert.rejects(
    loadBaseSepoliaRelayer({ env: { BASE_RELAYER_PRIVATE_KEY: PRIVATE_KEY } }),
    /test-only and disabled/,
  );
  await assert.rejects(
    loadBaseSepoliaRelayer({
      env: {
        BASE_RELAYER_PRIVATE_KEY: PRIVATE_KEY,
        BASE_RELAYER_ALLOW_TEST_ONLY_RAW_KEY: 'TRUE',
      },
    }),
    /test-only and disabled/,
  );

  const account = await loadBaseSepoliaRelayer({
    env: {
      BASE_RELAYER_PRIVATE_KEY: PRIVATE_KEY,
      BASE_RELAYER_ALLOW_TEST_ONLY_RAW_KEY: 'true',
    },
  });
  assert.equal(account.address, EXPECTED_ADDRESS);
});

test('rejects inline password strings and orphaned credential options', async () => {
  await assert.rejects(
    loadBaseSepoliaRelayer({
      env: {
        BASE_RELAYER_KEYSTORE_PATH: 'relayer.json',
        BASE_RELAYER_KEYSTORE_PASSWORD: PASSWORD,
      },
    }),
    /KEYSTORE_PASSWORD is not supported/,
  );
  await assert.rejects(
    loadBaseSepoliaRelayer({ env: { BASE_RELAYER_KEYSTORE_PASSWORD_FILE: 'password.txt' } }),
    /KEYSTORE_PATH is required/,
  );
  await assert.rejects(
    loadBaseSepoliaRelayer({ env: { BASE_RELAYER_ALLOW_TEST_ONLY_RAW_KEY: 'true' } }),
    /requires BASE_RELAYER_PRIVATE_KEY/,
  );
});

test('requires separate keystore and password files', async () => {
  await withKeystore(async ({ keystorePath }) => {
    await assert.rejects(
      loadBaseSepoliaRelayer({
        env: {
          BASE_RELAYER_KEYSTORE_PATH: keystorePath,
          BASE_RELAYER_KEYSTORE_PASSWORD_FILE: keystorePath,
        },
      }),
      /must be different files/,
    );
  });
});

test('validates keystore file type and bounded size before reading it', async () => {
  let reads = 0;
  await assert.rejects(
    loadBaseSepoliaRelayer({
      env: { BASE_RELAYER_KEYSTORE_PATH: 'relayer.json' },
      stat: async () => ({ isFile: () => false, size: 1 }),
      readFile: async () => {
        reads += 1;
        return '{}';
      },
    }),
    /must point to a file/,
  );
  await assert.rejects(
    loadBaseSepoliaRelayer({
      env: { BASE_RELAYER_KEYSTORE_PATH: 'relayer.json' },
      stat: async () => ({ isFile: () => true, size: 1024 * 1024 + 1 }),
      readFile: async () => {
        reads += 1;
        return '{}';
      },
    }),
    /between 1 byte and 1 MiB/,
  );
  assert.equal(reads, 0);
});

test('sanitizes decryption failures and zeroizes the wrong password', async () => {
  await withKeystore(async ({ keystorePath }) => {
    const secret = Buffer.from('do-not-leak-this-relayer-password');
    const secretText = secret.toString('utf8');
    await assert.rejects(
      loadBaseSepoliaRelayer({
        env: { BASE_RELAYER_KEYSTORE_PATH: keystorePath },
        promptPassword: async () => secret,
      }),
      (error) => {
        assert.match(error.message, /Unable to decrypt/);
        assert.doesNotMatch(error.message, new RegExp(secretText));
        return true;
      },
    );
    assert.ok(secret.every((byte) => byte === 0));
  });
});

test('hidden prompt refuses to fall back to echoed input without a TTY', async () => {
  await assert.rejects(
    promptForRelayerKeystorePassword({
      input: { isTTY: false },
      output: { isTTY: false },
    }),
    /No interactive terminal/,
  );
});

test('relay-submit delegates credential loading and has no direct raw-key conversion', async () => {
  const source = await fs.readFile(
    new URL('../../scripts/relay-submit.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /import \{ loadBaseSepoliaRelayer \}/);
  assert.match(source, /const account = await loadBaseSepoliaRelayer\(\)/);
  assert.doesNotMatch(source, /privateKeyToAccount/);
  assert.doesNotMatch(source, /process\.env\.BASE_RELAYER_PRIVATE_KEY/);
});
