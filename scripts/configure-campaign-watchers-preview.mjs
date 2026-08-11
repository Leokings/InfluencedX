import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import {
  decryptKeystoreJson,
  encryptKeystoreJson,
  isKeystoreJson,
} from 'ethers';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  parseTransaction,
  recoverTransactionAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

import {
  loadBaseSepoliaDeployer,
  promptForKeystorePassword,
} from './lib/base-deployer-account.mjs';
import {
  parseWatcherKeystore,
  readWatcherPasswordFile,
} from '../src/relay/watcher-keystore.mjs';

export const APPLY_CONFIRMATION = 'CONFIGURE INFLUENCEDX SETTLEMENT PREVIEW';
export const RESUME_CONFIRMATION = 'RESUME INFLUENCEDX SETTLEMENT PREVIEW';
export const RELAYER_TARGET_BALANCE_WEI = parseEther('0.001');
export const RELAYER_MAX_BALANCE_WEI = parseEther('0.01');

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const TEAM = Object.freeze({
  id: 'team_2L0T4LCdFsCTFcckeTFWZRvN',
  slug: 'leokings588-5902s-projects',
});
const WEB_PROJECT = Object.freeze({
  id: 'prj_4W0EuXNi5nFD46ArUAbvk2YnTacu',
  name: 'influencedx',
  rootDirectory: null,
});
const RELAY_PROJECT = Object.freeze({
  id: 'prj_bMx328GNrJUIcRx5DwGpIeUEz9Jg',
  name: 'influencedx-campaign-relay',
  rootDirectory: null,
});
export const WATCHERS = Object.freeze([
  Object.freeze({
    projectId: 'prj_48LHg8IekuzQFsNZTwyzJ0mXg73U',
    projectName: 'influencedx-campaign-watcher-1',
    rootDirectory: null,
    address: '0x51a54A0E3Fc06B108175b06bE25bFB253Ec53c40',
    keystore: path.join(PROJECT_ROOT, '.secrets', 'testnet-watchers', 'watcher-1.keystore.json'),
    password: path.join(PROJECT_ROOT, '.secrets', 'testnet-watcher-passwords', 'watcher-1.password'),
  }),
  Object.freeze({
    projectId: 'prj_VzLw4wfvI0b00Uf4gMgNmsYmGpzb',
    projectName: 'influencedx-campaign-watcher-2',
    rootDirectory: null,
    address: '0x8C6b2b9151f004F8a9941a21Aad87bef5B3fCAd1',
    keystore: path.join(PROJECT_ROOT, '.secrets', 'testnet-watchers', 'watcher-2.keystore.json'),
    password: path.join(PROJECT_ROOT, '.secrets', 'testnet-watcher-passwords', 'watcher-2.password'),
  }),
  Object.freeze({
    projectId: 'prj_NslfrBctwLCGOoFIjgEU91PHJHc8',
    projectName: 'influencedx-campaign-watcher-3',
    rootDirectory: null,
    address: '0x08C6D0B23D30bA84978Eba0CcC334a401c77572c',
    keystore: path.join(PROJECT_ROOT, '.secrets', 'testnet-watchers', 'watcher-3.keystore.json'),
    password: path.join(PROJECT_ROOT, '.secrets', 'testnet-watcher-passwords', 'watcher-3.password'),
  }),
]);

const BASE_RPC_URL = 'https://sepolia.base.org';
const GENLAYER_RPC_URL = 'https://rpc-bradbury.genlayer.com';
const WEB_PREVIEW_ORIGIN = 'https://influencedx-preview.vercel.app';
const BASE_ESCROW = getAddress('0x7e9B6B757d1Ef12509889826B2f2A42906661927');
const BASE_RECEIVER = getAddress('0x15dDbCd98F97065746a1c35f88BB670a7A942264');
const GENLAYER_RESOLVER = getAddress('0x017311b35dbB9802883bDaE7Fb0Efd7Bd77cB0b2');
const DEPLOYER_KEYSTORE = path.join(
  PROJECT_ROOT,
  '.secrets',
  'testnet-deployer',
  'grounding-bradbury.keystore.json',
);
const DATABASE_RESOURCE = Object.freeze({
  installationId: 'icfg_xY5RAMOw9rRCNdB6imyY7xL8',
  resourceId: 'store_fo2pE1V3Pt5eUeRc',
});
const DATABASE_CONNECTIONS_ENDPOINT = `/v1/storage/stores/${DATABASE_RESOURCE.resourceId}/connections`;
const WEB_DATABASE_TARGETS = Object.freeze(['production', 'preview', 'development']);
const RELAY_DATABASE_TARGETS = Object.freeze(['preview']);
const RELAYER_DIRECTORY = path.join(
  PROJECT_ROOT,
  '.secrets',
  'campaign-settlement-preview',
);
const FUNDING_INTENT_PATH = path.join(RELAYER_DIRECTORY, 'funding-intent.json');
const FUNDING_PUBLIC_PATH = path.join(RELAYER_DIRECTORY, 'funding-public.json');
const LEGACY_PLAINTEXT_STATE = path.join(
  PROJECT_ROOT,
  '.secrets',
  'campaign-settlement-preview.json',
);
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const MAX_API_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_API_ERROR_BYTES = 64 * 1024;
const API_TIMEOUT_MS = 45_000;
const CONFIG_EPOCH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFETY_FLAG_KEYS = new Set([
  'XPROOF_CAMPAIGN_WATCHER_ENABLED',
  'XPROOF_CAMPAIGN_RELAY_ENABLED',
  'XPROOF_CAMPAIGN_RELAY_BROADCAST_ENABLED',
  'XPROOF_CAMPAIGN_RELAY_BRIDGE_ENABLED',
]);
const SAFE_VERCEL_ERROR_CODES = new Set([
  'BAD_REQUEST',
  'ENV_ALREADY_EXISTS',
  'ENV_CONFLICT',
  'EXISTING_KEY_AND_TARGET',
  'FORBIDDEN',
  'ID_NOT_FOUND',
  'INVALID_KEY',
  'INVALID_VALUE',
  'KEY_INVALID_CHARACTERS',
  'KEY_INVALID_LENGTH',
  'KEY_RESERVED',
  'MAX_ENVS_EXCEEDED',
  'MISSING_ID',
  'MISSING_KEY',
  'MISSING_TARGET',
  'MISSING_VALUE',
  'NOT_AUTHORIZED',
  'NOT_DECRYPTABLE',
  'RESERVED_ENV_VARIABLE',
  'SYSTEM_ENV_WITH_VALUE',
  'TEAM_NOT_FOUND',
  'TOO_MANY_IDS',
  'TOO_MANY_KEYS',
  'UNKNOWN_ERROR',
  'VALUE_INVALID_LENGTH',
  'VALUE_INVALID_TYPE',
]);
const RECEIVER_ABI = parseAbi([
  'function escrow() view returns (address)',
  'function genlayerContract() view returns (bytes32)',
  'function paused() view returns (bool)',
  'function threshold() view returns (uint256)',
  'function watcherCount() view returns (uint256)',
  'function isWatcher(address) view returns (bool)',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function envEntry(key, value, type = 'plain') {
  return Object.freeze({ key, value, type, target: ['preview'] });
}

function assertConfigEpoch(value) {
  invariant(CONFIG_EPOCH_PATTERN.test(value), 'Settlement configuration epoch is invalid');
  return value;
}

export function trustedSourcesPatch(caller) {
  invariant(/^prj_[A-Za-z0-9]+$/.test(caller.id), 'Trusted caller project ID is invalid');
  invariant(/^[a-z0-9-]+$/.test(caller.name), 'Trusted caller project name is invalid');
  return {
    ssoProtection: { deploymentType: 'preview' },
    trustedSources: {
      projects: {
        [caller.id]: {
          label: caller.name,
          customAllow: [{
            from: { slugs: ['preview'] },
            to: { slugs: ['preview'] },
          }],
        },
      },
      oidcProviders: {},
    },
  };
}

export function callerOidcPatch() {
  return { oidcTokenConfig: { enabled: true, issuerMode: 'team' } };
}

export function watcherEnvironment({ watcher, privateKey, serviceToken, configEpoch }) {
  invariant(PRIVATE_KEY_PATTERN.test(privateKey), 'Watcher private key is invalid');
  invariant(typeof serviceToken === 'string' && Buffer.byteLength(serviceToken) >= 32,
    'Watcher service token is invalid');
  return [
    envEntry('XPROOF_CAMPAIGN_WATCHER_ENABLED', 'false'),
    envEntry('XPROOF_CAMPAIGN_WATCHER_STAGE', 'testnet'),
    envEntry('XPROOF_SETTLEMENT_CONFIG_EPOCH', assertConfigEpoch(configEpoch)),
    envEntry('XPROOF_BASE_CHAIN_ID', String(baseSepolia.id)),
    envEntry('XPROOF_BASE_SEPOLIA_RPC_URL', BASE_RPC_URL),
    envEntry('XPROOF_GENLAYER_RPC_URL', GENLAYER_RPC_URL),
    envEntry('XPROOF_BASE_ESCROW', BASE_ESCROW),
    envEntry('XPROOF_BASE_RECEIVER', BASE_RECEIVER),
    envEntry('XPROOF_GENLAYER_RESOLVER', GENLAYER_RESOLVER),
    envEntry('XPROOF_WATCHER_PRIVATE_KEY', privateKey, 'sensitive'),
    envEntry('XPROOF_WATCHER_ADDRESS', getAddress(watcher.address)),
    envEntry('XPROOF_WATCHER_SERVICE_TOKEN', serviceToken, 'sensitive'),
    envEntry('XPROOF_CALLER_TEAM_SLUG', TEAM.slug),
    envEntry('XPROOF_CALLER_TEAM_ID', TEAM.id),
    envEntry('XPROOF_CALLER_PROJECT_NAME', RELAY_PROJECT.name),
    envEntry('XPROOF_CALLER_PROJECT_ID', RELAY_PROJECT.id),
    envEntry('XPROOF_CALLER_ENVIRONMENT', 'preview'),
  ];
}

export function relayEnvironment({
  relayerPrivateKey,
  relayerAddress,
  relayServiceToken,
  watcherOrigins,
  watcherServiceTokens,
  configEpoch,
}) {
  invariant(PRIVATE_KEY_PATTERN.test(relayerPrivateKey), 'Relayer private key is invalid');
  invariant(watcherOrigins.length === 3 && watcherServiceTokens.length === 3,
    'Exactly three watcher endpoints and tokens are required');
  const entries = [
    envEntry('XPROOF_CAMPAIGN_RELAY_ENABLED', 'false'),
    envEntry('XPROOF_CAMPAIGN_RELAY_STAGE', 'testnet'),
    envEntry('XPROOF_CAMPAIGN_RELAY_BROADCAST_ENABLED', 'false'),
    envEntry('XPROOF_SETTLEMENT_CONFIG_EPOCH', assertConfigEpoch(configEpoch)),
    envEntry('XPROOF_BASE_CHAIN_ID', String(baseSepolia.id)),
    envEntry('XPROOF_BASE_SEPOLIA_RPC_URL', BASE_RPC_URL),
    envEntry('XPROOF_GENLAYER_RPC_URL', GENLAYER_RPC_URL),
    envEntry('XPROOF_BASE_ESCROW', BASE_ESCROW),
    envEntry('XPROOF_BASE_RECEIVER', BASE_RECEIVER),
    envEntry('XPROOF_GENLAYER_RESOLVER', GENLAYER_RESOLVER),
    envEntry('XPROOF_BASE_RELAYER_PRIVATE_KEY', relayerPrivateKey, 'sensitive'),
    envEntry('XPROOF_BASE_RELAYER_ADDRESS', getAddress(relayerAddress)),
    envEntry('XPROOF_RELAYER_MAX_BALANCE_WEI', RELAYER_MAX_BALANCE_WEI.toString()),
    envEntry('XPROOF_RELAY_SERVICE_TOKEN', relayServiceToken, 'sensitive'),
    envEntry('XPROOF_CALLER_TEAM_SLUG', TEAM.slug),
    envEntry('XPROOF_CALLER_TEAM_ID', TEAM.id),
    envEntry('XPROOF_CALLER_PROJECT_NAME', WEB_PROJECT.name),
    envEntry('XPROOF_CALLER_PROJECT_ID', WEB_PROJECT.id),
    envEntry('XPROOF_CALLER_ENVIRONMENT', 'preview'),
  ];
  for (let index = 0; index < 3; index += 1) {
    const number = index + 1;
    entries.push(
      envEntry(`XPROOF_WATCHER_${number}_URL`, watcherOrigins[index]),
      envEntry(`XPROOF_WATCHER_${number}_ADDRESS`, getAddress(WATCHERS[index].address)),
      envEntry(`XPROOF_WATCHER_${number}_SERVICE_TOKEN`, watcherServiceTokens[index], 'sensitive'),
    );
  }
  return entries;
}

export function databaseConnectionRequest() {
  return Object.freeze({
    projectId: RELAY_PROJECT.id,
    envVarEnvironments: Object.freeze(['preview']),
    makeEnvVarsSensitive: true,
  });
}

export function webEnvironment({ relayOrigin, relayServiceToken, configEpoch }) {
  return [
    envEntry('XPROOF_CAMPAIGN_RELAY_BRIDGE_ENABLED', 'false'),
    envEntry('XPROOF_SETTLEMENT_CONFIG_EPOCH', assertConfigEpoch(configEpoch)),
    envEntry('XPROOF_APP_ORIGIN', WEB_PREVIEW_ORIGIN),
    envEntry('XPROOF_CAMPAIGN_RELAY_URL', exactHttpsOrigin(relayOrigin)),
    envEntry('XPROOF_CAMPAIGN_RELAY_SERVICE_TOKEN', relayServiceToken, 'sensitive'),
  ];
}

function exactHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('A Vercel Preview service origin is invalid');
  }
  invariant(
    parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && !parsed.port
      && parsed.pathname === '/'
      && !parsed.search
      && !parsed.hash
      && parsed.hostname.endsWith('.vercel.app'),
    'A Vercel Preview service origin is invalid',
  );
  return parsed.origin;
}

export function stablePreviewOriginForDeployment({ project, deployment }) {
  const expectedAlias = `${project.name.toLowerCase()}-preview.vercel.app`;
  invariant(deployment?.projectId === project.id,
    `${project.name} fixed Preview alias points to a different Vercel project`);
  invariant(deployment?.name === project.name,
    `${project.name} fixed Preview alias resolved an unexpected project name`);
  invariant(deployment?.ownerId === TEAM.id,
    `${project.name} fixed Preview alias is owned by a different Vercel team`);
  invariant(deployment?.readyState === 'READY' && deployment?.target !== 'production',
    `${project.name} fixed Preview alias must resolve to a READY non-production deployment`);
  return exactHttpsOrigin(`https://${expectedAlias}`);
}

function minimalChildEnvironment(env) {
  const allowed = [
    'APPDATA',
    'COMSPEC',
    'HOME',
    'LOCALAPPDATA',
    'PATH',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'VERCEL_TOKEN',
    'WINDIR',
  ];
  return Object.fromEntries(allowed.filter((key) => env[key]).map((key) => [key, env[key]]));
}

function normalizedVercelEndpoint(endpoint) {
  return endpoint
    .replace(/prj_[A-Za-z0-9]+/g, ':projectId')
    .replace(/icfg_[A-Za-z0-9]+/g, ':installationId')
    .replace(/store_[A-Za-z0-9]+/g, ':resourceId')
    .replace(/\/env\/[A-Za-z0-9]+/g, '/env/:envId');
}

function safeVercelErrorCode(value) {
  const normalized = typeof value === 'string' ? value.toUpperCase() : '';
  return SAFE_VERCEL_ERROR_CODES.has(normalized) ? normalized : 'UNCLASSIFIED';
}

function safeVercelCodeFromText(value) {
  for (const code of SAFE_VERCEL_ERROR_CODES) {
    if (value.includes(code)) return code;
  }
  return 'UNCLASSIFIED';
}

function safeVercelCodeFromPayload(value) {
  if (!value || typeof value !== 'object') return 'UNCLASSIFIED';
  return safeVercelErrorCode(value.error?.code ?? value.code);
}

function vercelRequestError({ endpoint, method, reason, code = 'UNCLASSIFIED', exitCode }) {
  const exit = Number.isInteger(exitCode) ? `; exit=${exitCode}` : '';
  return new Error(
    `Vercel request failed (${method} ${normalizedVercelEndpoint(endpoint)}; `
    + `reason=${reason}; code=${safeVercelErrorCode(code)}${exit})`,
  );
}

export function createVercelApi({ env = process.env, spawnFn = spawn } = {}) {
  const appData = env.APPDATA;
  invariant(appData, 'Windows APPDATA is unavailable');
  const vercelScript = path.join(appData, 'npm', 'node_modules', 'vercel', 'dist', 'vc.js');
  const childEnv = minimalChildEnvironment(env);
  childEnv.NO_UPDATE_NOTIFIER = '1';

  return async function vercelApi(endpoint, { method = 'GET', body } = {}) {
    invariant(/^\/[A-Za-z0-9?&=_.\-/%]+$/.test(endpoint), 'Vercel API endpoint is invalid');
    const args = [
      vercelScript,
      'api',
      endpoint,
      '-X',
      method,
      '--scope',
      TEAM.slug,
      '--no-color',
    ];
    let requestBody;
    if (body !== undefined) {
      args.push('--input', '-');
      requestBody = Buffer.from(JSON.stringify(body), 'utf8');
    }
    const output = [];
    const errorOutput = [];
    let outputBytes = 0;
    let errorBytes = 0;
    try {
      return await new Promise((resolvePromise, rejectPromise) => {
        let settled = false;
        let timer;
        const child = spawnFn(process.execPath, args, {
          cwd: PROJECT_ROOT,
          env: childEnv,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        const finishReject = (details) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          rejectPromise(vercelRequestError({ endpoint, method, ...details }));
        };
        const finishResolve = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolvePromise(value);
        };
        timer = setTimeout(() => {
          child.kill();
          finishReject({ reason: 'timeout' });
        }, API_TIMEOUT_MS);
        child.once('error', () => finishReject({ reason: 'process-start-failed' }));
        child.stdout.on('data', (chunk) => {
          const bytes = Buffer.from(chunk);
          if (settled) {
            bytes.fill(0);
            return;
          }
          outputBytes += bytes.length;
          if (outputBytes > MAX_API_OUTPUT_BYTES) {
            bytes.fill(0);
            child.kill();
            finishReject({ reason: 'response-too-large' });
            return;
          }
          output.push(bytes);
        });
        child.stderr.on('data', (chunk) => {
          const bytes = Buffer.from(chunk);
          if (settled) {
            bytes.fill(0);
            return;
          }
          errorBytes += bytes.length;
          if (errorBytes > MAX_API_ERROR_BYTES) {
            bytes.fill(0);
            child.kill();
            finishReject({ reason: 'diagnostic-too-large' });
            return;
          }
          errorOutput.push(bytes);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          if (settled) return;
          if (code !== 0) {
            const serializedError = Buffer.concat(errorOutput, errorBytes);
            const serializedOutput = Buffer.concat(output, outputBytes);
            try {
              const diagnostic = `${serializedError.toString('utf8')}\n${serializedOutput.toString('utf8')}`;
              finishReject({
                reason: 'cli-exit',
                code: safeVercelCodeFromText(diagnostic),
                exitCode: code,
              });
            } finally {
              serializedError.fill(0);
              serializedOutput.fill(0);
            }
            return;
          }
          const serialized = Buffer.concat(output, outputBytes);
          try {
            const parsed = serialized.length === 0 ? null : JSON.parse(serialized.toString('utf8'));
            if (parsed?.error) {
              finishReject({
                reason: 'api-error',
                code: safeVercelCodeFromPayload(parsed),
                exitCode: code,
              });
              return;
            }
            finishResolve(parsed);
          } catch {
            finishReject({ reason: 'invalid-json', exitCode: code });
          } finally {
            serialized.fill(0);
          }
        });
        child.stdin.once('error', () => {});
        child.stdin.end(requestBody);
      });
    } finally {
      requestBody?.fill(0);
      for (const chunk of output) chunk.fill(0);
      for (const chunk of errorOutput) chunk.fill(0);
    }
  };
}

async function assertRegularBoundedFile(filePath, label, maxBytes = 1024 * 1024) {
  const stats = await fs.lstat(filePath);
  invariant(stats.isFile() && !stats.isSymbolicLink(), `${label} must be a regular file`);
  invariant(stats.size > 0 && stats.size <= maxBytes, `${label} has an invalid size`);
}

async function decryptWatcherSecret(watcher) {
  await Promise.all([
    assertRegularBoundedFile(watcher.keystore, `${watcher.projectName} keystore`, 64 * 1024),
    assertRegularBoundedFile(watcher.password, `${watcher.projectName} password`, 64 * 1024),
  ]);
  const serialized = await fs.readFile(watcher.keystore, 'utf8');
  let password;
  try {
    const parsed = parseWatcherKeystore(JSON.parse(serialized));
    password = readWatcherPasswordFile(watcher.password);
    const decrypted = await decryptKeystoreJson(JSON.stringify(parsed), password);
    invariant(PRIVATE_KEY_PATTERN.test(decrypted.privateKey), 'Watcher keystore did not decrypt safely');
    invariant(getAddress(decrypted.address) === getAddress(watcher.address),
      `${watcher.projectName} keystore does not match its configured address`);
    invariant(privateKeyToAccount(decrypted.privateKey).address === getAddress(watcher.address),
      `${watcher.projectName} private key does not match its configured address`);
    return { address: getAddress(watcher.address), privateKey: decrypted.privateKey };
  } catch (error) {
    if (error instanceof Error && error.message.includes('does not match')) throw error;
    throw new Error(`${watcher.projectName} encrypted credential could not be verified`);
  } finally {
    password?.fill(0);
  }
}

function generatePrivateKey(randomBytesFn) {
  for (let attempt = 0; attempt < 1024; attempt += 1) {
    const entropy = randomBytesFn(32);
    try {
      invariant(Buffer.isBuffer(entropy) && entropy.length === 32,
        'Relayer entropy source is invalid');
      const privateKey = `0x${entropy.toString('hex')}`;
      privateKeyToAccount(privateKey);
      return privateKey;
    } catch {
      // Invalid secp256k1 scalars are exceptionally rare.
    } finally {
      entropy.fill(0);
    }
  }
  throw new Error('Unable to generate a valid Base relayer key');
}

export async function createEncryptedRelayerMaterial({
  randomBytesFn = randomBytes,
  kdfParams = { N: 131_072, r: 8, p: 1 },
} = {}) {
  const privateKey = generatePrivateKey(randomBytesFn);
  const account = privateKeyToAccount(privateKey);
  const password = randomBytesFn(48);
  invariant(Buffer.isBuffer(password) && password.length === 48,
    'Relayer password entropy source is invalid');
  try {
    const keystore = await encryptKeystoreJson(
      { address: account.address, privateKey },
      password,
      { scrypt: kdfParams },
    );
    const decrypted = await decryptKeystoreJson(keystore, password);
    invariant(privateKeyToAccount(decrypted.privateKey).address === account.address,
      'Generated relayer keystore failed its verification round trip');
    return { account, privateKey, password: Buffer.from(password), keystore };
  } finally {
    password.fill(0);
  }
}

async function restrictWindowsFile(filePath) {
  if (process.platform !== 'win32') {
    await fs.chmod(filePath, 0o600);
    return;
  }
  const user = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\');
  invariant(user, 'The current Windows account could not be identified for secret ACLs');
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('icacls.exe', [filePath, '/inheritance:r', '/grant:r', `${user}:(F)`], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', () => rejectPromise(new Error('Could not restrict a generated secret file')));
    child.once('exit', (code) => code === 0
      ? resolvePromise()
      : rejectPromise(new Error('Could not restrict a generated secret file')));
  });
}

async function persistRelayerMaterial(material) {
  try {
    await fs.access(RELAYER_DIRECTORY);
    throw new Error('The Preview relayer directory already exists; reconcile it instead of rotating keys');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const staging = path.join(
    path.dirname(RELAYER_DIRECTORY),
    `.campaign-settlement-preview.${randomUUID()}.tmp`,
  );
  const keystorePath = path.join(staging, 'base-relayer.keystore.json');
  const passwordPath = path.join(staging, 'base-relayer.password');
  const publicStatePath = path.join(staging, 'public-state.json');
  await fs.mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    await fs.writeFile(keystorePath, material.keystore, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(passwordPath, material.password, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(publicStatePath, `${JSON.stringify({
      schemaVersion: 1,
      network: 'base-sepolia',
      chainId: baseSepolia.id,
      address: material.account.address,
      targetBalanceWei: RELAYER_TARGET_BALANCE_WEI.toString(),
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await Promise.all([
      restrictWindowsFile(keystorePath),
      restrictWindowsFile(passwordPath),
      restrictWindowsFile(publicStatePath),
    ]);
    await fs.rename(staging, RELAYER_DIRECTORY);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function readJsonFile(filePath, label, maxBytes = 64 * 1024) {
  await assertRegularBoundedFile(filePath, label, maxBytes);
  const serialized = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(serialized);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function loadPersistedRelayerMaterial() {
  const keystorePath = path.join(RELAYER_DIRECTORY, 'base-relayer.keystore.json');
  const passwordPath = path.join(RELAYER_DIRECTORY, 'base-relayer.password');
  const publicStatePath = path.join(RELAYER_DIRECTORY, 'public-state.json');
  await Promise.all([
    assertRegularBoundedFile(keystorePath, 'Persisted Preview relayer keystore'),
    assertRegularBoundedFile(passwordPath, 'Persisted Preview relayer password', 4 * 1024),
    assertRegularBoundedFile(publicStatePath, 'Persisted Preview relayer public state', 64 * 1024),
  ]);
  const [serialized, password, publicState] = await Promise.all([
    fs.readFile(keystorePath, 'utf8'),
    fs.readFile(passwordPath),
    readJsonFile(publicStatePath, 'Persisted Preview relayer public state'),
  ]);
  try {
    invariant(isKeystoreJson(serialized), 'Persisted Preview relayer keystore is invalid');
    invariant(Buffer.isBuffer(password) && password.length === 48,
      'Persisted Preview relayer password is invalid');
    invariant(publicState?.schemaVersion === 1
      && publicState?.network === 'base-sepolia'
      && publicState?.chainId === baseSepolia.id
      && publicState?.targetBalanceWei === RELAYER_TARGET_BALANCE_WEI.toString(),
    'Persisted Preview relayer public state does not match this ceremony');
    const decrypted = await decryptKeystoreJson(serialized, password);
    invariant(PRIVATE_KEY_PATTERN.test(decrypted.privateKey),
      'Persisted Preview relayer keystore did not decrypt safely');
    const account = privateKeyToAccount(decrypted.privateKey);
    invariant(account.address === getAddress(publicState.address)
      && getAddress(decrypted.address) === account.address,
    'Persisted Preview relayer identity does not match its public state');
    return { account, privateKey: decrypted.privateKey, password: null, reused: true };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Persisted Preview relayer')) throw error;
    throw new Error('Persisted Preview relayer material could not be verified');
  } finally {
    password.fill(0);
  }
}

async function projectPreflight(api, project) {
  const metadata = await api(`/v9/projects/${project.id}`);
  invariant(metadata?.id === project.id, `${project.name} Vercel project ID changed`);
  invariant(metadata?.name === project.name, `${project.name} Vercel project name changed`);
  invariant(metadata?.accountId === TEAM.id, `${project.name} is owned by a different Vercel team`);
  invariant((metadata?.rootDirectory ?? null) === project.rootDirectory,
    `${project.name} Vercel root directory changed`);
  const fixedAlias = `${project.name.toLowerCase()}-preview.vercel.app`;
  const deployment = await api(`/v13/deployments/${fixedAlias}`);
  const previewOrigin = stablePreviewOriginForDeployment({
    project,
    deployment,
  });
  return { metadata, previewOrigin };
}

function previewTargets(entry) {
  const exactTarget = entry?.target === 'preview'
    || (Array.isArray(entry?.target)
      && entry.target.length === 1
      && entry.target[0] === 'preview');
  return exactTarget
    && !entry.gitBranch
    && (!entry.customEnvironmentIds || entry.customEnvironmentIds.length === 0);
}

function touchesPreview(entry) {
  return entry?.target === 'preview'
    || (Array.isArray(entry?.target) && entry.target.includes('preview'));
}

function previewDatabaseEntries(result) {
  return (result?.envs ?? []).filter(
    (entry) => entry?.key === 'DATABASE_URL' && touchesPreview(entry),
  );
}

function exactStringSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return new Set(actual).size === actual.length
    && expected.every((value) => actual.includes(value));
}

function projectDatabaseConnections(result, project) {
  return (result?.connections ?? []).filter(
    (connection) => connection?.projectId === project.id
      || connection?.project?.id === project.id,
  );
}

export function exactDatabaseBindingMetadata({
  entries,
  connections,
  project,
  expectedTargets,
  expectedType,
}) {
  if (!Array.isArray(entries) || entries.length !== 1
    || !Array.isArray(connections) || connections.length !== 1) return false;
  const [entry] = entries;
  const [connection] = connections;
  const entryTargets = typeof entry?.target === 'string' ? [entry.target] : entry?.target;
  return entry?.key === 'DATABASE_URL'
    && exactStringSet(entryTargets, expectedTargets)
    && !entry.gitBranch
    && (!entry.customEnvironmentIds || entry.customEnvironmentIds.length === 0)
    && entry.type === expectedType
    // Vercel Storage/Marketplace connections are authenticated by the fixed
    // resource endpoint below; their env records do not carry configurationId.
    && entry.configurationId == null
    && connection?.projectId === project.id
    && connection?.project?.id === project.id
    && connection?.project?.name === project.name
    && connection.envVarPrefix == null
    && exactStringSet(connection.envVarEnvironments, expectedTargets);
}

async function assertHostedDatabasePreflight(api) {
  const [webResult, relayResult, connectionResult] = await Promise.all([
    api(`/v10/projects/${WEB_PROJECT.id}/env`),
    api(`/v10/projects/${RELAY_PROJECT.id}/env`),
    api(DATABASE_CONNECTIONS_ENDPOINT),
  ]);
  const webEntries = previewDatabaseEntries(webResult);
  const relayEntries = previewDatabaseEntries(relayResult);
  const webConnections = projectDatabaseConnections(connectionResult, WEB_PROJECT);
  const relayConnections = projectDatabaseConnections(connectionResult, RELAY_PROJECT);
  invariant(exactDatabaseBindingMetadata({
    entries: webEntries,
    connections: webConnections,
    project: WEB_PROJECT,
    expectedTargets: WEB_DATABASE_TARGETS,
    expectedType: 'encrypted',
  }),
    'InfluencedX must have exactly one hosted Preview DATABASE_URL');
  invariant(relayEntries.length === 0 && relayConnections.length === 0,
    'Campaign relay already has a database connection; reconcile instead of reconnecting');
}

async function hostedDatabaseState(api) {
  const [webResult, relayResult, connectionResult] = await Promise.all([
    api(`/v10/projects/${WEB_PROJECT.id}/env`),
    api(`/v10/projects/${RELAY_PROJECT.id}/env`),
    api(DATABASE_CONNECTIONS_ENDPOINT),
  ]);
  const webEntries = previewDatabaseEntries(webResult);
  const relayEntries = previewDatabaseEntries(relayResult);
  const webConnections = projectDatabaseConnections(connectionResult, WEB_PROJECT);
  const relayConnections = projectDatabaseConnections(connectionResult, RELAY_PROJECT);
  invariant(exactDatabaseBindingMetadata({
    entries: webEntries,
    connections: webConnections,
    project: WEB_PROJECT,
    expectedTargets: WEB_DATABASE_TARGETS,
    expectedType: 'encrypted',
  }),
    'InfluencedX must have exactly one xproof-db-backed environment binding that includes Preview');
  invariant(relayEntries.length <= 1 && relayConnections.length <= 1,
    'Campaign relay has multiple or branch-scoped Preview DATABASE_URL variables');
  invariant(relayEntries.length === relayConnections.length,
    'Campaign relay database environment and xproof-db resource binding disagree');
  invariant(relayEntries.length === 0 || exactDatabaseBindingMetadata({
    entries: relayEntries,
    connections: relayConnections,
    project: RELAY_PROJECT,
    expectedTargets: RELAY_DATABASE_TARGETS,
    expectedType: 'sensitive',
  }),
    'Campaign relay Preview DATABASE_URL is not the expected integration-owned sensitive value');
  return { relayConnected: relayEntries.length === 1 };
}

async function waitForRelayDatabaseConnection(api) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await api(`/v10/projects/${RELAY_PROJECT.id}/env`);
    const matches = previewDatabaseEntries(result);
    if (matches.length === 1) return;
    invariant(matches.length === 0,
      'Campaign relay received multiple Preview DATABASE_URL variables');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error('Hosted Neon connection did not reach the campaign relay');
}

async function connectHostedDatabase(api) {
  await api(
    `/v1/integrations/installations/${DATABASE_RESOURCE.installationId}/resources/${DATABASE_RESOURCE.resourceId}/connections`,
    { method: 'POST', body: databaseConnectionRequest() },
  );
  await waitForRelayDatabaseConnection(api);
}

async function ensureHostedDatabase(api) {
  const state = await hostedDatabaseState(api);
  if (!state.relayConnected) await connectHostedDatabase(api);
  const verified = await hostedDatabaseState(api);
  invariant(verified.relayConnected, 'Campaign relay hosted Preview database did not reconcile');
}

function oidcMatches(metadata) {
  return metadata?.oidcTokenConfig?.enabled === true
    && metadata?.oidcTokenConfig?.issuerMode === 'team';
}

function trustedCallerMatches(metadata, caller) {
  const projects = metadata?.trustedSources?.projects;
  const providers = metadata?.trustedSources?.oidcProviders;
  const source = projects?.[caller.id];
  return metadata?.ssoProtection?.deploymentType === 'preview'
    && projects && Object.keys(projects).length === 1
    && (!providers || Object.keys(providers).length === 0)
    && source?.label === caller.name
    && Array.isArray(source?.customAllow)
    && source.customAllow.length === 1
    && source.customAllow.every((entry) => (
      entry?.from?.slugs?.length === 1
      && entry.from.slugs[0] === 'preview'
      && entry?.to?.slugs?.length === 1
      && entry.to.slugs[0] === 'preview'
    ));
}

async function ensureProjectSecurity(api, { project, caller, requireOidc }) {
  let metadata = await api(`/v9/projects/${project.id}`);
  const matches = () => (!requireOidc || oidcMatches(metadata))
    && (!caller || trustedCallerMatches(metadata, caller));
  if (!matches()) {
    const patch = {
      ...(requireOidc ? callerOidcPatch() : {}),
      ...(caller ? trustedSourcesPatch(caller) : {}),
    };
    await api(`/v9/projects/${project.id}`, { method: 'PATCH', body: patch });
    metadata = await api(`/v9/projects/${project.id}`);
  }
  invariant(matches(), `${project.name} Preview workload security did not reconcile`);
}

async function ensureAllProjectSecurity(api) {
  await ensureProjectSecurity(api, { project: WEB_PROJECT, requireOidc: true });
  await ensureProjectSecurity(api, {
    project: RELAY_PROJECT,
    caller: WEB_PROJECT,
    requireOidc: true,
  });
  for (const watcher of WATCHERS) {
    await ensureProjectSecurity(api, {
      project: { id: watcher.projectId, name: watcher.projectName },
      caller: RELAY_PROJECT,
      requireOidc: false,
    });
  }
}

function uniqueServiceTokens() {
  const values = Array.from({ length: 4 }, () => randomBytes(32).toString('base64url'));
  invariant(new Set(values).size === values.length, 'Service-token generation did not produce unique values');
  return { watcherTokens: values.slice(0, 3), relayToken: values[3] };
}

function environmentFailure(project, entry, code) {
  return new Error(
    `Vercel environment upsert failed for ${project.name}.${entry.key} `
    + `(code=${safeVercelErrorCode(code)})`,
  );
}

async function upsertEnvironmentEntry(api, project, entry) {
  const result = await api(`/v10/projects/${project.id}/env?upsert=true`, {
    method: 'POST',
    body: entry,
  });
  const failed = Array.isArray(result?.failed) ? result.failed : [];
  if (failed.length > 0) {
    throw environmentFailure(project, entry, failed[0]?.error?.code);
  }
  const created = Array.isArray(result?.created) ? result.created : [result?.created].filter(Boolean);
  if (created.length !== 1 || created[0]?.key !== entry.key) {
    throw environmentFailure(project, entry, 'UNKNOWN_ERROR');
  }
  invariant(previewTargets(created[0]),
    `Vercel returned an unexpected target for ${project.name}.${entry.key}`);
  invariant(created[0].type === entry.type,
    `Vercel returned an unexpected type for ${project.name}.${entry.key}`);
  if (SAFETY_FLAG_KEYS.has(entry.key)) {
    invariant(created[0].value === 'false',
      `Vercel did not force ${project.name}.${entry.key} to false`);
  }
}

async function verifyProjectEnvironment(api, { project, entries }) {
  const result = await api(`/v10/projects/${project.id}/env`);
  for (const entry of entries) {
    const matches = (result?.envs ?? []).filter(
      (candidate) => candidate?.key === entry.key && touchesPreview(candidate),
    );
    invariant(matches.length === 1,
      `${project.name}.${entry.key} must not have a branch-scoped or mixed Preview override`);
    invariant(previewTargets(matches[0]),
      `${project.name}.${entry.key} must be exact Preview-only and unbranched`);
    invariant(matches[0].type === entry.type,
      `${project.name}.${entry.key} has an unexpected Vercel type`);
    if (SAFETY_FLAG_KEYS.has(entry.key) || entry.key === 'XPROOF_SETTLEMENT_CONFIG_EPOCH') {
      invariant(typeof matches[0].id === 'string' && matches[0].id.length > 0,
        `${project.name}.${entry.key} has no Vercel environment ID`);
      const exact = await api(
        `/v10/projects/${project.id}/env/${matches[0].id}?decrypt=true`,
      );
      invariant(exact?.key === entry.key && exact?.value === entry.value,
        `${project.name}.${entry.key} did not converge to its required value`);
    }
  }
}

export async function applyDisabledEnvironmentPlan(api, batches) {
  invariant(Array.isArray(batches) && batches.length === 5,
    'Settlement environment plan must cover all five Vercel projects');
  for (const { project, entries } of batches) {
    invariant(new Set(entries.map(({ key }) => key)).size === entries.length,
      `${project.name} environment plan contains duplicate keys`);
    for (const entry of entries.filter(({ key }) => SAFETY_FLAG_KEYS.has(key))) {
      invariant(entry.value === 'false', `${project.name}.${entry.key} must remain false`);
      await upsertEnvironmentEntry(api, project, entry);
    }
  }
  // Break any previously common epoch before touching linked secrets. Each
  // project gets a different visible marker, so a partial retry cannot look
  // converged while holding tokens from different attempts.
  for (const { project, entries } of batches) {
    const epochs = entries.filter(({ key }) => key === 'XPROOF_SETTLEMENT_CONFIG_EPOCH');
    invariant(epochs.length === 1, `${project.name} must have exactly one configuration epoch`);
    await upsertEnvironmentEntry(api, project, {
      ...epochs[0],
      value: `pending:${randomUUID()}`,
    });
  }
  for (const { project, entries } of batches) {
    for (const entry of entries.filter(({ key }) => (
      !SAFETY_FLAG_KEYS.has(key) && key !== 'XPROOF_SETTLEMENT_CONFIG_EPOCH'
    ))) {
      await upsertEnvironmentEntry(api, project, entry);
    }
  }
  // The readable epoch is the commit marker. Stamp it only after every linked
  // non-epoch value (including all unreadable token copies) has succeeded.
  for (const { project, entries } of batches) {
    const epochs = entries.filter(({ key }) => key === 'XPROOF_SETTLEMENT_CONFIG_EPOCH');
    await upsertEnvironmentEntry(api, project, epochs[0]);
  }
  for (const batch of batches) await verifyProjectEnvironment(api, batch);
}

async function preflightBase({ publicClient, manifest, watcherSecrets, relayerAddress }) {
  invariant(manifest?.chainId === baseSepolia.id, 'Base deployment manifest is not Base Sepolia');
  invariant(getAddress(manifest.contracts?.escrow?.address) === BASE_ESCROW,
    'Base deployment manifest escrow changed');
  invariant(getAddress(manifest.contracts?.receiver?.address) === BASE_RECEIVER,
    'Base deployment manifest receiver changed');
  invariant(getAddress(manifest.genlayerResolver) === GENLAYER_RESOLVER,
    'Base deployment manifest resolver changed');
  invariant(manifest.threshold === 2, 'Base deployment manifest is not 2-of-3');
  invariant(await publicClient.getChainId() === baseSepolia.id, 'RPC is not Base Sepolia');
  const [escrow, resolver, paused, threshold, watcherCount, ...enabled] = await Promise.all([
    publicClient.readContract({ address: BASE_RECEIVER, abi: RECEIVER_ABI, functionName: 'escrow' }),
    publicClient.readContract({ address: BASE_RECEIVER, abi: RECEIVER_ABI, functionName: 'genlayerContract' }),
    publicClient.readContract({ address: BASE_RECEIVER, abi: RECEIVER_ABI, functionName: 'paused' }),
    publicClient.readContract({ address: BASE_RECEIVER, abi: RECEIVER_ABI, functionName: 'threshold' }),
    publicClient.readContract({ address: BASE_RECEIVER, abi: RECEIVER_ABI, functionName: 'watcherCount' }),
    ...watcherSecrets.map(({ address }) => publicClient.readContract({
      address: BASE_RECEIVER,
      abi: RECEIVER_ABI,
      functionName: 'isWatcher',
      args: [address],
    })),
  ]);
  invariant(getAddress(escrow) === BASE_ESCROW, 'Receiver escrow wiring changed');
  invariant(resolver.toLowerCase().endsWith(GENLAYER_RESOLVER.slice(2).toLowerCase()),
    'Receiver GenLayer resolver wiring changed');
  invariant(paused === false && BigInt(threshold) === 2n && BigInt(watcherCount) >= 3n,
    'Receiver is not an active 2-of-3 configuration');
  invariant(enabled.every(Boolean), 'A configured watcher is not enabled on Base');
  const forbidden = new Set([
    ...watcherSecrets.map(({ address }) => address.toLowerCase()),
    manifest.deployer,
    manifest.initialOwner,
    manifest.finalOwner,
    manifest.treasury,
    manifest.contracts?.registry?.address,
    manifest.contracts?.escrow?.address,
    manifest.contracts?.receiver?.address,
    manifest.genlayerResolver,
  ].filter(Boolean).map((value) => getAddress(value).toLowerCase()));
  invariant(!forbidden.has(getAddress(relayerAddress).toLowerCase()),
    'Fresh relayer collides with a forbidden protocol identity');
}

async function relayerChainState(publicClient, address) {
  const [balance, latestNonce, pendingNonce] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.getTransactionCount({ address, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address, blockTag: 'pending' }),
  ]);
  return { balance, latestNonce, pendingNonce };
}

export async function waitForConfirmedRelayerState(
  publicClient,
  address,
  {
    attempts = 60,
    delayMs = 1_000,
    sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  } = {},
) {
  invariant(Number.isSafeInteger(attempts) && attempts > 0,
    'Relayer state retry count is invalid');
  invariant(Number.isSafeInteger(delayMs) && delayMs >= 0,
    'Relayer state retry delay is invalid');
  let state;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    state = await relayerChainState(publicClient, address);
    invariant(state.latestNonce === 0 && state.pendingNonce === 0,
      'Funded relayer unexpectedly has a latest or pending transaction nonce');
    invariant(state.balance <= RELAYER_MAX_BALANCE_WEI,
      'Preview relayer exceeds its configured low-balance policy');
    if (state.balance >= RELAYER_TARGET_BALANCE_WEI) return state;
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  throw new Error('Confirmed relayer funding is not yet visible on the configured Base RPC; retry recovery');
}

export function assertUnusedRelayerState({ balance, latestNonce, pendingNonce }) {
  invariant(balance === 0n, 'Preview relayer has a balance without reconciled funding');
  invariant(latestNonce === 0 && pendingNonce === 0,
    'Preview relayer has a latest or pending transaction nonce');
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function persistFundingIntent(intent) {
  invariant(!(await pathExists(FUNDING_INTENT_PATH)),
    'A funding intent already exists; reconcile it instead of signing again');
  const staging = `${FUNDING_INTENT_PATH}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(staging, `${JSON.stringify(intent, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await restrictWindowsFile(staging);
    await fs.rename(staging, FUNDING_INTENT_PATH);
  } catch (error) {
    await fs.rm(staging, { force: true }).catch(() => {});
    throw error;
  }
}

async function readOptionalJson(filePath, label, maxBytes = 128 * 1024) {
  return (await pathExists(filePath)) ? readJsonFile(filePath, label, maxBytes) : null;
}

async function validateFundingIntent(intent, { deployerAddress, relayerAddress }) {
  invariant(intent?.schemaVersion === 1
    && intent?.chainId === baseSepolia.id
    && intent?.from === getAddress(deployerAddress)
    && intent?.to === getAddress(relayerAddress)
    && intent?.valueWei === RELAYER_TARGET_BALANCE_WEI.toString()
    && /^0x[0-9a-fA-F]{64}$/.test(intent?.transactionHash ?? '')
    && /^0x[0-9a-fA-F]+$/.test(intent?.serializedTransaction ?? ''),
  'Persisted funding intent is invalid');
  invariant(keccak256(intent.serializedTransaction) === intent.transactionHash,
    'Persisted funding intent hash does not match its signed transaction');
  const transaction = parseTransaction(intent.serializedTransaction);
  invariant(transaction.chainId === baseSepolia.id
    && getAddress(transaction.to) === getAddress(relayerAddress)
    && transaction.value === RELAYER_TARGET_BALANCE_WEI
    && (!transaction.data || transaction.data === '0x'),
  'Persisted funding intent is not the bounded Base Sepolia transfer');
  const signer = await recoverTransactionAddress({
    serializedTransaction: intent.serializedTransaction,
  });
  invariant(getAddress(signer) === getAddress(deployerAddress),
    'Persisted funding intent was not signed by the deployment account');
  return intent;
}

function validateFundingPublic(record, { deployerAddress, relayerAddress }) {
  invariant(record?.schemaVersion === 1
    && record?.chainId === baseSepolia.id
    && record?.from === getAddress(deployerAddress)
    && record?.to === getAddress(relayerAddress)
    && record?.valueWei === RELAYER_TARGET_BALANCE_WEI.toString()
    && /^0x[0-9a-fA-F]{64}$/.test(record?.transactionHash ?? ''),
  'Persisted public funding record is invalid');
  return record;
}

async function transactionOrNull(publicClient, hash) {
  try {
    return await publicClient.getTransaction({ hash });
  } catch (error) {
    if (error?.name === 'TransactionNotFoundError') return null;
    throw new Error('Base funding transaction lookup failed');
  }
}

async function receiptOrNull(publicClient, hash) {
  try {
    return await publicClient.getTransactionReceipt({ hash });
  } catch (error) {
    if (error?.name === 'TransactionReceiptNotFoundError') return null;
    throw new Error('Base funding receipt lookup failed');
  }
}

async function verifyConfirmedFunding({ publicClient, hash, deployerAddress, relayerAddress }) {
  let receipt = await receiptOrNull(publicClient, hash);
  if (!receipt) {
    receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 2,
      timeout: 120_000,
    });
  }
  invariant(receipt.status === 'success', 'The bounded relayer funding transaction reverted');
  let transaction = null;
  for (let attempt = 0; attempt < 10 && !transaction; attempt += 1) {
    transaction = await transactionOrNull(publicClient, hash);
    if (!transaction) await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  invariant(transaction
    && getAddress(transaction.from) === getAddress(deployerAddress)
    && getAddress(transaction.to) === getAddress(relayerAddress)
    && transaction.value === RELAYER_TARGET_BALANCE_WEI,
  'The funding hash does not identify the bounded relayer transfer');
  await waitForConfirmedRelayerState(publicClient, relayerAddress);
}

async function writeFundingPublic({ deployerAddress, relayerAddress, hash }) {
  if (await pathExists(FUNDING_PUBLIC_PATH)) return;
  await fs.writeFile(FUNDING_PUBLIC_PATH, `${JSON.stringify({
    schemaVersion: 1,
    chainId: baseSepolia.id,
    from: deployerAddress,
    to: relayerAddress,
    valueWei: RELAYER_TARGET_BALANCE_WEI.toString(),
    transactionHash: hash,
    confirmedAt: new Date().toISOString(),
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await restrictWindowsFile(FUNDING_PUBLIC_PATH);
}

async function reconcileExistingFunding({ publicClient, deployerAddress, relayerAddress }) {
  const [intentValue, publicValue] = await Promise.all([
    readOptionalJson(FUNDING_INTENT_PATH, 'Persisted funding intent'),
    readOptionalJson(FUNDING_PUBLIC_PATH, 'Persisted public funding record'),
  ]);
  if (!intentValue && !publicValue) {
    assertUnusedRelayerState(await relayerChainState(publicClient, relayerAddress));
    return null;
  }
  const publicRecord = publicValue
    ? validateFundingPublic(publicValue, { deployerAddress, relayerAddress })
    : null;
  const intent = intentValue
    ? await validateFundingIntent(intentValue, { deployerAddress, relayerAddress })
    : null;
  const hash = intent?.transactionHash ?? publicRecord.transactionHash;
  invariant(!publicRecord || publicRecord.transactionHash === hash,
    'Funding intent and public record identify different transactions');
  const transaction = await transactionOrNull(publicClient, hash);
  const receipt = await receiptOrNull(publicClient, hash);
  if (!transaction && !receipt) {
    invariant(intent, 'A legacy funding record has no transaction to reconcile');
    assertUnusedRelayerState(await relayerChainState(publicClient, relayerAddress));
    const broadcastHash = await publicClient.sendRawTransaction({
      serializedTransaction: intent.serializedTransaction,
    });
    invariant(broadcastHash === hash, 'Replayed funding intent returned a different hash');
  }
  await verifyConfirmedFunding({ publicClient, hash, deployerAddress, relayerAddress });
  await writeFundingPublic({ deployerAddress, relayerAddress, hash });
  return hash;
}

async function fundRelayer({ publicClient, deployer, relayer }) {
  invariant(!(await pathExists(FUNDING_INTENT_PATH)) && !(await pathExists(FUNDING_PUBLIC_PATH)),
    'Funding state exists; reconcile it instead of signing again');
  assertUnusedRelayerState(await relayerChainState(publicClient, relayer.address));
  const deployerBalance = await publicClient.getBalance({ address: deployer.address });
  invariant(deployerBalance > RELAYER_TARGET_BALANCE_WEI + parseEther('0.0001'),
    'Base Sepolia deployer balance is too low for bounded relayer funding');
  const walletClient = createWalletClient({
    account: deployer,
    chain: baseSepolia,
    transport: http(BASE_RPC_URL, { timeout: 20_000, retryCount: 2 }),
  });
  const request = await walletClient.prepareTransactionRequest({
    account: deployer,
    to: relayer.address,
    value: RELAYER_TARGET_BALANCE_WEI,
  });
  const serializedTransaction = await walletClient.signTransaction(request);
  const hash = keccak256(serializedTransaction);
  await persistFundingIntent({
    schemaVersion: 1,
    chainId: baseSepolia.id,
    from: deployer.address,
    to: relayer.address,
    valueWei: RELAYER_TARGET_BALANCE_WEI.toString(),
    transactionHash: hash,
    serializedTransaction,
    signedAt: new Date().toISOString(),
  });
  assertUnusedRelayerState(await relayerChainState(publicClient, relayer.address));
  const broadcastHash = await publicClient.sendRawTransaction({ serializedTransaction });
  invariant(broadcastHash === hash, 'Bounded funding broadcast returned a different hash');
  await verifyConfirmedFunding({
    publicClient,
    hash,
    deployerAddress: deployer.address,
    relayerAddress: relayer.address,
  });
  await writeFundingPublic({ deployerAddress: deployer.address, relayerAddress: relayer.address, hash });
  return hash;
}

export function previewSetupMode(argv) {
  if (argv.length === 1 && argv[0] === '--apply') return 'fresh';
  if (argv.length === 2 && argv[0] === '--resume' && argv[1] === '--apply') return 'resume';
  throw new Error(
    'Refusing to mutate. Use --apply for a new ceremony or --resume --apply for persisted recovery',
  );
}

async function promptForApply({
  expected = APPLY_CONFIRMATION,
  input = process.stdin,
  output = process.stderr,
} = {}) {
  invariant(input.isTTY && output.isTTY, 'Preview setup requires a real interactive terminal');
  const terminal = readline.createInterface({ input, output });
  try {
    return await terminal.question(`Type ${expected} to continue: `);
  } finally {
    terminal.close();
  }
}

export async function runPreviewSetup({
  argv = process.argv.slice(2),
  output = process.stdout,
  errorOutput = process.stderr,
  api = createVercelApi(),
  confirm = promptForApply,
  promptPassword = promptForKeystorePassword,
} = {}) {
  const mode = previewSetupMode(argv);
  try {
    await fs.access(LEGACY_PLAINTEXT_STATE);
    throw new Error('Legacy plaintext campaign settlement state exists; remove it through a reviewed secret cleanup');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const relayerStateExists = await pathExists(RELAYER_DIRECTORY);
  invariant(mode === 'resume' ? relayerStateExists : !relayerStateExists,
    mode === 'resume'
      ? 'Preview relayer state is missing; recovery cannot invent a replacement wallet'
      : 'Preview relayer state already exists; run the exact --resume --apply recovery');

  const allProjects = [WEB_PROJECT, RELAY_PROJECT, ...WATCHERS.map((watcher) => ({
    id: watcher.projectId,
    name: watcher.projectName,
    rootDirectory: watcher.rootDirectory,
  }))];
  const projectResults = await Promise.all(allProjects.map((project) => projectPreflight(api, project)));
  const relayOrigin = projectResults[1].previewOrigin;
  const watcherOrigins = projectResults.slice(2).map(({ previewOrigin }) => previewOrigin);
  const [, watcherSecrets, manifest, relayer] = await Promise.all([
    mode === 'fresh' ? assertHostedDatabasePreflight(api) : hostedDatabaseState(api),
    Promise.all(WATCHERS.map(decryptWatcherSecret)),
    fs.readFile(path.join(PROJECT_ROOT, 'deployments', 'base-sepolia.json'), 'utf8').then(JSON.parse),
    mode === 'fresh' ? createEncryptedRelayerMaterial() : loadPersistedRelayerMaterial(),
  ]);
  let tokens;
  try {
    invariant(new Set(watcherSecrets.map(({ address }) => address.toLowerCase())).size === 3,
      'Watcher identities must be unique');
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(BASE_RPC_URL, { timeout: 20_000, retryCount: 2 }),
    });
    await preflightBase({
      publicClient,
      manifest,
      watcherSecrets,
      relayerAddress: relayer.account.address,
    });
    const initialRelayerState = await relayerChainState(publicClient, relayer.account.address);
    invariant(initialRelayerState.latestNonce === 0 && initialRelayerState.pendingNonce === 0,
      'Preview relayer has a latest or pending transaction nonce');
    invariant(initialRelayerState.balance <= RELAYER_MAX_BALANCE_WEI,
      'Preview relayer exceeds its configured low-balance policy');
    if (mode === 'fresh') assertUnusedRelayerState(initialRelayerState);

    errorOutput.write(`InfluencedX automatic settlement Preview ${mode === 'resume' ? 'recovery' : 'setup'}\n`);
    errorOutput.write('All watcher, relay broadcast, and web bridge flags will remain disabled.\n');
    errorOutput.write(`${mode === 'resume' ? 'Reusing' : 'Fresh'} Base relayer: ${relayer.account.address}\n`);
    errorOutput.write(`Bounded funding: ${RELAYER_TARGET_BALANCE_WEI} wei on Base Sepolia\n`);
    const expectedConfirmation = mode === 'resume' ? RESUME_CONFIRMATION : APPLY_CONFIRMATION;
    const answer = await confirm({ expected: expectedConfirmation });
    invariant(answer === expectedConfirmation, 'Preview setup confirmation did not match');

    tokens = uniqueServiceTokens();
    const configEpoch = randomUUID();
    if (mode === 'fresh') await persistRelayerMaterial(relayer);

    // Vercel injects the Preview database credential directly into the relay.
    // It is never decrypted, copied through stdout, or persisted by this setup.
    errorOutput.write('Checking the hosted database binding...\n');
    await ensureHostedDatabase(api);
    errorOutput.write('Hosted database binding verified.\n');
    errorOutput.write('Checking Vercel project security...\n');
    await ensureAllProjectSecurity(api);
    errorOutput.write('Vercel project security verified.\n');

    const batches = WATCHERS.map((watcher, index) => ({
      project: { id: watcher.projectId, name: watcher.projectName },
      entries: watcherEnvironment({
        watcher,
        privateKey: watcherSecrets[index].privateKey,
        serviceToken: tokens.watcherTokens[index],
        configEpoch,
      }),
    }));
    batches.push({
      project: RELAY_PROJECT,
      entries: relayEnvironment({
        relayerPrivateKey: relayer.privateKey,
        relayerAddress: relayer.account.address,
        relayServiceToken: tokens.relayToken,
        watcherOrigins,
        watcherServiceTokens: tokens.watcherTokens,
        configEpoch,
      }),
    }, {
      project: WEB_PROJECT,
      entries: webEnvironment({ relayOrigin, relayServiceToken: tokens.relayToken, configEpoch }),
    });
    errorOutput.write('Writing the disabled hosted settlement configuration...\n');
    await applyDisabledEnvironmentPlan(api, batches);
    errorOutput.write('Disabled hosted settlement configuration verified.\n');

    let fundingHash = await reconcileExistingFunding({
      publicClient,
      deployerAddress: getAddress(manifest.deployer),
      relayerAddress: relayer.account.address,
    });
    if (!fundingHash) {
      // The deployer password is requested only after every hosted credential and false flag verifies.
      errorOutput.write('Hosted checks completed. Deployer password input is ready.\n');
      const deployer = await loadBaseSepoliaDeployer({
        env: { BASE_SEPOLIA_DEPLOYER_KEYSTORE_PATH: DEPLOYER_KEYSTORE },
        cwd: PROJECT_ROOT,
        promptPassword,
      });
      invariant(deployer.address === getAddress(manifest.deployer),
        'Encrypted deployer does not match the Base deployment manifest');
      fundingHash = await fundRelayer({ publicClient, deployer, relayer: relayer.account });
    }
    output.write(`Configured disabled Preview settlement services for relayer ${relayer.account.address}.\n`);
    output.write(`Settlement configuration epoch: ${configEpoch}\n`);
    output.write(`Base Sepolia funding transaction: ${fundingHash}\n`);
    output.write('Redeploy each Preview project, simulate, then enable watchers, relay, broadcast, and web bridge in that order.\n');
    return { relayerAddress: relayer.account.address, fundingHash };
  } finally {
    relayer.password?.fill(0);
    for (const watcher of watcherSecrets) watcher.privateKey = undefined;
    relayer.privateKey = undefined;
    tokens?.watcherTokens.fill(undefined);
    if (tokens) tokens.relayToken = undefined;
  }
}

async function main() {
  await runPreviewSetup();
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Preview setup stopped safely: ${error instanceof Error ? error.message : 'unknown failure'}\n`);
    process.exitCode = 1;
  });
}
