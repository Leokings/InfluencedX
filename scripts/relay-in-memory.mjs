import readline from 'node:readline/promises';

import {
  BASE_SEPOLIA_RELAY_CONFIRMATION,
  prepareBaseSepoliaCreatorRelay,
} from '../src/relay/in-memory-base-relay.mjs';
import { promptForHiddenHex } from '../src/relay/hidden-input.mjs';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing --${name}`);
  return value;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

async function promptForBroadcastConfirmation() {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error('Broadcast confirmation requires a real interactive terminal');
  }
  const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await terminal.question(
      `Type ${BASE_SEPOLIA_RELAY_CONFIRMATION} to broadcast: `,
    );
  } finally {
    terminal.close();
  }
}

async function main() {
  if (process.argv.includes('--ownership-signature')) {
    throw new Error('Creator signatures are never accepted through command arguments');
  }
  const broadcast = flag('broadcast');
  let ownershipIntentSignature = await promptForHiddenHex({
    prompt: 'Creator ownership signature (hidden): ',
  });
  try {
    const prepared = await prepareBaseSepoliaCreatorRelay({
      ownershipIntentSignature,
      resolver: argument('resolver'),
      txHash: argument('tx'),
      requestId: argument('request-id'),
      receiver: argument('receiver'),
      simulationAccount: argument('relayer-address'),
      watcherCredentials: [1, 2].map((number) => ({
        keystorePath: argument(`watcher-${number}-keystore`),
        passwordFilePath: argument(`watcher-${number}-password-file`),
      })),
      rpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org',
    });
    try {
      const result = broadcast
        ? await prepared.broadcast({ confirmation: await promptForBroadcastConfirmation() })
        : prepared.summary;
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
      prepared.dispose();
    }
  } finally {
    ownershipIntentSignature = undefined;
  }
}

main().catch((error) => {
  process.stderr.write(`Relay stopped: ${error instanceof Error ? error.message : 'unknown safe failure'}\n`);
  process.exitCode = 1;
});
