import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { decryptKeystoreJson, isKeystoreJson } from 'ethers';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const KEYSTORE_ADDRESS_PATTERN = /^(?:0x)?[0-9a-fA-F]{40}$/;
const MAX_KEYSTORE_BYTES = 1024 * 1024;
const MAX_PASSWORD_BYTES = 4096;

function configured(value) {
  return typeof value === 'string' && value.length > 0;
}

function sameFilePath(left, right) {
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  return normalize(path.resolve(left)) === normalize(path.resolve(right));
}

function validatePassword(password) {
  if (!Buffer.isBuffer(password)) throw new Error('Relayer keystore password must be provided as bytes');
  if (password.length === 0) throw new Error('The relayer keystore password cannot be empty');
  if (password.length > MAX_PASSWORD_BYTES) {
    throw new Error(`The relayer keystore password must not exceed ${MAX_PASSWORD_BYTES} bytes`);
  }
  if (password.includes(0)) throw new Error('The relayer keystore password must not contain NUL bytes');
}

async function passwordFromFile(filePath, { cwd, readFile, stat, keystoreFile }) {
  const absolutePath = path.resolve(cwd, filePath);
  const file = await stat(absolutePath);
  if (!file.isFile()) throw new Error('BASE_RELAYER_KEYSTORE_PASSWORD_FILE must point to a file');
  if (
    Number.isInteger(file.dev)
    && Number.isInteger(file.ino)
    && Number.isInteger(keystoreFile?.dev)
    && Number.isInteger(keystoreFile?.ino)
    && file.dev === keystoreFile.dev
    && file.ino === keystoreFile.ino
  ) {
    throw new Error('Relayer keystore and password file must be different files');
  }
  if (file.size === 0 || file.size > MAX_PASSWORD_BYTES + 2) {
    throw new Error(`Relayer password file must be between 1 and ${MAX_PASSWORD_BYTES + 2} bytes`);
  }
  if (process.platform !== 'win32' && (file.mode & 0o077) !== 0) {
    throw new Error('Relayer password file must not be accessible by group or other users');
  }

  const raw = await readFile(absolutePath);
  if (!Buffer.isBuffer(raw)) throw new Error('Relayer password file could not be read as bytes');
  try {
    let end = raw.length;
    if (end > 0 && raw[end - 1] === 0x0a) end -= 1;
    if (end > 0 && raw[end - 1] === 0x0d) end -= 1;
    const password = Buffer.from(raw.subarray(0, end));
    try {
      validatePassword(password);
      return password;
    } catch (error) {
      password.fill(0);
      throw error;
    }
  } finally {
    raw.fill(0);
  }
}

export async function promptForRelayerKeystorePassword({
  input = process.stdin,
  output = process.stderr,
} = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error(
      'No interactive terminal is available. Set BASE_RELAYER_KEYSTORE_PASSWORD_FILE.',
    );
  }

  output.write('Base Sepolia relayer keystore password: ');
  readline.emitKeypressEvents(input);
  const previousRawMode = Boolean(input.isRaw);
  const chunks = [];
  let byteLength = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      input.off('keypress', onKeypress);
      input.setRawMode(previousRawMode);
      input.pause();
      output.write('\n');
    };

    const clearChunks = () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      byteLength = 0;
    };

    const finish = () => {
      cleanup();
      const password = Buffer.concat(chunks, byteLength);
      clearChunks();
      resolve(password);
    };

    const cancel = (message) => {
      cleanup();
      clearChunks();
      reject(new Error(message));
    };

    function onKeypress(sequence, key = {}) {
      if ((key.ctrl && key.name === 'c') || sequence === '\u0003') {
        cancel('Relayer keystore password prompt cancelled');
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish();
        return;
      }
      if (key.name === 'backspace') {
        const removed = chunks.pop();
        if (removed) {
          byteLength -= removed.length;
          removed.fill(0);
        }
        return;
      }
      if (typeof sequence === 'string' && sequence.length > 0 && !key.ctrl && !key.meta) {
        const chunk = Buffer.from(sequence, 'utf8');
        if (byteLength + chunk.length > MAX_PASSWORD_BYTES) {
          chunk.fill(0);
          cancel(`Relayer keystore password must not exceed ${MAX_PASSWORD_BYTES} bytes`);
          return;
        }
        chunks.push(chunk);
        byteLength += chunk.length;
      }
    }

    input.setRawMode(true);
    input.resume();
    input.on('keypress', onKeypress);
  });
}

export async function loadBaseSepoliaRelayer({
  env = process.env,
  cwd = process.cwd(),
  readFile = fs.readFile,
  stat = fs.stat,
  promptPassword = promptForRelayerKeystorePassword,
} = {}) {
  const privateKey = env.BASE_RELAYER_PRIVATE_KEY;
  const allowRawKey = env.BASE_RELAYER_ALLOW_TEST_ONLY_RAW_KEY;
  const keystorePath = env.BASE_RELAYER_KEYSTORE_PATH;
  const passwordFilePath = env.BASE_RELAYER_KEYSTORE_PASSWORD_FILE;
  const inlinePassword = env.BASE_RELAYER_KEYSTORE_PASSWORD;
  const hasPrivateKey = configured(privateKey);
  const hasRawKeyOption = configured(allowRawKey);
  const hasKeystore = configured(keystorePath);
  const hasPasswordFile = configured(passwordFilePath);
  const hasInlinePassword = configured(inlinePassword);

  if (hasPrivateKey && (hasKeystore || hasPasswordFile || hasInlinePassword)) {
    throw new Error(
      'Choose one relayer credential source: BASE_RELAYER_PRIVATE_KEY or BASE_RELAYER_KEYSTORE_PATH',
    );
  }
  if (hasKeystore && hasRawKeyOption) {
    throw new Error(
      'BASE_RELAYER_ALLOW_TEST_ONLY_RAW_KEY cannot be set with BASE_RELAYER_KEYSTORE_PATH',
    );
  }
  if (hasInlinePassword) {
    throw new Error(
      'BASE_RELAYER_KEYSTORE_PASSWORD is not supported; use a hidden prompt '
      + 'or BASE_RELAYER_KEYSTORE_PASSWORD_FILE',
    );
  }

  if (hasPrivateKey) {
    if (allowRawKey !== 'true') {
      throw new Error(
        'BASE_RELAYER_PRIVATE_KEY is test-only and disabled unless '
        + 'BASE_RELAYER_ALLOW_TEST_ONLY_RAW_KEY=true',
      );
    }
    if (!PRIVATE_KEY_PATTERN.test(privateKey)) {
      throw new Error('BASE_RELAYER_PRIVATE_KEY must be a 32-byte private key');
    }
    return privateKeyToAccount(privateKey);
  }

  if (hasRawKeyOption) {
    throw new Error('BASE_RELAYER_ALLOW_TEST_ONLY_RAW_KEY requires BASE_RELAYER_PRIVATE_KEY');
  }
  if (!hasKeystore) {
    if (hasPasswordFile) {
      throw new Error('BASE_RELAYER_KEYSTORE_PATH is required when a password file is set');
    }
    throw new Error('BASE_RELAYER_KEYSTORE_PATH is required');
  }

  const absoluteKeystorePath = path.resolve(cwd, keystorePath);
  const keystoreFile = await stat(absoluteKeystorePath);
  if (!keystoreFile.isFile()) throw new Error('BASE_RELAYER_KEYSTORE_PATH must point to a file');
  if (keystoreFile.size === 0 || keystoreFile.size > MAX_KEYSTORE_BYTES) {
    throw new Error('Base Sepolia relayer keystore must be between 1 byte and 1 MiB');
  }

  if (hasPasswordFile) {
    const absolutePasswordPath = path.resolve(cwd, passwordFilePath);
    if (sameFilePath(absoluteKeystorePath, absolutePasswordPath)) {
      throw new Error('Relayer keystore and password file must be different files');
    }
  }

  const serialized = await readFile(absoluteKeystorePath, 'utf8');
  if (
    typeof serialized !== 'string'
    || Buffer.byteLength(serialized, 'utf8') === 0
    || Buffer.byteLength(serialized, 'utf8') > MAX_KEYSTORE_BYTES
    || !isKeystoreJson(serialized)
  ) {
    throw new Error('BASE_RELAYER_KEYSTORE_PATH is not a Web3 Secret Storage JSON keystore');
  }

  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('BASE_RELAYER_KEYSTORE_PATH is not valid JSON');
  }
  if (parsed.version !== 3) throw new Error('Relayer keystore must use Web3 Secret Storage version 3');
  if (!KEYSTORE_ADDRESS_PATTERN.test(parsed.address ?? '')) {
    throw new Error('Relayer keystore does not contain a valid EVM address');
  }

  const password = hasPasswordFile
    ? await passwordFromFile(passwordFilePath, { cwd, readFile, stat, keystoreFile })
    : await promptPassword();
  try {
    validatePassword(password);
    const decrypted = await decryptKeystoreJson(serialized, password);
    if (!PRIVATE_KEY_PATTERN.test(decrypted.privateKey)) {
      throw new Error('Decrypted relayer keystore did not contain a valid EVM private key');
    }
    const account = privateKeyToAccount(decrypted.privateKey);
    const declaredAddress = getAddress(`0x${parsed.address.replace(/^0x/i, '')}`);
    if (account.address !== declaredAddress || getAddress(decrypted.address) !== declaredAddress) {
      throw new Error('Relayer keystore address does not match its private key');
    }
    return account;
  } catch (error) {
    if (error instanceof Error && (
      error.message === 'The relayer keystore password cannot be empty'
      || error.message.startsWith('The relayer keystore password must not exceed')
      || error.message === 'The relayer keystore password must not contain NUL bytes'
      || error.message === 'Relayer keystore password must be provided as bytes'
      || error.message === 'Decrypted relayer keystore did not contain a valid EVM private key'
      || error.message === 'Relayer keystore address does not match its private key'
    )) {
      throw error;
    }
    throw new Error('Unable to decrypt Base Sepolia relayer keystore; check the password and file');
  } finally {
    if (Buffer.isBuffer(password)) password.fill(0);
  }
}
