import { createClient } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { ExecutionResult, TransactionHashVariant, TransactionStatus } from 'genlayer-js/types';
import { getAddress, isAddress } from 'viem';

import { assertVerifiedBaseCampaignBinding } from './campaign-binding.mjs';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const RESULT_METHODS = Object.freeze({
  OWNERSHIP: 'verify_ownership',
  METRICS: 'snapshot_metrics',
  CAMPAIGN: 'resolve_submission',
});

const TRANSACTION_STATUS_NAMES = Object.freeze({
  7: TransactionStatus.FINALIZED,
});

const EXECUTION_RESULT_NAMES = Object.freeze({
  1: ExecutionResult.FINISHED_WITH_RETURN,
  2: ExecutionResult.FINISHED_WITH_ERROR,
});

export function assertGenLayerTransactionBinding(receipt, result, requestId, campaignBinding) {
  const callData = receipt?.txDataDecoded?.callData;
  const method = callData instanceof Map ? callData.get('method') : callData?.method;
  const args = callData instanceof Map ? callData.get('args') : callData?.args;
  const expectedMethod = RESULT_METHODS[result?.kind];
  invariant(expectedMethod, `Unsupported GenLayer result kind: ${result?.kind}`);
  invariant(method === expectedMethod, `GenLayer transaction called ${method ?? 'an unknown method'}, expected ${expectedMethod}`);
  invariant(Array.isArray(args) && typeof args[0] === 'string', 'GenLayer transaction has no request ID argument');
  invariant(args[0].toLowerCase() === requestId.toLowerCase(), 'GenLayer transaction request ID does not match the result');
  if (result.kind === 'CAMPAIGN') {
    assertCampaignTransactionBinding(args, result, campaignBinding);
  } else {
    invariant(campaignBinding === undefined,
      'Campaign binding was supplied for a non-campaign GenLayer result');
  }
}

function assertCampaignTransactionBinding(args, result, binding) {
  invariant(binding && typeof binding === 'object' && !Array.isArray(binding),
    'Campaign GenLayer result requires verified Base campaign binding');
  invariant(args.length === 11,
    `Campaign resolve_submission expected 11 arguments, received ${args.length}`);
  const exact = [
    ['request ID', args[0], binding.requestId],
    ['expected handle', args[1], binding.expectedHandle],
    ['post ID', args[2], binding.postId],
    ['required phrases JSON', args[3], binding.requiredPhrasesJson],
    ['forbidden phrases JSON', args[4], binding.forbiddenPhrasesJson],
    ['ad disclosure flag', args[5], binding.requireAdDisclosure],
    ['semantic brief', args[6], binding.semanticBrief],
    ['agreement hash', args[9], binding.agreementHash],
    ['submission hash', args[10], binding.submissionHash],
  ];
  for (const [label, actual, expected] of exact) {
    invariant(actual === expected,
      `Campaign GenLayer ${label} does not match verified Base campaign binding`);
  }
  invariant(canonicalUnsignedInteger(args[7], 'Campaign resolve-not-before')
    === canonicalUnsignedInteger(binding.resolveNotBeforeEpoch, 'Verified resolve-not-before'),
  'Campaign GenLayer resolve-not-before does not match Base retention');
  invariant(canonicalUnsignedInteger(args[8], 'Campaign assignment ID')
    === canonicalUnsignedInteger(binding.assignmentId, 'Verified assignment ID'),
  'Campaign GenLayer assignment ID does not match Base assignment');

  invariant(result.request_id === binding.requestId,
    'Campaign result request ID is not canonical or does not match Base');
  invariant(result.handle === binding.expectedHandle,
    'Campaign result handle does not match verified resolver calldata');
  invariant(result.post_id === binding.postId,
    'Campaign result post ID does not match verified resolver calldata');
  invariant(canonicalUnsignedInteger(result.assignment_id, 'Campaign result assignment ID')
    === canonicalUnsignedInteger(binding.assignmentId, 'Verified assignment ID'),
  'Campaign result assignment ID does not match Base assignment');
  invariant(result.agreement_hash === binding.agreementHash,
    'Campaign result agreement hash does not match Base assignment');
  invariant(result.submission_hash === binding.submissionHash,
    'Campaign result submission hash does not match Base assignment');
}

function canonicalUnsignedInteger(value, label) {
  let parsed;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) parsed = BigInt(value);
  else throw new Error(`${label} must be an unsigned integer`);
  invariant(parsed >= 0n, `${label} must be an unsigned integer`);
  return parsed;
}

/**
 * The SDK's full transaction uses camel-case labels, while its simplified
 * receipt currently maps `statusName` to `status_name`. Bradbury can also
 * return only the numeric enum values. Normalize those supported shapes here
 * and keep lifecycle finality separate from execution success.
 */
export function normalizeGenLayerReceipt(receipt) {
  invariant(receipt && typeof receipt === 'object', 'GenLayer transaction receipt is missing');
  const rawStatus = receipt.status;
  const rawExecution = receipt.txExecutionResult ?? receipt.tx_execution_result;
  const statusName = receipt.statusName
    ?? receipt.status_name
    ?? TRANSACTION_STATUS_NAMES[String(rawStatus)];
  const txExecutionResultName = receipt.txExecutionResultName
    ?? receipt.tx_execution_result_name
    ?? EXECUTION_RESULT_NAMES[String(rawExecution)];
  return {
    ...receipt,
    statusName,
    txExecutionResultName,
  };
}

export async function readFinalizedGenLayerResult({
  resolver,
  txHash,
  requestId,
  endpoint = process.env.GENLAYER_RPC_URL,
  wait = true,
  campaignBinding,
}) {
  invariant(isAddress(resolver), 'Invalid GenLayer resolver address');
  invariant(/^0x[0-9a-fA-F]{64}$/.test(txHash), 'Invalid GenLayer transaction hash');
  invariant(/^0x[0-9a-fA-F]{64}$/.test(requestId), 'Invalid GenLayer request ID');
  const client = createClient({
    chain: testnetBradbury,
    ...(endpoint ? { endpoint } : {}),
  });
  const rawReceipt = wait
    ? await client.waitForTransactionReceipt({
      hash: txHash,
      status: TransactionStatus.FINALIZED,
      interval: 3_000,
      retries: 200,
      // The simplified SDK receipt drops decoded calldata. Relay security
      // requires the full transaction so method + request ID can be rebound.
      fullTransaction: true,
    })
    : await client.getTransaction({ hash: txHash });
  const receipt = normalizeGenLayerReceipt(rawReceipt);

  invariant(receipt.statusName === TransactionStatus.FINALIZED, `GenLayer transaction is ${receipt.statusName ?? receipt.status}`);
  invariant(
    receipt.txExecutionResultName === ExecutionResult.FINISHED_WITH_RETURN,
    `GenLayer execution is ${receipt.txExecutionResultName ?? receipt.txExecutionResult}`,
  );
  const recipient = receipt.toAddress ?? receipt.recipient ?? receipt.to_address;
  if (recipient) invariant(getAddress(recipient) === getAddress(resolver), 'Transaction targeted a different resolver');

  const raw = await client.readContract({
    address: getAddress(resolver),
    functionName: 'get_result',
    args: [requestId.toLowerCase()],
    transactionHashVariant: TransactionHashVariant.LATEST_FINAL,
  });
  invariant(typeof raw === 'string' && raw.length > 0, 'Finalized resolver result is empty');
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error('Finalized resolver result is not JSON');
  }
  invariant(result.request_id?.toLowerCase() === requestId.toLowerCase(), 'Resolver returned a different request ID');
  if (result.kind === 'CAMPAIGN') assertVerifiedBaseCampaignBinding(campaignBinding);
  assertGenLayerTransactionBinding(receipt, result, requestId, campaignBinding);
  return { receipt, result };
}
