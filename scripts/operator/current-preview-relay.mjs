import path from 'node:path';

import { getAddress } from 'viem';

export const ADPROOF_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * This operator is deliberately pinned to one reviewed Base Sepolia ceremony.
 * Reusing it for another proof requires a code change and review; there are no
 * command-line overrides for proof, contract, wallet, watcher, or relayer data.
 */
export const CURRENT_PREVIEW_RELAY = Object.freeze({
  schemaVersion: 1,
  environment: 'preview',
  chainId: 84_532,
  rpcUrl: 'https://sepolia.base.org',
  requestId: '0x804d2531fba1e5938ddd465517d8ac7b6f46caeefebcf8a4930f53703ceb1220',
  genlayerTxHash: '0x5c363e6bb3c0eef15f9b1cfb822fd5410bbc89a843265741892149a51128cd71',
  resolver: getAddress('0x017311b35dbB9802883bDaE7Fb0Efd7Bd77cB0b2'),
  baseReceiver: getAddress('0x15dDbCd98F97065746a1c35f88BB670a7A942264'),
  baseRegistry: getAddress('0x10079EF049D283BC3f212CCaC4291b3aC2719C48'),
  expectedWallet: getAddress('0x63038a310a46AC61A59c1bC5eAD5fe41040eF38e'),
  simulationAccount: getAddress('0x87e94EDAb4418e8A9eA37c0FAb0675Cf0602A9F2'),
  expectedWatchers: Object.freeze([
    getAddress('0x51a54A0E3Fc06B108175b06bE25bFB253Ec53c40'),
    getAddress('0x8C6b2b9151f004F8a9941a21Aad87bef5B3fCAd1'),
  ]),
  watcherCredentials: Object.freeze([
    Object.freeze({
      keystorePath: path.join(ADPROOF_ROOT, '.secrets', 'testnet-watchers', 'watcher-1.keystore.json'),
      passwordFilePath: path.join(ADPROOF_ROOT, '.secrets', 'testnet-watcher-passwords', 'watcher-1.password'),
    }),
    Object.freeze({
      keystorePath: path.join(ADPROOF_ROOT, '.secrets', 'testnet-watchers', 'watcher-2.keystore.json'),
      passwordFilePath: path.join(ADPROOF_ROOT, '.secrets', 'testnet-watcher-passwords', 'watcher-2.password'),
    }),
  ]),
  relayerKeystorePath: path.join(
    ADPROOF_ROOT,
    '.secrets',
    'testnet-deployer',
    'grounding-bradbury.keystore.json',
  ),
  brokerPath: '/api/internal/base-relay/ownership-authorization',
  grantTtlMs: 5 * 60 * 1_000,
  vercelProjectId: 'prj_4W0EuXNi5nFD46ArUAbvk2YnTacu',
  vercelOrgId: 'team_2L0T4LCdFsCTFcckeTFWZRvN',
  vercelTeamSlug: 'leokings588-5902s-projects',
});

export function normalizePreviewDeploymentUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('A valid Vercel Preview deployment URL is required');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || !parsed.hostname.endsWith('.vercel.app')
    || !parsed.hostname.startsWith('influencedx-')
  ) {
    throw new Error('The broker target must be an exact HTTPS InfluencedX Vercel Preview origin');
  }
  return parsed.origin;
}

export function assertPreviewOperatorEnvironment(environment = process.env) {
  if (
    environment.VERCEL_ENV !== 'preview'
    || environment.VERCEL_TARGET_ENV !== 'preview'
  ) {
    throw new Error('The Base relay operator is disabled outside the Vercel Preview environment');
  }
  if (typeof environment.DATABASE_URL !== 'string' || environment.DATABASE_URL.length === 0) {
    throw new Error('Preview DATABASE_URL is required');
  }
  const forbiddenCredentialVariables = [
    'BASE_RELAYER_PRIVATE_KEY',
    'BASE_RELAYER_ALLOW_TEST_ONLY_RAW_KEY',
    'BASE_RELAYER_KEYSTORE_PASSWORD',
    'BASE_RELAYER_KEYSTORE_PASSWORD_FILE',
  ];
  for (const name of forbiddenCredentialVariables) {
    if (typeof environment[name] === 'string' && environment[name].length > 0) {
      throw new Error(`${name} must not be present during the interactive relay ceremony`);
    }
  }
}
