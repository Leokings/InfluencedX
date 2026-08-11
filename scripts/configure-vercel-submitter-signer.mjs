import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { computeAddress, decryptKeystoreJson, isKeystoreJson } from 'ethers';

import { promptForKeystorePassword } from './lib/base-deployer-account.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const KEYSTORE_PATH = path.join(
  PROJECT_ROOT,
  '.secrets',
  'testnet-deployer',
  'grounding-bradbury.keystore.json',
);
const EXPECTED_ADDRESS = '0x87e94EDAb4418e8A9eA37c0FAb0675Cf0602A9F2';
const TEAM_SLUG = 'leokings588-5902s-projects';
const SUBMITTER_PROJECT_ID = 'prj_Oinrx2s00FIBUW0kBmIDydGjanyx';
const MAX_KEYSTORE_BYTES = 1024 * 1024;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const stat = await fs.stat(KEYSTORE_PATH);
if (!stat.isFile() || stat.size === 0 || stat.size > MAX_KEYSTORE_BYTES) {
  throw new Error('The encrypted Bradbury keystore is missing or invalid.');
}

const keystore = await fs.readFile(KEYSTORE_PATH, 'utf8');
if (!isKeystoreJson(keystore)) {
  throw new Error('The Bradbury credential is not a Web3 Secret Storage keystore.');
}

process.stderr.write(
  'This uploads the funded Bradbury testnet account to the isolated submitter Preview only.\n',
);
const password = await promptForKeystorePassword();

let decrypted;
try {
  if (password.length === 0) throw new Error('The keystore password cannot be empty.');
  decrypted = await decryptKeystoreJson(keystore, password);
} catch (error) {
  if (error instanceof Error && error.message === 'The keystore password cannot be empty.') {
    throw error;
  }
  throw new Error('Unable to decrypt the Bradbury keystore; check the password.');
} finally {
  password.fill(0);
}

if (!PRIVATE_KEY_PATTERN.test(decrypted.privateKey)) {
  throw new Error('The decrypted keystore did not contain a valid EVM private key.');
}
const address = computeAddress(decrypted.privateKey);
if (address.toLowerCase() !== EXPECTED_ADDRESS.toLowerCase()) {
  throw new Error(`The keystore address is ${address}, not the expected funded testnet account.`);
}

const requestBody = Buffer.from(JSON.stringify({
  key: 'GENLAYER_SUBMITTER_PRIVATE_KEY',
  value: decrypted.privateKey,
  type: 'sensitive',
  target: ['preview'],
}), 'utf8');

try {
  await uploadSensitiveEnvironmentVariable(requestBody);
} finally {
  requestBody.fill(0);
  if (decrypted && typeof decrypted === 'object') {
    try {
      decrypted.privateKey = `0x${'0'.repeat(64)}`;
    } catch {
      // ethers may return an immutable object. The short-lived process exits next.
    }
  }
}

process.stdout.write(`Configured Preview signer address: ${address}\n`);
process.stdout.write('The submitter remains disabled until the reviewed Preview enable step.\n');

async function uploadSensitiveEnvironmentVariable(body) {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error('The Windows application-data path is unavailable.');
  const vercelScript = path.join(appData, 'npm', 'node_modules', 'vercel', 'dist', 'vc.js');
  await fs.access(vercelScript);
  const endpoint = `/v10/projects/${SUBMITTER_PROJECT_ID}/env?upsert=true`;
  const args = [
    vercelScript,
    'api',
    endpoint,
    '-X',
    'POST',
    '--input',
    '-',
    '--scope',
    TEAM_SLUG,
    '--silent',
    '--no-color',
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env: process.env,
      shell: false,
      stdio: ['pipe', 'ignore', 'inherit'],
      windowsHide: false,
    });
    child.once('error', () => reject(new Error('Unable to start the authenticated Vercel CLI.')));
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('Vercel rejected the Preview signer secret upload.'));
    });
    child.stdin.once('error', () => {
      // The exit handler reports a sanitized failure.
    });
    child.stdin.end(body);
  });
}
