import { createAccount, createClient } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { ExecutionResult, TransactionStatus } from 'genlayer-js/types';
import { getAddress } from 'viem';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

const privateKey = process.env.GENLAYER_RESOLVER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? '')) throw new Error('GENLAYER_RESOLVER_PRIVATE_KEY is required');
const account = createAccount(privateKey);
const client = createClient({ chain: testnetBradbury, account });
const resolver = getAddress(argument('resolver'));
const requestId = argument('request-id').toLowerCase();
const baseWallet = getAddress(argument('base-wallet')).toLowerCase();
const identityHash = argument('identity-hash').toLowerCase();
const handle = argument('handle');
const metricsExpiresAt = Math.floor(Date.now() / 1_000) + 24 * 60 * 60;

const hash = await client.writeContract({
  account,
  address: resolver,
  functionName: 'snapshot_metrics',
  args: [requestId, baseWallet, identityHash, handle, metricsExpiresAt],
  value: 0n,
});
const receipt = await client.waitForTransactionReceipt({
  hash,
  status: TransactionStatus.ACCEPTED,
  interval: 3_000,
  retries: 200,
});
if (receipt.txExecutionResultName !== ExecutionResult.FINISHED_WITH_RETURN) {
  throw new Error(`Bradbury execution failed: ${receipt.txExecutionResultName ?? receipt.txExecutionResult}; tx ${hash}`);
}
const raw = await client.readContract({
  address: resolver,
  functionName: 'get_result',
  args: [requestId],
});
const result = JSON.parse(raw);
if (result.request_id !== requestId || result.kind !== 'METRICS') throw new Error('Unexpected resolver result');
console.log(JSON.stringify({
  signer: account.address,
  hash,
  status: receipt.statusName,
  executionResult: receipt.txExecutionResultName,
  result,
}, null, 2));
