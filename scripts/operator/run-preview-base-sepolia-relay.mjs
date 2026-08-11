import {
  assertPreviewOperatorEnvironment,
  CURRENT_PREVIEW_RELAY,
  normalizePreviewDeploymentUrl,
} from './current-preview-relay.mjs';
import { runPreviewBaseSepoliaRelay } from './preview-base-sepolia-relay.mjs';

function previewUrlArgument(argv) {
  if (argv.length !== 2 || argv[0] !== '--preview-url') {
    throw new Error('Usage: relay:preview:base-sepolia --preview-url https://influencedx-....vercel.app');
  }
  return normalizePreviewDeploymentUrl(argv[1]);
}

async function main() {
  assertPreviewOperatorEnvironment(process.env);
  const previewUrl = previewUrlArgument(process.argv.slice(2));
  process.stdout.write('InfluencedX exact Preview proof preflight -> Base Sepolia\n');
  process.stdout.write('Watcher credentials are opened only after DB, GenLayer, Base, and creator-signature checks.\n');
  await runPreviewBaseSepoliaRelay({
    configuration: CURRENT_PREVIEW_RELAY,
    previewUrl,
    databaseUrl: process.env.DATABASE_URL,
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown safe failure';
  process.stderr.write(`Relay ceremony stopped: ${message}\n`);
  process.exitCode = 1;
});
