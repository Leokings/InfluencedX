import fs from 'node:fs';
import path from 'node:path';

import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';

import { verifyBaseSepoliaDeployment } from './lib/base-deployment-verifier.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--manifest', '--rpc-url'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  return values;
}

function loadJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot load ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifestPath = path.resolve(
    options.manifest
      ?? process.env.BASE_SEPOLIA_DEPLOYMENT_MANIFEST
      ?? path.join(projectRoot, 'deployments', 'base-sepolia.json'),
  );
  const rpcUrl = options['rpc-url']
    ?? process.env.BASE_SEPOLIA_RPC_URL
    ?? 'https://sepolia.base.org';
  const manifest = loadJson(manifestPath, 'Base Sepolia deployment manifest');
  const artifacts = {
    registry: loadJson(
      path.join(projectRoot, 'artifacts', 'base', 'AdProofCreatorRegistry.json'),
      'creator registry artifact',
    ),
    escrow: loadJson(
      path.join(projectRoot, 'artifacts', 'base', 'AdProofEscrow.json'),
      'escrow artifact',
    ),
    receiver: loadJson(
      path.join(projectRoot, 'artifacts', 'base', 'AdProofAttestationReceiver.json'),
      'attestation receiver artifact',
    ),
  };
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl, { timeout: 20_000, retryCount: 3 }),
  });
  const evidence = await verifyBaseSepoliaDeployment({ manifest, artifacts, publicClient });
  console.log(JSON.stringify({ ...evidence, manifestPath }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
});
