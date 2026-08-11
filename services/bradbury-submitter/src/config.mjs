import {
  BRADBURY_RPC_URL,
  PINNED_BRADBURY_RESOLVER,
  SUBMITTER_NETWORK,
  SUBMITTER_STAGE,
} from './constants.mjs';
import { SubmitterProblem } from './problem.mjs';

export function loadSubmitterConfig(env) {
  const enabled = requiredString(env, 'XPROOF_SUBMITTER_ENABLED');
  const stage = requiredString(env, 'XPROOF_SUBMITTER_STAGE');
  const network = requiredString(env, 'XPROOF_GENLAYER_NETWORK');
  const resolver = requiredString(env, 'XPROOF_GENLAYER_RESOLVER');
  const sharedSecret = requiredString(env, 'XPROOF_SUBMITTER_SHARED_SECRET');
  const privateKey = requiredString(env, 'GENLAYER_SUBMITTER_PRIVATE_KEY');

  if (enabled !== 'true') fail('XPROOF_SUBMITTER_ENABLED must be exactly true.');
  if (stage !== SUBMITTER_STAGE) fail(`XPROOF_SUBMITTER_STAGE must be ${SUBMITTER_STAGE}.`);
  if (network !== SUBMITTER_NETWORK) fail(`XPROOF_GENLAYER_NETWORK must be ${SUBMITTER_NETWORK}.`);
  if (resolver.toLowerCase() !== PINNED_BRADBURY_RESOLVER.toLowerCase()) {
    fail(`XPROOF_GENLAYER_RESOLVER must be the pinned APV2 Bradbury resolver.`);
  }
  if (sharedSecret.length < 32 || sharedSecret.length > 512 || !/^[\x21-\x7e]+$/.test(sharedSecret)) {
    fail('XPROOF_SUBMITTER_SHARED_SECRET must be 32-512 printable ASCII characters.');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey) || /^0x0{64}$/i.test(privateKey)) {
    fail('GENLAYER_SUBMITTER_PRIVATE_KEY must be a non-zero 32-byte private key secret.');
  }

  return Object.freeze({
    enabled: true,
    stage: SUBMITTER_STAGE,
    network: SUBMITTER_NETWORK,
    resolver: PINNED_BRADBURY_RESOLVER,
    rpcUrl: BRADBURY_RPC_URL,
    sharedSecret,
    privateKey,
  });
}

export function publicConfig(config) {
  return Object.freeze({
    enabled: config.enabled,
    stage: config.stage,
    network: config.network,
    resolver: config.resolver,
    rpcUrl: config.rpcUrl,
  });
}

function requiredString(env, name) {
  const value = env?.[name];
  if (typeof value !== 'string' || value.length === 0) fail(`${name} is required.`);
  return value;
}

function fail(message) {
  throw new SubmitterProblem(503, 'SUBMITTER_CONFIGURATION_INVALID', message);
}
