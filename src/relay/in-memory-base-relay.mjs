import {
  createPublicClient as createViemPublicClient,
  createWalletClient as createViemWalletClient,
  getAddress,
  http,
  isAddress,
  isHex,
  parseAbi,
} from 'viem';
import { baseSepolia } from 'viem/chains';

import {
  buildAttestation,
  canonicalJson,
  recoverBundleSigner,
} from './attestations.mjs';
import { readFinalizedGenLayerResult } from './genlayer-source.mjs';
import { verifyCreatorOwnershipAuthorization } from './ownership-authorization.mjs';
import { loadWatcherAccountFromFiles } from './watcher-keystore.mjs';
import { loadBaseSepoliaRelayer } from '../../scripts/lib/base-relayer-account.mjs';

export const BASE_SEPOLIA_RELAY_CONFIRMATION = 'BROADCAST XPROOF BASE SEPOLIA';

export const CREATOR_RELAY_ABI = parseAbi([
  'function threshold() view returns (uint256)',
  'function watcherCount() view returns (uint256)',
  'function isWatcher(address) view returns (bool)',
  'function submitCreatorVerification((bytes32 attestationId,address wallet,bytes32 identityHash,bytes32 handleHash,bytes32 verificationPostHash,bytes32 challengeHash,bytes32 metricsHash,uint64 verifiedAt,uint64 expiresAt,bytes32 genlayerContract,bytes32 genlayerTxHash,uint64 relayDeadline) item, bytes ownershipSignature, bytes[] watcherSignatures)',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function secretStageError(stage) {
  // Errors raised after the creator signature enters a dependency can include
  // formatted call arguments. Never retain the dependency error or its cause.
  return new Error(`${stage} failed without exposing sensitive relay inputs`);
}

async function secretStage(stage, operation) {
  try {
    return await operation();
  } catch {
    throw secretStageError(stage);
  }
}

function normalizedPath(value) {
  invariant(typeof value === 'string' && value.length > 0, 'Each watcher credential requires a path');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function validateWatcherCredentials(watcherCredentials) {
  invariant(Array.isArray(watcherCredentials) && watcherCredentials.length === 2,
    'Exactly two watcher keystore/password pairs are required');
  const keystorePaths = [];
  const passwordPaths = [];
  for (const credential of watcherCredentials) {
    invariant(credential && typeof credential === 'object' && !Array.isArray(credential),
      'Each watcher credential must be an object');
    keystorePaths.push(normalizedPath(credential.keystorePath));
    passwordPaths.push(normalizedPath(credential.passwordFilePath));
  }
  invariant(new Set(keystorePaths).size === 2, 'Watcher keystore paths must be distinct');
  invariant(new Set(passwordPaths).size === 2, 'Watcher password-file paths must be distinct');
}

function defaultPublicClientFactory({ rpcUrl }) {
  return createViemPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
}

function defaultWalletClientFactory({ account, rpcUrl }) {
  return createViemWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
}

function createBroadcastGate({
  safeBaseResult,
  simulatedRequest,
  simulatedSender,
  publicClient,
  rpcUrl,
  defaultRelayerLoader,
  walletClientFactory,
}) {
  // This closure is the only object intentionally retaining the simulated
  // calldata (and therefore its signatures) after preparation returns.
  let request = simulatedRequest;
  let broadcastStarted = false;
  const dispose = () => {
    request = undefined;
  };
  const broadcast = async ({
    confirmation,
    loadRelayerAccount = defaultRelayerLoader,
  } = {}) => {
    invariant(
      confirmation === BASE_SEPOLIA_RELAY_CONFIRMATION,
      `Broadcast requires the exact confirmation: ${BASE_SEPOLIA_RELAY_CONFIRMATION}`,
    );
    invariant(!broadcastStarted, 'This prepared relay can only attempt one broadcast');
    invariant(request, 'This prepared relay has been disposed');
    invariant(typeof loadRelayerAccount === 'function', 'A Base relayer loader callback is required');
    broadcastStarted = true;

    const account = await secretStage('Base relayer credential loading', () => loadRelayerAccount());
    invariant(getAddress(account.address) === simulatedSender,
      'Loaded Base relayer does not match the account used for simulation');
    const walletClient = walletClientFactory({ account, rpcUrl });
    let hash;
    try {
      // simulateContract accepts a public address, so its returned request may
      // retain a JSON-RPC account. Force the decrypted LocalAccount here or a
      // public RPC will try eth_sendTransaction instead of signing locally.
      hash = await secretStage('Base creator relay broadcast', () => walletClient.writeContract({
        ...request,
        account,
      }));
    } finally {
      dispose();
    }
    let receipt;
    try {
      receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    } catch {
      throw new Error(`Base relay ${hash} was broadcast but receipt confirmation failed; reconcile by transaction hash`);
    }
    invariant(receipt.status === 'success', `Base creator relay transaction reverted: ${hash}`);
    return Object.freeze({
      ...safeBaseResult,
      status: 'CONFIRMED',
      broadcast: true,
      hash,
      blockNumber: receipt.blockNumber.toString(),
    });
  };
  return Object.freeze({
    summary: safeBaseResult,
    broadcast,
    dispose,
  });
}

/**
 * Prepares the complete Base Sepolia creator relay without serializing the
 * creator ownership-intent signature. The signature exists only in this call
 * frame and the in-memory viem request used for simulation/broadcast.
 *
 * Every watcher independently re-reads Base authorization state before signing.
 * No watcher bundle is written to disk and no return value contains any input
 * signature or transaction calldata.
 */
export async function prepareBaseSepoliaCreatorRelay({
  ownershipIntentSignature,
  resolver,
  txHash,
  requestId,
  receiver,
  watcherCredentials,
  simulationAccount,
  rpcUrl = 'https://sepolia.base.org',
  dependencies = {},
}) {
  invariant(isHex(ownershipIntentSignature ?? '') && ownershipIntentSignature !== '0x',
    'Creator ownership signature must be supplied directly in memory');
  invariant(isAddress(resolver), 'Invalid GenLayer resolver address');
  invariant(/^0x[0-9a-fA-F]{64}$/.test(txHash ?? ''), 'Invalid GenLayer transaction hash');
  invariant(/^0x[0-9a-fA-F]{64}$/.test(requestId ?? ''), 'Invalid GenLayer request ID');
  invariant(isAddress(receiver), 'Invalid Base receiver address');
  invariant(isAddress(simulationAccount), 'A public Base Sepolia simulation account is required');
  invariant(typeof rpcUrl === 'string' && rpcUrl.length > 0, 'Base Sepolia RPC URL is required');
  validateWatcherCredentials(watcherCredentials);

  const sourceReader = dependencies.readFinalizedGenLayerResult ?? readFinalizedGenLayerResult;
  const watcherLoader = dependencies.loadWatcherAccountFromFiles ?? loadWatcherAccountFromFiles;
  const authorizationVerifier = dependencies.verifyCreatorOwnershipAuthorization
    ?? verifyCreatorOwnershipAuthorization;
  const defaultRelayerLoader = dependencies.loadBaseSepoliaRelayer ?? loadBaseSepoliaRelayer;
  const publicClientFactory = dependencies.createPublicClient ?? defaultPublicClientFactory;
  const walletClientFactory = dependencies.createWalletClient ?? defaultWalletClientFactory;
  const normalizedReceiver = getAddress(receiver);

  const watcherAccounts = await secretStage('Watcher credential loading', () => Promise.all(
    watcherCredentials.map((credential) => watcherLoader(credential)),
  ));
  invariant(
    new Set(watcherAccounts.map(({ address }) => getAddress(address).toLowerCase())).size === 2,
    'Watcher keystores must resolve to two distinct accounts',
  );

  const signedWatchers = await Promise.all(watcherAccounts.map(async (account, index) => {
    const watcher = getAddress(account.address);
    const { result } = await secretStage(`Watcher ${index + 1} finalized GenLayer result read`, () => sourceReader({
      resolver,
      txHash,
      requestId,
    }));
    const attestation = await secretStage(`Watcher ${index + 1} creator attestation construction`, async () => (
      buildAttestation({
        result,
        resolver,
        txHash,
        receiver: normalizedReceiver,
        chainId: baseSepolia.id,
      })
    ));
    invariant(attestation.primaryType === 'CreatorVerification',
      'The finalized GenLayer result is not a creator verification');
    const watcherClient = publicClientFactory({
      rpcUrl,
      purpose: 'watcher-verification',
      watcher,
      watcherIndex: index,
    });
    await secretStage(`Watcher ${index + 1} ownership authorization`, () => authorizationVerifier({
      publicClient: watcherClient,
      attestation,
      ownershipSignature: ownershipIntentSignature,
      receiver: normalizedReceiver,
      resolver,
      watcher,
      expectedChainId: baseSepolia.id,
    }));
    const signature = await secretStage(`Watcher ${index + 1} attestation signing`, () => (
      account.signTypedData(attestation)
    ));
    const recovered = await secretStage(`Watcher ${index + 1} signature recovery`, () => (
      recoverBundleSigner(attestation, signature)
    ));
    invariant(getAddress(recovered) === watcher, `Watcher ${index + 1} signature does not match its keystore`);
    return {
      address: watcher,
      signature,
      attestation,
      attestationKey: canonicalJson(attestation),
    };
  }));
  invariant(
    signedWatchers.every(({ attestationKey }) => attestationKey === signedWatchers[0].attestationKey),
    'Independent watchers derived different finalized attestations',
  );
  const attestation = signedWatchers[0].attestation;
  signedWatchers.sort((left, right) => (
    left.address.toLowerCase().localeCompare(right.address.toLowerCase())
  ));

  const publicClient = publicClientFactory({ rpcUrl, purpose: 'relay-simulation' });
  const actualChainId = await secretStage('Base network check', () => publicClient.getChainId());
  invariant(actualChainId === baseSepolia.id, 'Relay RPC is not Base Sepolia');
  const [threshold, watcherCount] = await secretStage('Receiver watcher configuration read', () => Promise.all([
    publicClient.readContract({
      address: normalizedReceiver,
      abi: CREATOR_RELAY_ABI,
      functionName: 'threshold',
    }),
    publicClient.readContract({
      address: normalizedReceiver,
      abi: CREATOR_RELAY_ABI,
      functionName: 'watcherCount',
    }),
  ]));
  invariant(BigInt(threshold) === 2n && BigInt(watcherCount) >= 3n,
    'Receiver is not configured for the required 2-of-3-or-more watcher quorum');

  const args = [
    attestation.message,
    ownershipIntentSignature,
    signedWatchers.map(({ signature }) => signature),
  ];
  const simulatedSender = getAddress(simulationAccount);
  const simulation = await secretStage('Base creator relay simulation', () => publicClient.simulateContract({
    account: simulatedSender,
    address: normalizedReceiver,
    abi: CREATOR_RELAY_ABI,
    functionName: 'submitCreatorVerification',
    args,
  }));
  invariant(simulation?.request, 'Base creator relay simulation returned no transaction request');

  const safeBaseResult = Object.freeze({
    network: 'base-sepolia',
    chainId: baseSepolia.id,
    receiver: normalizedReceiver,
    requestId: requestId.toLowerCase(),
    functionName: 'submitCreatorVerification',
    watchers: signedWatchers.map(({ address }) => address),
    simulationAccount: simulatedSender,
    status: 'SIMULATED',
    broadcast: false,
  });
  return createBroadcastGate({
    safeBaseResult,
    simulatedRequest: simulation.request,
    simulatedSender,
    publicClient,
    rpcUrl,
    defaultRelayerLoader,
    walletClientFactory,
  });
}

/** One-shot wrapper for callers that do not need to retain the broadcast gate. */
export async function orchestrateBaseSepoliaCreatorRelay({
  broadcast = false,
  broadcastConfirmation,
  loadRelayerAccount,
  ...input
}) {
  invariant(typeof broadcast === 'boolean', 'broadcast must be a boolean');
  const prepared = await prepareBaseSepoliaCreatorRelay(input);
  try {
    if (!broadcast) return prepared.summary;
    return await prepared.broadcast({
      confirmation: broadcastConfirmation,
      ...(loadRelayerAccount ? { loadRelayerAccount } : {}),
    });
  } finally {
    prepared.dispose();
  }
}
