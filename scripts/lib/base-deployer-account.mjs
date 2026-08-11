import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { decryptKeystoreJson, isKeystoreJson } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const MAX_KEYSTORE_BYTES = 1024 * 1024;

function configured(value) {
  return typeof value === 'string' && value.length > 0;
}

function passwordFromEnvironment(value) {
  return Buffer.from(value, 'utf8');
}

async function passwordFromFile(filePath, { cwd, readFile }) {
  const absolutePath = path.resolve(cwd, filePath);
  const raw = await readFile(absolutePath);
  let end = raw.length;
  if (end > 0 && raw[end - 1] === 0x0a) end -= 1;
  if (end > 0 && raw[end - 1] === 0x0d) end -= 1;
  const password = Buffer.from(raw.subarray(0, end));
  raw.fill(0);
  return password;
}

export async function promptForKeystorePassword({
  input = process.stdin,
  output = process.stderr,
} = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error(
      'No interactive terminal is available. Set BASE_SEPOLIA_DEPLOYER_KEYSTORE_PASSWORD '
      + 'or BASE_SEPOLIA_DEPLOYER_KEYSTORE_PASSWORD_FILE.',
    );
  }

  output.write('Password input is active; each key appears as * and Backspace erases one key.\n');
  output.write('Base Sepolia deployer keystore password: ');
  readline.emitKeypressEvents(input);
  const previousRawMode = Boolean(input.isRaw);
  const chunks = [];

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.off('keypress', onKeypress);
      input.setRawMode(previousRawMode);
      input.pause();
      output.write('\n');
    };

    const finish = () => {
      cleanup();
      const password = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      resolve(password);
    };

    const cancel = () => {
      cleanup();
      for (const chunk of chunks) chunk.fill(0);
      reject(new Error('Keystore password prompt cancelled'));
    };

    function onKeypress(sequence, key = {}) {
      if ((key.ctrl && key.name === 'c') || sequence === '\u0003') {
        cancel();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (chunks.length === 0) {
          output.write('\nPassword cannot be empty; type it now (each key appears as *): ');
          return;
        }
        finish();
        return;
      }
      if (key.name === 'backspace') {
        const removed = chunks.pop();
        if (removed) {
          removed.fill(0);
          output.write('\b \b');
        }
        return;
      }
      if (typeof sequence === 'string' && sequence.length > 0 && !key.ctrl && !key.meta) {
        chunks.push(Buffer.from(sequence, 'utf8'));
        output.write('*');
      }
    }

    input.setRawMode(true);
    input.on('keypress', onKeypress);
    input.resume();
  });
}

async function loadPassword(env, options) {
  const inlinePassword = env.BASE_SEPOLIA_DEPLOYER_KEYSTORE_PASSWORD;
  const passwordFile = env.BASE_SEPOLIA_DEPLOYER_KEYSTORE_PASSWORD_FILE;
  if (configured(inlinePassword) && configured(passwordFile)) {
    throw new Error(
      'Set only one of BASE_SEPOLIA_DEPLOYER_KEYSTORE_PASSWORD '
      + 'or BASE_SEPOLIA_DEPLOYER_KEYSTORE_PASSWORD_FILE',
    );
  }
  if (configured(inlinePassword)) return passwordFromEnvironment(inlinePassword);
  if (configured(passwordFile)) return passwordFromFile(passwordFile, options);
  return options.promptPassword();
}

export async function loadBaseSepoliaDeployer({
  env = process.env,
  cwd = process.cwd(),
  readFile = fs.readFile,
  stat = fs.stat,
  promptPassword = promptForKeystorePassword,
} = {}) {
  const privateKey = env.BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY;
  const keystorePath = env.BASE_SEPOLIA_DEPLOYER_KEYSTORE_PATH;
  const hasPrivateKey = configured(privateKey);
  const hasKeystore = configured(keystorePath);
  const hasKeystoreOptions = configured(env.BASE_SEPOLIA_DEPLOYER_KEYSTORE_PASSWORD)
    || configured(env.BASE_SEPOLIA_DEPLOYER_KEYSTORE_PASSWORD_FILE);

  if (hasPrivateKey && (hasKeystore || hasKeystoreOptions)) {
    throw new Error(
      'Choose one deployer credential source: BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY '
      + 'or BASE_SEPOLIA_DEPLOYER_KEYSTORE_PATH',
    );
  }

  if (hasPrivateKey) {
    if (!PRIVATE_KEY_PATTERN.test(privateKey)) {
      throw new Error('BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY must be a 32-byte private key');
    }
    return privateKeyToAccount(privateKey);
  }

  if (!hasKeystore) {
    if (hasKeystoreOptions) {
      throw new Error(
        'BASE_SEPOLIA_DEPLOYER_KEYSTORE_PATH is required when keystore password options are set',
      );
    }
    throw new Error(
      'Set BASE_SEPOLIA_DEPLOYER_KEYSTORE_PATH (recommended) '
      + 'or BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY',
    );
  }

  const absolutePath = path.resolve(cwd, keystorePath);
  const file = await stat(absolutePath);
  if (!file.isFile()) throw new Error('BASE_SEPOLIA_DEPLOYER_KEYSTORE_PATH must point to a file');
  if (file.size === 0 || file.size > MAX_KEYSTORE_BYTES) {
    throw new Error('Base Sepolia deployer keystore must be between 1 byte and 1 MiB');
  }

  const keystore = await readFile(absolutePath, 'utf8');
  if (!isKeystoreJson(keystore)) {
    throw new Error('BASE_SEPOLIA_DEPLOYER_KEYSTORE_PATH is not a Web3 Secret Storage JSON keystore');
  }

  const password = await loadPassword(env, { cwd, readFile, promptPassword });
  try {
    if (password.length === 0) throw new Error('The keystore password cannot be empty');
    const decrypted = await decryptKeystoreJson(keystore, password);
    if (!PRIVATE_KEY_PATTERN.test(decrypted.privateKey)) {
      throw new Error('Decrypted keystore did not contain a valid EVM private key');
    }
    return privateKeyToAccount(decrypted.privateKey);
  } catch (error) {
    if (error instanceof Error && (
      error.message === 'The keystore password cannot be empty'
      || error.message === 'Decrypted keystore did not contain a valid EVM private key'
    )) {
      throw error;
    }
    throw new Error('Unable to decrypt Base Sepolia deployer keystore; check the password and file');
  } finally {
    password.fill(0);
  }
}
