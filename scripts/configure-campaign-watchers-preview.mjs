import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import {
  decryptKeystoreJson,
  encryptKeystoreJson,
} from 'ethers';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  parseEther,
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
const BASE_ESCROW = getAddress('0x7e9B6B757d1Ef12509889826B2f2A42906661927');
const BASE_RECEIVER = getAddress('0x15dDbCd98F97065746a1c35f88BB670a7A942264');
const GENLAYER_RESOLVER = getAddress('0x017311b35dbB9802883bDaE7Fb0Efd7Bd77cB0b2');
const DEPLOYER_KEYSTORE = path.join(
  PROJECT_ROOT,
  '.secrets',
  'testnet-deployer',
  'grounding-bradbury.keystore.json',
);
const RELAYER_DIRECTORY = path.join(
  PROJECT_ROOT,
  '.secrets',
  'campaign-settlement-preview',
);
const LEGACY_PLAINTEXT_STATE = path.join(
  PROJECT_ROOT,
  '.secrets',
  'campaign-settlement-preview.json',
);
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const MAX_API_OUTPUT_BYTES = 4 * 1024 * 1024;
const API_TIMEOUT_MS = 45_000;
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

export function watcherEnvironment({ watcher, privateKey, serviceToken }) {
  invariant(PRIVATE_KEY_PATTERN.test(privateKey), 'Watcher private key is invalid');
  invariant(typeof serviceToken === 'string' && Buffer.byteLength(serviceToken) >= 32,
    'Watcher service token is invalid');
  return [
    envEntry('XPROOF_CAMPAIGN_WATCHER_ENABLED', 'false'),
    envEntry('XPROOF_CAMPAIGN_WATCHER_STAGE', 'testnet'),
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
  databaseUrl,
  relayerPrivateKey,
  relayerAddress,
  relayServiceToken,
  watcherOrigins,
  watcherServiceTokens,
}) {
  invariant(typeof databaseUrl === 'string' && /^(?:postgres|postgresql):\/\//.test(databaseUrl),
    'Preview DATABASE_URL is invalid');
  invariant(PRIVATE_KEY_PATTERN.test(relayerPrivateKey), 'Relayer private key is invalid');
  invariant(watcherOrigins.length === 3 && watcherServiceTokens.length === 3,
    'Exactly three watcher endpoints and tokens are required');
  const entries = [
    envEntry('DATABASE_URL', databaseUrl, 'sensitive'),
    envEntry('XPROOF_CAMPAIGN_RELAY_ENABLED', 'false'),
    envEntry('XPROOF_CAMPAIGN_RELAY_STAGE', 'testnet'),
    envEntry('XPROOF_CAMPAIGN_RELAY_BROADCAST_ENABLED', 'false'),
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

export function webEnvironment({ relayOrigin, relayServiceToken }) {
  return [
    envEntry('XPROOF_CAMPAIGN_RELAY_BRIDGE_ENABLED', 'false'),
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
      '--raw',
      '--no-color',
    ];
    let requestBody;
    if (body !== undefined) {
      args.push('--input', '-');
      requestBody = Buffer.from(JSON.stringify(body), 'utf8');
    }
    const output = [];
    let outputBytes = 0;
    try {
      return await new Promise((resolvePromise, rejectPromise) => {
        const child = spawnFn(process.execPath, args, {
          cwd: PROJECT_ROOT,
          env: childEnv,
          shell: false,
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        });
        const timer = setTimeout(() => child.kill(), API_TIMEOUT_MS);
        const rejectSafe = () => rejectPromise(new Error('Vercel rejected the bounded Preview setup request'));
        child.once('error', rejectSafe);
        child.stdout.on('data', (chunk) => {
          const bytes = Buffer.from(chunk);
          outputBytes += bytes.length;
          if (outputBytes > MAX_API_OUTPUT_BYTES) {
            bytes.fill(0);
            child.kill();
            rejectSafe();
            return;
          }
          output.push(bytes);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            rejectSafe();
            return;
          }
          const serialized = Buffer.concat(output, outputBytes);
          try {
            resolvePromise(serialized.length === 0 ? null : JSON.parse(serialized.toString('utf8')));
          } catch {
            rejectSafe();
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
  return Array.isArray(entry?.target) && entry.target.includes('preview') && !entry.gitBranch;
}

async function readPreviewDatabaseUrl(api) {
  const result = await api(`/v10/projects/${WEB_PROJECT.id}/env?decrypt=true`);
  const matches = (result?.envs ?? []).filter(
    (entry) => entry?.key === 'DATABASE_URL' && previewTargets(entry),
  );
  invariant(matches.length === 1 && typeof matches[0].value === 'string',
    'InfluencedX must have exactly one unbranched Preview DATABASE_URL');
  invariant(/^(?:postgres|postgresql):\/\//.test(matches[0].value),
    'InfluencedX Preview DATABASE_URL is invalid');
  return matches[0].value;
}

function uniqueServiceTokens() {
  const values = Array.from({ length: 4 }, () => randomBytes(32).toString('base64url'));
  invariant(new Set(values).size === values.length, 'Service-token generation did not produce unique values');
  return { watcherTokens: values.slice(0, 3), relayToken: values[3] };
}

async function uploadEnvironment(api, projectId, entries) {
  await api(`/v10/projects/${projectId}/env?upsert=true`, {
    method: 'POST',
    body: entries,
  });
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
  invariant(await publicClient.getBalance({ address: relayerAddress }) === 0n,
    'Fresh relayer unexpectedly has a balance; stop for reconciliation');
}

async function fundRelayer({ publicClient, deployer, relayer }) {
  const deployerBalance = await publicClient.getBalance({ address: deployer.address });
  invariant(deployerBalance > RELAYER_TARGET_BALANCE_WEI + parseEther('0.0001'),
    'Base Sepolia deployer balance is too low for bounded relayer funding');
  const walletClient = createWalletClient({
    account: deployer,
    chain: baseSepolia,
    transport: http(BASE_RPC_URL, { timeout: 20_000, retryCount: 2 }),
  });
  const hash = await walletClient.sendTransaction({
    account: deployer,
    to: relayer.address,
    value: RELAYER_TARGET_BALANCE_WEI,
  });
  await fs.writeFile(path.join(RELAYER_DIRECTORY, 'funding-public.json'), `${JSON.stringify({
    schemaVersion: 1,
    chainId: baseSepolia.id,
    from: deployer.address,
    to: relayer.address,
    valueWei: RELAYER_TARGET_BALANCE_WEI.toString(),
    transactionHash: hash,
    submittedAt: new Date().toISOString(),
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout: 120_000,
  });
  invariant(receipt.status === 'success', 'The bounded relayer funding transaction reverted');
  const balance = await publicClient.getBalance({ address: relayer.address });
  invariant(balance >= RELAYER_TARGET_BALANCE_WEI && balance <= RELAYER_MAX_BALANCE_WEI,
    'Relayer balance is outside the configured low-balance policy');
  return hash;
}

async function promptForApply({ input = process.stdin, output = process.stderr } = {}) {
  invariant(input.isTTY && output.isTTY, 'Preview setup requires a real interactive terminal');
  const terminal = readline.createInterface({ input, output });
  try {
    return await terminal.question(`Type ${APPLY_CONFIRMATION} to continue: `);
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
  invariant(argv.length === 1 && argv[0] === '--apply',
    'Refusing to mutate. Run this one-shot ceremony with the exact --apply flag');
  try {
    await fs.access(LEGACY_PLAINTEXT_STATE);
    throw new Error('Legacy plaintext campaign settlement state exists; remove it through a reviewed secret cleanup');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await fs.access(RELAYER_DIRECTORY);
    throw new Error('Preview relayer state already exists; reconcile it instead of rotating keys');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const allProjects = [WEB_PROJECT, RELAY_PROJECT, ...WATCHERS.map((watcher) => ({
    id: watcher.projectId,
    name: watcher.projectName,
    rootDirectory: watcher.rootDirectory,
  }))];
  const projectResults = await Promise.all(allProjects.map((project) => projectPreflight(api, project)));
  const relayOrigin = projectResults[1].previewOrigin;
  const watcherOrigins = projectResults.slice(2).map(({ previewOrigin }) => previewOrigin);
  const [databaseUrl, watcherSecrets, manifest, relayer] = await Promise.all([
    readPreviewDatabaseUrl(api),
    Promise.all(WATCHERS.map(decryptWatcherSecret)),
    fs.readFile(path.join(PROJECT_ROOT, 'deployments', 'base-sepolia.json'), 'utf8').then(JSON.parse),
    createEncryptedRelayerMaterial(),
  ]);
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

  errorOutput.write('InfluencedX automatic settlement Preview setup\n');
  errorOutput.write('All watcher, relay broadcast, and web bridge flags will remain disabled.\n');
  errorOutput.write(`Fresh Base relayer: ${relayer.account.address}\n`);
  errorOutput.write(`Bounded funding: ${RELAYER_TARGET_BALANCE_WEI} wei on Base Sepolia\n`);
  const answer = await confirm();
  invariant(answer === APPLY_CONFIRMATION, 'Preview setup confirmation did not match');

  const deployer = await loadBaseSepoliaDeployer({
    env: { BASE_SEPOLIA_DEPLOYER_KEYSTORE_PATH: DEPLOYER_KEYSTORE },
    cwd: PROJECT_ROOT,
    promptPassword,
  });
  invariant(deployer.address === getAddress(manifest.deployer),
    'Encrypted deployer does not match the Base deployment manifest');

  const tokens = uniqueServiceTokens();
  try {
    await persistRelayerMaterial(relayer);

    // OIDC callers and Deployment Protection rules are configured before secrets.
    await api(`/v9/projects/${WEB_PROJECT.id}`, { method: 'PATCH', body: callerOidcPatch() });
    await api(`/v9/projects/${RELAY_PROJECT.id}`, { method: 'PATCH', body: {
      ...callerOidcPatch(),
      ...trustedSourcesPatch(WEB_PROJECT),
    } });
    for (const watcher of WATCHERS) {
      await api(`/v9/projects/${watcher.projectId}`, {
        method: 'PATCH',
        body: trustedSourcesPatch(RELAY_PROJECT),
      });
    }

    for (const [index, watcher] of WATCHERS.entries()) {
      await uploadEnvironment(api, watcher.projectId, watcherEnvironment({
        watcher,
        privateKey: watcherSecrets[index].privateKey,
        serviceToken: tokens.watcherTokens[index],
      }));
    }
    await uploadEnvironment(api, RELAY_PROJECT.id, relayEnvironment({
      databaseUrl,
      relayerPrivateKey: relayer.privateKey,
      relayerAddress: relayer.account.address,
      relayServiceToken: tokens.relayToken,
      watcherOrigins,
      watcherServiceTokens: tokens.watcherTokens,
    }));
    await uploadEnvironment(api, WEB_PROJECT.id, webEnvironment({
      relayOrigin,
      relayServiceToken: tokens.relayToken,
    }));

    const fundingHash = await fundRelayer({ publicClient, deployer, relayer: relayer.account });
    output.write(`Configured disabled Preview settlement services for relayer ${relayer.account.address}.\n`);
    output.write(`Base Sepolia funding transaction: ${fundingHash}\n`);
    output.write('Redeploy each Preview project, simulate, then enable watchers, relay, broadcast, and web bridge in that order.\n');
    return { relayerAddress: relayer.account.address, fundingHash };
  } finally {
    relayer.password.fill(0);
    for (const watcher of watcherSecrets) watcher.privateKey = undefined;
    relayer.privateKey = undefined;
    tokens.watcherTokens.fill(undefined);
    tokens.relayToken = undefined;
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
