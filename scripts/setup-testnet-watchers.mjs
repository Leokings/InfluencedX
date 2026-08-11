import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAddress } from 'viem';

import {
  createWatcherKeystoreSet,
  readWatcherPasswordFile,
  writeWatcherKeystore,
} from '../src/relay/watcher-keystore.mjs';

function valuesFor(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== `--${name}`) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    values.push(value);
    index += 1;
  }
  return values;
}

function singleValue(name, fallback) {
  const values = valuesFor(name);
  if (values.length > 1) throw new Error(`--${name} may only be supplied once`);
  return values[0] ?? fallback;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.resolve(singleValue('output-dir', path.join(packageRoot, '.secrets', 'testnet-watchers')));
const passwordFiles = valuesFor('password-file').map((value) => path.resolve(value));
const packageSecretsDir = path.join(packageRoot, '.secrets');

if (passwordFiles.length !== 3) {
  throw new Error('Supply exactly three distinct --password-file arguments, one for each watcher');
}
if (new Set(passwordFiles.map((value) => value.toLowerCase())).size !== 3) {
  throw new Error('Each watcher must use a different password file');
}
if (passwordFiles.some((value) => isInside(outputDir, value))) {
  throw new Error('Password files must be stored separately from the generated keystores');
}
if (isInside(packageRoot, outputDir) && !isInside(packageSecretsDir, outputDir)) {
  throw new Error('Watcher output inside this checkout must stay under the gitignored adproof/.secrets directory');
}
if (fs.existsSync(outputDir)) {
  throw new Error(`Refusing to overwrite existing watcher directory: ${outputDir}`);
}

const parentDir = path.dirname(outputDir);
fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
const stagingDir = path.join(parentDir, `.${path.basename(outputDir)}.${randomUUID()}.tmp`);
const passwords = [];

try {
  for (const passwordFile of passwordFiles) passwords.push(readWatcherPasswordFile(passwordFile));
  const keystores = await createWatcherKeystoreSet({ passwords });
  fs.mkdirSync(stagingDir, { mode: 0o700 });
  for (const [index, keystore] of keystores.entries()) {
    writeWatcherKeystore(path.join(stagingDir, `watcher-${index + 1}.keystore.json`), keystore);
  }
  fs.renameSync(stagingDir, outputDir);
  console.log(JSON.stringify({
    threshold: 2,
    addresses: keystores.map(({ address }) => getAddress(`0x${address}`)),
  }));
} catch (error) {
  if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
  throw error;
} finally {
  for (const password of passwords) password.fill(0);
}
