import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { encryptKeystoreJson } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';

import { loadBaseSepoliaDeployer } from '../../scripts/lib/base-deployer-account.mjs';

const PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const PASSWORD = 'test-only keystore password';
const EXPECTED_ADDRESS = privateKeyToAccount(PRIVATE_KEY).address;

async function withKeystore(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xproof-keystore-test-'));
  const keystorePath = path.join(directory, 'account.json');
  const keystore = await encryptKeystoreJson(
    { address: EXPECTED_ADDRESS, privateKey: PRIVATE_KEY },
    PASSWORD,
    { scrypt: { N: 1024, r: 8, p: 1 } },
  );
  await fs.writeFile(keystorePath, keystore, { mode: 0o600 });
  try {
    await run({ directory, keystorePath });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('loads the legacy raw private-key configuration', async () => {
  const account = await loadBaseSepoliaDeployer({
    env: { BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY: PRIVATE_KEY },
  });
  assert.equal(account.address, EXPECTED_ADDRESS);
});

test('decrypts a Web3 JSON keystore using a password file', async () => {
  await withKeystore(async ({ directory, keystorePath }) => {
    const passwordPath = path.join(directory, 'password.txt');
    await fs.writeFile(passwordPath, `${PASSWORD}\r\n`, { mode: 0o600 });
    const account = await loadBaseSepoliaDeployer({
      env: {
        BASE_SEPOLIA_DEPLOYER_KEYSTORE_PATH: keystorePath,
        BASE_SEPOLIA_DEPLOYER_KEYSTORE_PASSWORD_FILE: passwordPath,
      },
    });
    assert.equal(account.address, EXPECTED_ADDRESS);
  });
});

test('decrypts a Web3 JSON keystore using the interactive-password seam', async () => {
  await withKeystore(async ({ keystorePath }) => {
    let prompted = 0;
    const suppliedPassword = Buffer.from(PASSWORD);
    const account = await loadBaseSepoliaDeployer({
      env: { BASE_SEPOLIA_DEPLOYER_KEYSTORE_PATH: keystorePath },
      promptPassword: async () => {
        prompted += 1;
        return suppliedPassword;
      },
    });
    assert.equal(account.address, EXPECTED_ADDRESS);
    assert.equal(prompted, 1);
    assert.ok(suppliedPassword.every((byte) => byte === 0));
  });
});

test('rejects ambiguous raw-key and keystore configuration', async () => {
  await assert.rejects(
    loadBaseSepoliaDeployer({
      env: {
        BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY: PRIVATE_KEY,
        BASE_SEPOLIA_DEPLOYER_KEYSTORE_PATH: 'account.json',
      },
    }),
    /Choose one deployer credential source/,
  );
});

test('rejects multiple password sources before reading the keystore', async () => {
  await withKeystore(async ({ keystorePath }) => {
    await assert.rejects(
      loadBaseSepoliaDeployer({
        env: {
          BASE_SEPOLIA_DEPLOYER_KEYSTORE_PATH: keystorePath,
          BASE_SEPOLIA_DEPLOYER_KEYSTORE_PASSWORD: PASSWORD,
          BASE_SEPOLIA_DEPLOYER_KEYSTORE_PASSWORD_FILE: 'password.txt',
        },
      }),
      /Set only one.*KEYSTORE_PASSWORD/s,
    );
  });
});

test('does not expose a wrong password in its error', async () => {
  await withKeystore(async ({ keystorePath }) => {
    const secret = 'do-not-leak-this-password';
    await assert.rejects(
      loadBaseSepoliaDeployer({
        env: {
          BASE_SEPOLIA_DEPLOYER_KEYSTORE_PATH: keystorePath,
          BASE_SEPOLIA_DEPLOYER_KEYSTORE_PASSWORD: secret,
        },
      }),
      (error) => {
        assert.match(error.message, /Unable to decrypt/);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
  });
});
