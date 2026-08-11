import { spawn } from 'node:child_process';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_VERCEL_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_BROKER_RESPONSE_BYTES = 8 * 1024;
const VERCEL_API_TIMEOUT_MS = 30_000;
const BROKER_TIMEOUT_MS = 30_000;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function bindingLabel(binding, keyFingerprint) {
  return [
    'xproof:ownership-authorization:v1',
    binding.requestId,
    binding.genlayerTxHash,
    binding.resolver.toLowerCase(),
    binding.baseReceiver.toLowerCase(),
    binding.baseRegistry.toLowerCase(),
    binding.expectedWallet.toLowerCase(),
    keyFingerprint,
  ].join('|');
}

export function ownershipAuthorizationPublicKeyFingerprint(jwk) {
  invariant(
    jwk?.kty === 'RSA'
      && jwk.alg === 'RSA-OAEP-256'
      && jwk.e === 'AQAB'
      && jwk.ext === true
      && Array.isArray(jwk.key_ops)
      && jwk.key_ops.length === 1
      && jwk.key_ops[0] === 'encrypt'
      && typeof jwk.n === 'string',
    'The ephemeral authorization public key is invalid',
  );
  return sha256Hex(['xproof:ownership-authorization-key:v1', jwk.n, jwk.e].join('|'));
}

export async function createOwnershipAuthorizationMaterial({
  binding,
  nowMs,
  ttlMs,
  randomBytesFn = randomBytes,
  subtle = webcrypto.subtle,
} = {}) {
  invariant(Number.isSafeInteger(nowMs) && nowMs > 0, 'Authorization creation time is invalid');
  invariant(Number.isSafeInteger(ttlMs) && ttlMs > 0 && ttlMs <= 15 * 60 * 1_000,
    'Authorization grant TTL must not exceed 15 minutes');
  const tokenBytes = randomBytesFn(32);
  invariant(Buffer.isBuffer(tokenBytes) && tokenBytes.length === 32,
    'Authorization token entropy must be 32 bytes');
  let token;
  try {
    token = tokenBytes.toString('base64url');
  } finally {
    tokenBytes.fill(0);
  }
  invariant(token.length === 43, 'Authorization token encoding is invalid');

  const keys = await subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2_048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    false,
    ['encrypt', 'decrypt'],
  );
  const publicJwk = await subtle.exportKey('jwk', keys.publicKey);
  const keyFingerprint = ownershipAuthorizationPublicKeyFingerprint(publicJwk);
  const createdAt = nowMs;
  const expiresAt = nowMs + ttlMs;
  return {
    token,
    privateKey: keys.privateKey,
    publicJwk,
    keyFingerprint,
    grant: Object.freeze({
      tokenHash: sha256Hex(token),
      requestId: binding.requestId,
      genlayerTxHash: binding.genlayerTxHash,
      resolverAddress: binding.resolver,
      baseReceiverAddress: binding.baseReceiver,
      baseRegistryAddress: binding.baseRegistry,
      expectedWallet: binding.expectedWallet,
      expiresAt,
      createdAt,
    }),
  };
}

export async function decryptOwnershipAuthorization({
  ciphertext,
  privateKey,
  publicJwk,
  binding,
  subtle = webcrypto.subtle,
}) {
  invariant(typeof ciphertext === 'string' && /^[A-Za-z0-9_-]{342,683}$/.test(ciphertext),
    'The broker ciphertext is invalid');
  const encrypted = Buffer.from(ciphertext, 'base64url');
  invariant(encrypted.length >= 256 && encrypted.length <= 512,
    'The broker ciphertext length is invalid');
  const fingerprint = ownershipAuthorizationPublicKeyFingerprint(publicJwk);
  const label = Buffer.from(bindingLabel(binding, fingerprint), 'utf8');
  let decrypted;
  try {
    decrypted = new Uint8Array(await subtle.decrypt(
      { name: 'RSA-OAEP', label },
      privateKey,
      encrypted,
    ));
    invariant(decrypted.length >= 64 && decrypted.length <= 512,
      'The decrypted creator authorization length is invalid');
    return `0x${Buffer.from(decrypted).toString('hex')}`;
  } catch {
    throw new Error('The encrypted ownership authorization could not be opened');
  } finally {
    encrypted.fill(0);
    label.fill(0);
    decrypted?.fill(0);
  }
}

function sanitizedChildEnvironment(environment) {
  const keep = [
    'APPDATA',
    'COMSPEC',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'PATH',
    'PATHEXT',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'WINDIR',
  ];
  return Object.fromEntries(keep.flatMap((name) => (
    typeof environment[name] === 'string' ? [[name, environment[name]]] : []
  )));
}

export async function defaultRunVercelApi({ endpoint, teamSlug, environment = process.env }) {
  invariant(/^\/[A-Za-z0-9_?&=.%/-]+$/.test(endpoint), 'Invalid Vercel API endpoint');
  invariant(/^[A-Za-z0-9-]+$/.test(teamSlug), 'Invalid Vercel team slug');
  const appData = environment.APPDATA;
  invariant(typeof appData === 'string' && appData.length > 0,
    'The Windows application-data path is unavailable');
  const vercelScript = path.join(appData, 'npm', 'node_modules', 'vercel', 'dist', 'vc.js');
  await fs.access(vercelScript);
  const args = [
    vercelScript,
    'api',
    endpoint,
    '--raw',
    '--scope',
    teamSlug,
    '--no-color',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizedChildEnvironment(environment),
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, VERCEL_API_TIMEOUT_MS);
    timer.unref?.();
    const collect = (target, chunk, current, maximum) => {
      const next = current + chunk.length;
      if (next > maximum) {
        child.kill('SIGKILL');
        return current;
      }
      target.push(Buffer.from(chunk));
      return next;
    };
    child.stdout.on('data', (chunk) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes, MAX_VERCEL_RESPONSE_BYTES);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes = collect(stderr, chunk, stderrBytes, 64 * 1024);
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Unable to start the authenticated Vercel API client'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout, stdoutBytes);
      for (const chunk of stdout) chunk.fill(0);
      for (const chunk of stderr) chunk.fill(0);
      try {
        if (timedOut) throw new Error('The authenticated Vercel API request timed out');
        if (code !== 0 || output.length === 0 || stdoutBytes > MAX_VERCEL_RESPONSE_BYTES) {
          throw new Error('The authenticated Vercel API request failed');
        }
        const value = JSON.parse(output.toString('utf8'));
        resolve(value);
      } catch (error) {
        reject(error instanceof SyntaxError
          ? new Error('The authenticated Vercel API response was invalid')
          : error);
      } finally {
        output.fill(0);
      }
    });
  });
}

export async function acquirePreviewAutomationBypass({
  previewUrl,
  projectId,
  teamSlug,
  runVercelApi = defaultRunVercelApi,
}) {
  const project = await runVercelApi({
    endpoint: `/v9/projects/${projectId}`,
    teamSlug,
  });
  invariant(project?.id === projectId, 'The Vercel project binding does not match InfluencedX');
  const hostname = new URL(previewUrl).hostname;
  const latestDeployments = Array.isArray(project.latestDeployments) ? project.latestDeployments : [];
  const deployment = latestDeployments.find((candidate) => (
    candidate?.url === hostname
      || (Array.isArray(candidate?.alias) && candidate.alias.includes(hostname))
      || (Array.isArray(candidate?.aliases) && candidate.aliases.includes(hostname))
  ));
  invariant(deployment, 'The supplied URL is not a latest deployment of the InfluencedX Vercel project');
  invariant(deployment.readyState === 'READY', 'The supplied InfluencedX Preview deployment is not READY');
  invariant(deployment.target !== 'production', 'Production deployments cannot be used by this operator');

  const protectionBypass = project.protectionBypass;
  invariant(protectionBypass && typeof protectionBypass === 'object' && !Array.isArray(protectionBypass),
    'The InfluencedX project has no automation bypass configuration');
  const bypass = Object.keys(protectionBypass).find((key) => (
    protectionBypass[key]?.scope === 'automation-bypass'
  ));
  invariant(typeof bypass === 'string' && bypass.length >= 16,
    'The InfluencedX project has no automation bypass secret');
  return bypass;
}

export async function requestOwnershipAuthorizationCiphertext({
  previewUrl,
  brokerPath,
  projectId,
  teamSlug,
  binding,
  token,
  publicJwk,
  acquireBypass = acquirePreviewAutomationBypass,
  fetchFn = fetch,
}) {
  let bypass;
  let body;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BROKER_TIMEOUT_MS);
  timer.unref?.();
  try {
    bypass = await acquireBypass({ previewUrl, projectId, teamSlug });
    body = Buffer.from(JSON.stringify({
      token,
      requestId: binding.requestId,
      genlayerTxHash: binding.genlayerTxHash,
      resolver: binding.resolver,
      baseReceiver: binding.baseReceiver,
      baseRegistry: binding.baseRegistry,
      expectedWallet: binding.expectedWallet,
      ephemeralPublicKey: publicJwk,
    }), 'utf8');
    const response = await fetchFn(new URL(brokerPath, previewUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vercel-protection-bypass': bypass,
      },
      body,
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    try {
      invariant(bytes.length <= MAX_BROKER_RESPONSE_BYTES,
        'The authorization broker response was too large');
      if (response.status !== 200) {
        throw new Error(`The authorization broker rejected the one-time grant (${response.status})`);
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
      } catch {
        throw new Error('The authorization broker response was invalid');
      }
      invariant(
        parsed
          && typeof parsed === 'object'
          && !Array.isArray(parsed)
          && Object.keys(parsed).length === 1
          && typeof parsed.ciphertext === 'string',
        'The authorization broker response was invalid',
      );
      return parsed.ciphertext;
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    if (error instanceof Error && (
      error.message.startsWith('The authorization broker')
      || error.message.startsWith('The InfluencedX project')
      || error.message.startsWith('The supplied')
      || error.message.startsWith('Production')
      || error.message.startsWith('The Vercel project')
    )) throw error;
    throw new Error('The Preview authorization broker request failed');
  } finally {
    clearTimeout(timer);
    body?.fill(0);
    bypass = undefined;
  }
}
