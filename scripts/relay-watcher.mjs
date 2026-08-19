import fs from 'node:fs';
import path from 'node:path';

import { createPublicClient, http, keccak256, stringToHex } from 'viem';
import { baseSepolia } from 'viem/chains';

import {
  buildAttestation,
  canonicalJson,
  serializeBigInts,
} from '../src/relay/attestations.mjs';
import { readBaseCampaignBinding } from '../src/relay/campaign-binding.mjs';
import { readFinalizedGenLayerResult } from '../src/relay/genlayer-source.mjs';
import { loadWatcherAccountFromFiles } from '../src/relay/watcher-keystore.mjs';

function argument(name, required = true) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (required && !value) throw new Error(`Missing --${name}`);
  return value;
}

const resolver = argument('resolver');
const txHash = argument('tx');
const requestId = argument('request-id');
const receiver = argument('receiver');
const output = path.resolve(argument('output'));
const campaignBindingPath = argument('campaign-binding', false);
let campaignBinding;
if (campaignBindingPath) {
  const expected = JSON.parse(fs.readFileSync(path.resolve(campaignBindingPath), 'utf8'));
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  campaignBinding = await readBaseCampaignBinding({
    publicClient,
    receiver,
    requestId,
    expected,
  });
}
const { receipt, result } = await readFinalizedGenLayerResult({
  resolver,
  txHash,
  requestId,
  campaignBinding,
});
const bundle = buildAttestation({ result, resolver, txHash, receiver });
if (bundle.primaryType === 'CreatorVerification') {
  throw new Error('Creator verification must use relay-in-memory.mjs; creator signatures are never accepted through argv or files');
}
const account = await loadWatcherAccountFromFiles({
  keystorePath: process.env.ADPROOF_WATCHER_KEYSTORE_PATH,
  passwordFilePath: process.env.ADPROOF_WATCHER_KEYSTORE_PASSWORD_FILE,
});
const signature = await account.signTypedData(bundle);
const record = {
  schemaVersion: 2,
  ...bundle,
  source: {
    network: 'studionet',
    resolver,
    txHash,
    requestId,
    finalizedStatus: receipt.statusName,
    executionResult: receipt.txExecutionResultName,
    resultHash: keccak256(stringToHex(canonicalJson(result))),
  },
  watcher: account.address,
  signature,
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${serializeBigInts(record)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output, watcher: account.address, primaryType: bundle.primaryType }));
