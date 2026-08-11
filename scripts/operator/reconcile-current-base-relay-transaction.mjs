import {
  createPublicClient,
  decodeFunctionData,
  getAddress,
  http,
} from 'viem';
import { baseSepolia } from 'viem/chains';

import {
  buildAttestation,
  canonicalJson,
} from '../../src/relay/attestations.mjs';
import { CREATOR_RELAY_ABI } from '../../src/relay/in-memory-base-relay.mjs';
import { readFinalizedGenLayerResult } from '../../src/relay/genlayer-source.mjs';
import {
  assertPreviewOperatorEnvironment,
  CURRENT_PREVIEW_RELAY,
} from './current-preview-relay.mjs';
import {
  bindingFromRelayConfiguration,
  readConfirmedCreatorProfile,
} from './preview-base-sepolia-relay.mjs';
import { PreviewRelayStore } from './preview-relay-store.mjs';

const APPLY_FLAG = '--apply-confirmed-transaction';
const transactionHash = process.argv[2]?.toLowerCase();

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  assertPreviewOperatorEnvironment(process.env);
  invariant(/^0x[0-9a-f]{64}$/.test(transactionHash ?? ''),
    'An exact Base transaction hash is required');
  invariant(process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === APPLY_FLAG),
    `Only the optional ${APPLY_FLAG} flag is accepted`);

  const binding = bindingFromRelayConfiguration(CURRENT_PREVIEW_RELAY);
  const { receipt: genLayerReceipt, result } = await readFinalizedGenLayerResult({
    resolver: binding.resolver,
    txHash: binding.genlayerTxHash,
    requestId: binding.requestId,
  });
  invariant(genLayerReceipt.statusName === 'FINALIZED'
    && genLayerReceipt.txExecutionResultName === 'FINISHED_WITH_RETURN',
  'The GenLayer proof is not finalized successfully');
  const attestation = buildAttestation({
    result,
    resolver: binding.resolver,
    txHash: binding.genlayerTxHash,
    receiver: binding.baseReceiver,
    chainId: CURRENT_PREVIEW_RELAY.chainId,
  });

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(CURRENT_PREVIEW_RELAY.rpcUrl),
  });
  const [transaction, receipt, latestBlock] = await Promise.all([
    publicClient.getTransaction({ hash: transactionHash }),
    publicClient.getTransactionReceipt({ hash: transactionHash }),
    publicClient.getBlockNumber(),
  ]);
  invariant(receipt.status === 'success', 'The Base relay transaction did not succeed');
  invariant(transaction.blockNumber !== null && receipt.blockNumber === transaction.blockNumber,
    'The Base transaction and receipt blocks do not match');
  invariant(latestBlock >= receipt.blockNumber, 'The Base receipt is not in the canonical chain view');
  invariant(getAddress(transaction.from) === CURRENT_PREVIEW_RELAY.simulationAccount,
    'The Base transaction came from another relayer');
  invariant(getAddress(transaction.to) === binding.baseReceiver,
    'The Base transaction called another contract');
  invariant(transaction.value === 0n, 'The Base relay transaction sent value');
  invariant(transaction.nonce === 5, 'The Base relay transaction used an unexpected nonce');

  const decoded = decodeFunctionData({ abi: CREATOR_RELAY_ABI, data: transaction.input });
  invariant(decoded.functionName === 'submitCreatorVerification',
    'The Base transaction called another receiver method');
  invariant(canonicalJson(decoded.args[0]) === canonicalJson(attestation.message),
    'The Base transaction did not carry the exact finalized creator attestation');
  invariant(typeof decoded.args[1] === 'string' && decoded.args[1] !== '0x',
    'The Base transaction omitted creator authorization');
  invariant(Array.isArray(decoded.args[2]) && decoded.args[2].length === 2,
    'The Base transaction did not carry the required watcher quorum');

  const profile = await readConfirmedCreatorProfile({
    publicClient,
    binding,
    attestation,
  });

  const store = new PreviewRelayStore({ databaseUrl: process.env.DATABASE_URL });
  await store.connect();
  try {
    if (process.argv[3] === APPLY_FLAG) {
      await store.markConfirmedFromReconciliation({
        binding,
        transactionHash,
        profile,
        nowMs: Date.now(),
      });
    }
  } finally {
    await store.close();
  }

  process.stdout.write(`${JSON.stringify({
    transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    transactionConfirmed: true,
    profileId: profile.profileId,
    profileActive: true,
    databaseApplied: process.argv[3] === APPLY_FLAG,
  })}\n`);
}

await main();
