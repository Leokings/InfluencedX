import fs from 'node:fs';
import path from 'node:path';

import { baseSepolia } from 'viem/chains';
import { createPublicClient, createWalletClient, getAddress, http } from 'viem';

import {
  canonicalJson,
  coerceBundle,
  recoverBundleSigner,
} from '../src/relay/attestations.mjs';
import { loadBaseSepoliaRelayer } from './lib/base-relayer-account.mjs';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

const signaturePaths = argument('signatures').split(',').map((value) => path.resolve(value.trim()));
const records = signaturePaths.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
if (records.length === 0) throw new Error('At least one watcher signature is required');

const reference = coerceBundle(records[0]);
if (reference.primaryType === 'CreatorVerification') {
  throw new Error('Creator verification must use relay-in-memory.mjs; creator signatures are never accepted through argv or files');
}
const referenceKey = canonicalJson(reference);
for (const record of records) {
  if (canonicalJson(coerceBundle(record)) !== referenceKey) throw new Error('Watcher signatures do not cover the same attestation');
}

const recovered = await Promise.all(records.map(async (record) => ({
  address: getAddress(await recoverBundleSigner(record, record.signature)),
  signature: record.signature,
  claimed: getAddress(record.watcher),
})));
for (const item of recovered) {
  if (item.address !== item.claimed) throw new Error(`Signature does not match claimed watcher ${item.claimed}`);
}
recovered.sort((left, right) => left.address.toLowerCase().localeCompare(right.address.toLowerCase()));
if (new Set(recovered.map((item) => item.address)).size !== recovered.length) throw new Error('Duplicate watcher signature');

const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
if (await publicClient.getChainId() !== baseSepolia.id) throw new Error('RPC is not Base Sepolia');
if (reference.domain.chainId !== baseSepolia.id) throw new Error('Attestation domain is not Base Sepolia');

const receiverArtifact = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '..', 'artifacts', 'base', 'AdProofAttestationReceiver.json'), 'utf8'),
);
const receiver = getAddress(reference.domain.verifyingContract);
const threshold = await publicClient.readContract({
  address: receiver,
  abi: receiverArtifact.abi,
  functionName: 'threshold',
});
if (BigInt(recovered.length) < threshold) throw new Error(`Need ${threshold} watcher signatures, received ${recovered.length}`);
for (const item of recovered) {
  const enabled = await publicClient.readContract({
    address: receiver,
    abi: receiverArtifact.abi,
    functionName: 'isWatcher',
    args: [item.address],
  });
  if (!enabled) throw new Error(`${item.address} is not an enabled watcher`);
}

const functions = {
  CreatorVerification: 'submitCreatorVerification',
  MetricsAttestation: 'submitMetrics',
  CampaignResolution: 'submitCampaignResolution',
};
const functionName = functions[reference.primaryType];
const args = [reference.message, recovered.map((item) => item.signature)];
const account = await loadBaseSepoliaRelayer();
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
const { request } = await publicClient.simulateContract({
  account,
  address: receiver,
  abi: receiverArtifact.abi,
  functionName,
  args,
});
const hash = await walletClient.writeContract(request);
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
if (receipt.status !== 'success') throw new Error(`Base relay transaction reverted: ${hash}`);
console.log(JSON.stringify({ hash, blockNumber: receipt.blockNumber.toString(), receiver, functionName }));
