import { createAccount, createClient } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { TransactionHashVariant } from 'genlayer-js/types';

import { SUBMITTER_METHOD } from './constants.mjs';
import { submissionArgs } from './envelope.mjs';

export function createPinnedBradburyClient(config) {
  const account = createAccount(config.privateKey);
  const client = createClient({
    chain: testnetBradbury,
    endpoint: config.rpcUrl,
    account,
  });

  return Object.freeze({
    async submitOwnership(envelope) {
      return client.writeContract({
        account,
        address: config.resolver,
        functionName: SUBMITTER_METHOD,
        args: submissionArgs(envelope),
        value: 0n,
      });
    },

    async getTransaction(txHash) {
      return client.getTransaction({ hash: txHash });
    },

    async readExistingResult(requestId) {
      return readResult(client, config.resolver, requestId, TransactionHashVariant.LATEST_NONFINAL);
    },

    async readFinalResult(requestId) {
      return readResult(client, config.resolver, requestId, TransactionHashVariant.LATEST_FINAL);
    },
  });
}

async function readResult(client, resolver, requestId, transactionHashVariant) {
  const raw = await client.readContract({
    address: resolver,
    functionName: 'get_result',
    args: [requestId],
    transactionHashVariant,
  });
  if (raw === '') return null;
  if (typeof raw !== 'string') throw new Error('Resolver result is not a string.');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Resolver result is not valid JSON.');
  }
  return parsed;
}
