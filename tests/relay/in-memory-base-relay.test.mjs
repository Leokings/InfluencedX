import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { getAddress, keccak256, stringToHex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

import {
  BASE_SEPOLIA_RELAY_CONFIRMATION,
  prepareBaseSepoliaCreatorRelay,
} from '../../src/relay/in-memory-base-relay.mjs';

const watcherA = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const watcherB = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const relayer = privateKeyToAccount(`0x${'33'.repeat(32)}`);
const resolver = `0x${'44'.repeat(20)}`;
const receiver = `0x${'55'.repeat(20)}`;
const requestId = keccak256(stringToHex('in-memory-request'));
const txHash = keccak256(stringToHex('in-memory-genlayer-tx'));
const ownershipIntentSignature = `0x${'ab'.repeat(65)}`;
const broadcastHash = keccak256(stringToHex('base-broadcast'));

const ownershipResult = Object.freeze({
  kind: 'OWNERSHIP',
  request_id: requestId,
  base_wallet: `0x${'66'.repeat(20)}`,
  identity_hash: keccak256(stringToHex('in-memory-identity')),
  handle: 'in_memory_creator',
  post_id: '1900000000000000000',
  challenge_hash: keccak256(stringToHex('in-memory-challenge')),
  verified_at_epoch: 1_800_000_000,
  credential_expires_at_epoch: 1_802_592_000,
  request_match: true,
  post_id_match: true,
  protocol_match: true,
  wallet_match: true,
  issued_at_match: true,
  expires_at_match: true,
  credential_expires_at_match: true,
  challenge_match: true,
  publication_in_window: true,
  identity_match: true,
  author_match: true,
  outcome: 'VERIFIED',
});

function relayInput(overrides = {}) {
  return {
    ownershipIntentSignature,
    resolver,
    txHash,
    requestId,
    receiver,
    simulationAccount: relayer.address,
    watcherCredentials: [
      { keystorePath: 'watcher-one.json', passwordFilePath: 'watcher-one.password' },
      { keystorePath: 'watcher-two.json', passwordFilePath: 'watcher-two.password' },
    ],
    ...overrides,
  };
}

function fixtureDependencies(overrides = {}) {
  const calls = {
    watcherLoads: [],
    authorizationChecks: [],
    publicClients: [],
    sourceReads: [],
    simulations: [],
    walletWriteRequests: [],
    relayerLoads: 0,
    walletWrites: 0,
  };
  const accounts = [watcherA, watcherB];
  const relayClient = {
    getChainId: async () => baseSepolia.id,
    readContract: async ({ functionName }) => {
      if (functionName === 'threshold') return 2n;
      if (functionName === 'watcherCount') return 3n;
      throw new Error(`unexpected read ${functionName}`);
    },
    simulateContract: async (parameters) => {
      calls.simulations.push(parameters);
      return { request: { ...parameters } };
    },
    waitForTransactionReceipt: async () => ({
      status: 'success',
      blockNumber: 123n,
    }),
  };
  const dependencies = {
    readFinalizedGenLayerResult: async (parameters) => {
      calls.sourceReads.push(parameters);
      return {
        receipt: { statusName: 'FINALIZED' },
        result: ownershipResult,
      };
    },
    loadWatcherAccountFromFiles: async (credential) => {
      const index = calls.watcherLoads.length;
      calls.watcherLoads.push(credential);
      return accounts[index];
    },
    verifyCreatorOwnershipAuthorization: async (parameters) => {
      calls.authorizationChecks.push(parameters);
      return { verifiedAtBlockNumber: 1n };
    },
    createPublicClient: (configuration) => {
      calls.publicClients.push(configuration);
      return configuration.purpose === 'relay-simulation'
        ? relayClient
        : { watcherPurpose: configuration.purpose, watcher: configuration.watcher };
    },
    loadBaseSepoliaRelayer: async () => {
      calls.relayerLoads += 1;
      return relayer;
    },
    createWalletClient: () => ({
      writeContract: async (request) => {
        calls.walletWrites += 1;
        calls.walletWriteRequests.push(request);
        return broadcastHash;
      },
    }),
    ...overrides,
  };
  return { calls, dependencies };
}

test('verifies and signs with exactly two watchers, then simulates without loading the relayer', async () => {
  const { calls, dependencies } = fixtureDependencies();
  const prepared = await prepareBaseSepoliaCreatorRelay({ ...relayInput(), dependencies });
  try {
    assert.equal(calls.watcherLoads.length, 2);
    assert.equal(calls.sourceReads.length, 2);
    assert.equal(calls.authorizationChecks.length, 2);
    assert.deepEqual(
      calls.authorizationChecks.map(({ watcher }) => watcher),
      [watcherA.address, watcherB.address],
    );
    assert.ok(calls.authorizationChecks.every(({ ownershipSignature }) => (
      ownershipSignature === ownershipIntentSignature
    )));
    assert.notEqual(calls.authorizationChecks[0].publicClient, calls.authorizationChecks[1].publicClient);
    assert.equal(calls.simulations.length, 1);
    assert.equal(calls.simulations[0].account, relayer.address);
    assert.equal(calls.simulations[0].args[1], ownershipIntentSignature);
    assert.equal(calls.simulations[0].args[2].length, 2);
    assert.equal(calls.relayerLoads, 0);
    assert.equal(calls.walletWrites, 0);
    assert.equal(prepared.summary.status, 'SIMULATED');
    assert.equal(prepared.summary.broadcast, false);
    assert.equal(prepared.summary.simulationAccount, relayer.address);
    assert.doesNotMatch(JSON.stringify(prepared.summary), new RegExp(ownershipIntentSignature));
    for (const watcherSignature of calls.simulations[0].args[2]) {
      assert.equal(JSON.stringify(prepared.summary).includes(watcherSignature), false);
    }
  } finally {
    prepared.dispose();
  }
});

test('broadcast gate invokes the supplied relayer loader only after exact confirmation', async () => {
  const { calls, dependencies } = fixtureDependencies();
  const prepared = await prepareBaseSepoliaCreatorRelay({ ...relayInput(), dependencies });
  let explicitLoaderCalls = 0;
  const loadRelayerAccount = async () => {
    explicitLoaderCalls += 1;
    return relayer;
  };

  await assert.rejects(
    prepared.broadcast({ confirmation: 'yes', loadRelayerAccount }),
    /exact confirmation/,
  );
  assert.equal(explicitLoaderCalls, 0);
  assert.equal(calls.walletWrites, 0);

  const result = await prepared.broadcast({
    confirmation: BASE_SEPOLIA_RELAY_CONFIRMATION,
    loadRelayerAccount,
  });
  assert.equal(explicitLoaderCalls, 1);
  assert.equal(calls.relayerLoads, 0);
  assert.equal(calls.walletWrites, 1);
  assert.equal(calls.walletWriteRequests[0].account, relayer);
  assert.equal(calls.simulations[0].account, relayer.address);
  assert.deepEqual(result, {
    ...prepared.summary,
    status: 'CONFIRMED',
    broadcast: true,
    hash: broadcastHash,
    blockNumber: '123',
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(ownershipIntentSignature));
  await assert.rejects(
    prepared.broadcast({
      confirmation: BASE_SEPOLIA_RELAY_CONFIRMATION,
      loadRelayerAccount,
    }),
    /only attempt one broadcast/,
  );
});

test('fails closed on wrong quorum, duplicate watchers, and relayer identity changes', async () => {
  const wrongQuorum = fixtureDependencies({
    createPublicClient: (configuration) => (
      configuration.purpose === 'relay-simulation'
        ? {
          getChainId: async () => baseSepolia.id,
          readContract: async ({ functionName }) => functionName === 'threshold' ? 3n : 3n,
          simulateContract: async () => assert.fail('must not simulate a wrong quorum'),
        }
        : {}
    ),
  });
  await assert.rejects(
    prepareBaseSepoliaCreatorRelay({ ...relayInput(), dependencies: wrongQuorum.dependencies }),
    /required 2-of-3-or-more watcher quorum/,
  );

  const duplicate = fixtureDependencies({
    loadWatcherAccountFromFiles: async () => watcherA,
  });
  await assert.rejects(
    prepareBaseSepoliaCreatorRelay({ ...relayInput(), dependencies: duplicate.dependencies }),
    /two distinct accounts/,
  );

  const mismatch = fixtureDependencies();
  const prepared = await prepareBaseSepoliaCreatorRelay({ ...relayInput(), dependencies: mismatch.dependencies });
  await assert.rejects(
    prepared.broadcast({
      confirmation: BASE_SEPOLIA_RELAY_CONFIRMATION,
      loadRelayerAccount: async () => privateKeyToAccount(`0x${'77'.repeat(32)}`),
    }),
    /does not match the account used for simulation/,
  );
  assert.equal(mismatch.calls.walletWrites, 0);
});

test('independent watchers must derive the identical finalized attestation', async () => {
  let sourceRead = 0;
  const { dependencies } = fixtureDependencies({
    readFinalizedGenLayerResult: async () => {
      sourceRead += 1;
      return {
        receipt: { statusName: 'FINALIZED' },
        result: sourceRead === 1
          ? ownershipResult
          : { ...ownershipResult, handle: 'different_finalized_handle' },
      };
    },
  });
  await assert.rejects(
    prepareBaseSepoliaCreatorRelay({ ...relayInput(), dependencies }),
    /Independent watchers derived different finalized attestations/,
  );
  assert.equal(sourceRead, 2);
});

test('dependency failures cannot echo creator or watcher signatures', async () => {
  const leakedWatcherSignature = `0x${'cd'.repeat(65)}`;
  const { dependencies } = fixtureDependencies({
    verifyCreatorOwnershipAuthorization: async ({ ownershipSignature }) => {
      throw new Error(`provider included ${ownershipSignature} and ${leakedWatcherSignature}`);
    },
  });
  await assert.rejects(
    prepareBaseSepoliaCreatorRelay({ ...relayInput(), dependencies }),
    (error) => {
      assert.match(error.message, /failed without exposing sensitive relay inputs/);
      assert.equal(error.message.includes(ownershipIntentSignature), false);
      assert.equal(error.message.includes(leakedWatcherSignature), false);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test('creator relay commands have no argv, environment, or file transport for signatures', async () => {
  const [operator, watcherCommand, submitCommand, library] = await Promise.all([
    fs.readFile(new URL('../../scripts/relay-in-memory.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../scripts/relay-watcher.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../scripts/relay-submit.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../src/relay/in-memory-base-relay.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(operator, /promptForHiddenHex/);
  assert.doesNotMatch(operator, /argument\(['"]ownership-signature/);
  assert.doesNotMatch(operator, /process\.env\.[A-Z_]*OWNERSHIP[A-Z_]*/);
  assert.doesNotMatch(operator, /writeFile/);
  assert.doesNotMatch(watcherCommand, /argument\(['"]ownership-signature/);
  assert.doesNotMatch(submitCommand, /argument\(['"]ownership-signature/);
  assert.doesNotMatch(library, /console\.|writeFile|appendFile/);
});

test('rejects anything other than two distinct watcher credential pairs before source reads', async () => {
  let sourceReads = 0;
  const dependencies = {
    readFinalizedGenLayerResult: async () => {
      sourceReads += 1;
      return { result: ownershipResult };
    },
  };
  await assert.rejects(
    prepareBaseSepoliaCreatorRelay({
      ...relayInput({ watcherCredentials: relayInput().watcherCredentials.slice(0, 1) }),
      dependencies,
    }),
    /Exactly two/,
  );
  await assert.rejects(
    prepareBaseSepoliaCreatorRelay({
      ...relayInput({
        watcherCredentials: [
          relayInput().watcherCredentials[0],
          { ...relayInput().watcherCredentials[1], keystorePath: 'watcher-one.json' },
        ],
      }),
      dependencies,
    }),
    /keystore paths must be distinct/,
  );
  assert.equal(sourceReads, 0);
});
