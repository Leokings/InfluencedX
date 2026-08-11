import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { decryptKeystoreJson, encryptKeystoreJson, isKeystoreJson } from 'ethers';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const WATCHER_KEYSTORE_PURPOSE = 'xproof-attestation-watcher';
export const WATCHER_KEYSTORE_SCHEMA_VERSION = 1;
export const WATCHER_KEYSTORE_NETWORK = 'testnet-only';
export const DEFAULT_SCRYPT_PARAMS = Object.freeze({ N: 131_072, r: 8, p: 1 });

const MAX_SECRET_FILE_BYTES = 64 * 1024;
const MIN_PASSWORD_BYTES = 16;
const MAX_PASSWORD_BYTES = 1024;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizePassword(password) {
  const value = Buffer.isBuffer(password) ? Buffer.from(password) : Buffer.from(String(password), 'utf8');
  invariant(value.length >= MIN_PASSWORD_BYTES, `Watcher keystore password must be at least ${MIN_PASSWORD_BYTES} bytes`);
  invariant(value.length <= MAX_PASSWORD_BYTES, `Watcher keystore password must not exceed ${MAX_PASSWORD_BYTES} bytes`);
  invariant(!value.includes(0), 'Watcher keystore password must not contain NUL bytes');
  return value;
}

function normalizeScryptParams(params = DEFAULT_SCRYPT_PARAMS) {
  const normalized = {
    N: Number(params.N),
    r: Number(params.r),
    p: Number(params.p),
  };
  invariant(
    Number.isSafeInteger(normalized.N)
      && normalized.N >= 1_024
      && normalized.N <= 262_144
      && (normalized.N & (normalized.N - 1)) === 0,
    'Watcher keystore scrypt N must be a power of two between 1024 and 262144',
  );
  invariant(Number.isSafeInteger(normalized.r) && normalized.r >= 1 && normalized.r <= 8, 'Invalid watcher keystore scrypt r');
  invariant(Number.isSafeInteger(normalized.p) && normalized.p >= 1 && normalized.p <= 4, 'Invalid watcher keystore scrypt p');
  return normalized;
}

function validatePrivateKey(privateKey) {
  invariant(PRIVATE_KEY_PATTERN.test(privateKey), 'Watcher private key must be 32-byte hex');
  try {
    return privateKeyToAccount(privateKey);
  } catch {
    throw new Error('Watcher private key is not a valid secp256k1 scalar');
  }
}

export function parseWatcherKeystore(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'Invalid watcher keystore');
  const serialized = JSON.stringify(value);
  invariant(isKeystoreJson(serialized), 'Watcher keystore must be Web3 Secret Storage JSON');
  invariant(value.version === 3, 'Watcher keystore must use Web3 Secret Storage version 3');
  invariant(value.xproof?.purpose === WATCHER_KEYSTORE_PURPOSE, 'Keystore is not an XProof watcher key');
  invariant(value.xproof?.schemaVersion === WATCHER_KEYSTORE_SCHEMA_VERSION, 'Unsupported XProof watcher keystore schema');
  invariant(value.xproof?.network === WATCHER_KEYSTORE_NETWORK, 'Watcher keystore is not marked testnet-only');
  invariant(typeof value.address === 'string' && /^[0-9a-fA-F]{40}$/.test(value.address), 'Invalid watcher keystore address');
  getAddress(`0x${value.address}`);
  const crypto = value.Crypto;
  invariant(crypto?.cipher === 'aes-128-ctr', 'Unsupported Web3 watcher keystore cipher');
  invariant(crypto?.kdf === 'scrypt', 'Watcher keystore must use scrypt');
  normalizeScryptParams({
    N: crypto.kdfparams?.n,
    r: crypto.kdfparams?.r,
    p: crypto.kdfparams?.p,
  });
  invariant(crypto.kdfparams?.dklen === 32, 'Watcher keystore scrypt dklen must be 32');
  return structuredClone(value);
}

export async function encryptWatcherPrivateKey({
  privateKey,
  password,
  salt = randomBytes(32),
  iv = randomBytes(16),
  uuid = randomBytes(16),
  kdfParams = DEFAULT_SCRYPT_PARAMS,
}) {
  const account = validatePrivateKey(privateKey);
  invariant(Buffer.isBuffer(salt) && salt.length === 32, 'Watcher keystore salt must be 32 bytes');
  invariant(Buffer.isBuffer(iv) && iv.length === 16, 'Watcher keystore IV must be 16 bytes');
  invariant(Buffer.isBuffer(uuid) && uuid.length === 16, 'Watcher keystore UUID entropy must be 16 bytes');
  const normalizedKdf = normalizeScryptParams(kdfParams);
  const passwordBytes = normalizePassword(password);
  try {
    const serialized = await encryptKeystoreJson(
      { address: account.address, privateKey },
      passwordBytes,
      { salt, iv, uuid, scrypt: normalizedKdf },
    );
    const keystore = JSON.parse(serialized);
    keystore.xproof = {
      purpose: WATCHER_KEYSTORE_PURPOSE,
      schemaVersion: WATCHER_KEYSTORE_SCHEMA_VERSION,
      network: WATCHER_KEYSTORE_NETWORK,
    };
    return parseWatcherKeystore(keystore);
  } finally {
    passwordBytes.fill(0);
  }
}

export async function decryptWatcherAccount({ keystore, password }) {
  const parsed = parseWatcherKeystore(keystore);
  const passwordBytes = normalizePassword(password);
  try {
    const decrypted = await decryptKeystoreJson(JSON.stringify(parsed), passwordBytes);
    invariant(PRIVATE_KEY_PATTERN.test(decrypted.privateKey), 'Invalid decrypted watcher key');
    const account = validatePrivateKey(decrypted.privateKey);
    invariant(account.address === getAddress(`0x${parsed.address}`), 'Watcher keystore address does not match its private key');
    return account;
  } catch {
    throw new Error('Unable to decrypt watcher keystore');
  } finally {
    passwordBytes.fill(0);
  }
}

function generateValidPrivateKey(randomBytesFn) {
  for (let attempt = 0; attempt < 1_024; attempt += 1) {
    const candidate = randomBytesFn(32);
    invariant(Buffer.isBuffer(candidate) && candidate.length === 32, 'Watcher random source must return 32 bytes');
    const privateKey = `0x${candidate.toString('hex')}`;
    candidate.fill(0);
    try {
      validatePrivateKey(privateKey);
      return privateKey;
    } catch {
      // Invalid secp256k1 scalars are exceptionally rare; retry safely.
    }
  }
  throw new Error('Unable to generate a valid watcher private key');
}

export async function createWatcherKeystore({
  password,
  randomBytesFn = randomBytes,
  kdfParams = DEFAULT_SCRYPT_PARAMS,
}) {
  const privateKey = generateValidPrivateKey(randomBytesFn);
  return encryptWatcherPrivateKey({
    privateKey,
    password,
    salt: randomBytesFn(32),
    iv: randomBytesFn(16),
    uuid: randomBytesFn(16),
    kdfParams,
  });
}

export async function createWatcherKeystoreSet({
  passwords,
  randomBytesFn = randomBytes,
  kdfParams = DEFAULT_SCRYPT_PARAMS,
}) {
  invariant(Array.isArray(passwords) && passwords.length === 3, 'Exactly three watcher passwords are required');
  const normalizedPasswords = [];
  try {
    for (const password of passwords) normalizedPasswords.push(normalizePassword(password));
    invariant(
      !normalizedPasswords[0].equals(normalizedPasswords[1])
        && !normalizedPasswords[0].equals(normalizedPasswords[2])
        && !normalizedPasswords[1].equals(normalizedPasswords[2]),
      'Each watcher keystore must use a different password',
    );
    const keystores = [];
    for (const password of normalizedPasswords) {
      keystores.push(await createWatcherKeystore({ password, randomBytesFn, kdfParams }));
    }
    invariant(new Set(keystores.map(({ address }) => address.toLowerCase())).size === 3, 'Generated watcher addresses must be unique');
    return keystores;
  } finally {
    for (const password of normalizedPasswords) password.fill(0);
  }
}

function assertRestrictedFile(filePath, label) {
  const stats = fs.lstatSync(filePath);
  invariant(stats.isFile() && !stats.isSymbolicLink(), `${label} must be a regular file, not a symlink`);
  invariant(stats.size > 0 && stats.size <= MAX_SECRET_FILE_BYTES, `${label} has an invalid size`);
  if (process.platform !== 'win32') {
    invariant((stats.mode & 0o077) === 0, `${label} permissions must be 0600 or stricter`);
  }
}

export function readWatcherPasswordFile(passwordFilePath) {
  const resolved = path.resolve(passwordFilePath);
  assertRestrictedFile(resolved, 'Watcher password file');
  const password = fs.readFileSync(resolved);
  try {
    let end = password.length;
    if (password.at(-1) === 0x0a) end -= password.at(-2) === 0x0d ? 2 : 1;
    return normalizePassword(password.subarray(0, end));
  } finally {
    password.fill(0);
  }
}

export async function loadWatcherAccountFromFiles({ keystorePath, passwordFilePath }) {
  invariant(keystorePath, 'ADPROOF_WATCHER_KEYSTORE_PATH is required');
  invariant(passwordFilePath, 'ADPROOF_WATCHER_KEYSTORE_PASSWORD_FILE is required');
  const resolvedKeystore = path.resolve(keystorePath);
  assertRestrictedFile(resolvedKeystore, 'Watcher keystore');
  let serialized;
  let password;
  try {
    serialized = fs.readFileSync(resolvedKeystore, 'utf8');
    invariant(Buffer.byteLength(serialized, 'utf8') <= MAX_SECRET_FILE_BYTES, 'Watcher keystore is too large');
    password = readWatcherPasswordFile(passwordFilePath);
    return await decryptWatcherAccount({ keystore: JSON.parse(serialized), password });
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Watcher keystore is not valid JSON');
    throw error;
  } finally {
    password?.fill(0);
    serialized = undefined;
  }
}

export function writeWatcherKeystore(filePath, keystore) {
  const resolved = path.resolve(filePath);
  fs.writeFileSync(resolved, `${JSON.stringify(parseWatcherKeystore(keystore), null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return resolved;
}
