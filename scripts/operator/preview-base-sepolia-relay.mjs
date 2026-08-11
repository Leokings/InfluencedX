import readline from 'node:readline/promises';

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  zeroHash,
} from 'viem';
import { baseSepolia } from 'viem/chains';

import {
  buildAttestation,
  genLayerAddressToBytes32,
} from '../../src/relay/attestations.mjs';
import { readFinalizedGenLayerResult } from '../../src/relay/genlayer-source.mjs';
import {
  BASE_SEPOLIA_RELAY_CONFIRMATION,
  prepareBaseSepoliaCreatorRelay,
} from '../../src/relay/in-memory-base-relay.mjs';
import { verifyCreatorOwnershipAuthorization } from '../../src/relay/ownership-authorization.mjs';
import { loadBaseSepoliaRelayer } from '../lib/base-relayer-account.mjs';
import {
  createOwnershipAuthorizationMaterial,
  decryptOwnershipAuthorization,
  requestOwnershipAuthorizationCiphertext,
} from './preview-authorization-client.mjs';
import { PreviewRelayStore } from './preview-relay-store.mjs';

const PREFLIGHT_RECEIVER_ABI = parseAbi([
  'function creatorRegistry() view returns (address)',
  'function genlayerContract() view returns (bytes32)',
  'function paused() view returns (bool)',
  'function threshold() view returns (uint256)',
  'function watcherCount() view returns (uint256)',
  'function isWatcher(address) view returns (bool)',
  'function usedAttestations(bytes32) view returns (bool)',
]);

const REGISTRY_ABI = parseAbi([
  'function attestationReceiver() view returns (address)',
  'function getProfile(address wallet) view returns ((uint256 profileId,address wallet,bytes32 identityHash,bytes32 handleHash,bytes32 verificationPostHash,bytes32 metricsHash,uint64 verifiedAt,uint64 expiresAt,uint64 metricsMeasuredAt,uint64 metricsExpiresAt,bool active) profile)',
  'function isVerified(address wallet,bytes32 identityHash) view returns (bool)',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function secretStageError(stage) {
  return new Error(`${stage} failed without exposing ceremony secrets`);
}

async function secretStage(stage, operation) {
  try {
    return await operation();
  } catch {
    throw secretStageError(stage);
  }
}

export function bindingFromRelayConfiguration(configuration) {
  return Object.freeze({
    requestId: configuration.requestId.toLowerCase(),
    genlayerTxHash: configuration.genlayerTxHash.toLowerCase(),
    resolver: getAddress(configuration.resolver),
    baseReceiver: getAddress(configuration.baseReceiver),
    baseRegistry: getAddress(configuration.baseRegistry),
    expectedWallet: getAddress(configuration.expectedWallet),
  });
}

function defaultPublicClient(configuration) {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(configuration.rpcUrl),
  });
}

export async function preflightExactPublicProof({
  configuration,
  binding,
  nowMs,
  dependencies = {},
}) {
  const sourceReader = dependencies.readFinalizedGenLayerResult ?? readFinalizedGenLayerResult;
  const publicClient = dependencies.publicClient ?? defaultPublicClient(configuration);
  const { receipt, result } = await sourceReader({
    resolver: binding.resolver,
    txHash: binding.genlayerTxHash,
    requestId: binding.requestId,
  });
  invariant(receipt?.statusName === 'FINALIZED', 'GenLayer lifecycle is not FINALIZED');
  invariant(receipt?.txExecutionResultName === 'FINISHED_WITH_RETURN',
    'GenLayer execution did not finish with a return value');
  const attestation = buildAttestation({
    result,
    resolver: binding.resolver,
    txHash: binding.genlayerTxHash,
    receiver: binding.baseReceiver,
    chainId: configuration.chainId,
  });
  invariant(attestation.primaryType === 'CreatorVerification',
    'The finalized proof is not a creator verification');
  invariant(attestation.message.attestationId === binding.requestId,
    'The finalized proof request binding changed');
  invariant(getAddress(attestation.message.wallet) === binding.expectedWallet,
    'The finalized proof wallet binding changed');

  const chainId = await publicClient.getChainId();
  invariant(chainId === configuration.chainId, 'The relay RPC is not Base Sepolia');
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  const blockTimestamp = BigInt(block.timestamp);
  invariant(blockTimestamp <= attestation.message.relayDeadline,
    'The one-proof Base relay window has expired');
  invariant(blockTimestamp < attestation.message.expiresAt,
    'The creator credential is already expired');
  invariant(BigInt(Math.floor(nowMs / 1_000)) <= attestation.message.relayDeadline,
    'The local clock is beyond the one-proof relay window');

  const readReceiver = (functionName, args = []) => publicClient.readContract({
    address: binding.baseReceiver,
    abi: PREFLIGHT_RECEIVER_ABI,
    functionName,
    args,
    blockNumber: block.number,
  });
  const readRegistry = (functionName, args = []) => publicClient.readContract({
    address: binding.baseRegistry,
    abi: REGISTRY_ABI,
    functionName,
    args,
    blockNumber: block.number,
  });
  const [
    registry,
    configuredResolver,
    paused,
    threshold,
    watcherCount,
    watcherOne,
    watcherTwo,
    attestationUsed,
    registryReceiver,
    alreadyVerified,
  ] = await Promise.all([
    readReceiver('creatorRegistry'),
    readReceiver('genlayerContract'),
    readReceiver('paused'),
    readReceiver('threshold'),
    readReceiver('watcherCount'),
    readReceiver('isWatcher', [configuration.expectedWatchers[0]]),
    readReceiver('isWatcher', [configuration.expectedWatchers[1]]),
    readReceiver('usedAttestations', [binding.requestId]),
    readRegistry('attestationReceiver'),
    readRegistry('isVerified', [binding.expectedWallet, attestation.message.identityHash]),
  ]);
  invariant(getAddress(registry) === binding.baseRegistry,
    'The Base receiver points to a different creator registry');
  invariant(getAddress(registryReceiver) === binding.baseReceiver,
    'The Base registry points to a different attestation receiver');
  invariant(configuredResolver.toLowerCase() === genLayerAddressToBytes32(binding.resolver),
    'The Base receiver points to a different GenLayer resolver');
  invariant(paused === false, 'The Base receiver is paused');
  invariant(BigInt(threshold) === 2n && BigInt(watcherCount) >= 3n,
    'The Base receiver is not configured for 2-of-3-or-more quorum');
  invariant(watcherOne === true && watcherTwo === true,
    'The two ceremony watchers are not enabled');
  invariant(attestationUsed === false, 'The exact creator attestation was already relayed');
  invariant(alreadyVerified === false,
    'The creator profile is already verified and requires reconciliation, not a new relay');
  return Object.freeze({ attestation, publicClient });
}

export async function verifyDecryptedCreatorAuthorization({
  authorization,
  publicPreflight,
  configuration,
  binding,
  verifier = verifyCreatorOwnershipAuthorization,
}) {
  return verifier({
    publicClient: publicPreflight.publicClient,
    attestation: publicPreflight.attestation,
    ownershipSignature: authorization,
    receiver: binding.baseReceiver,
    resolver: binding.resolver,
    watcher: configuration.expectedWatchers[0],
    expectedChainId: configuration.chainId,
  });
}

export async function readConfirmedCreatorProfile({
  publicClient,
  binding,
  attestation,
}) {
  const [profile, verified] = await Promise.all([
    publicClient.readContract({
      address: binding.baseRegistry,
      abi: REGISTRY_ABI,
      functionName: 'getProfile',
      args: [binding.expectedWallet],
    }),
    publicClient.readContract({
      address: binding.baseRegistry,
      abi: REGISTRY_ABI,
      functionName: 'isVerified',
      args: [binding.expectedWallet, attestation.message.identityHash],
    }),
  ]);
  const exact = BigInt(profile.profileId) > 0n
    && getAddress(profile.wallet) === binding.expectedWallet
    && profile.identityHash.toLowerCase() === attestation.message.identityHash.toLowerCase()
    && profile.handleHash.toLowerCase() === attestation.message.handleHash.toLowerCase()
    && profile.verificationPostHash.toLowerCase()
      === attestation.message.verificationPostHash.toLowerCase()
    && profile.metricsHash.toLowerCase() === zeroHash
    && BigInt(profile.verifiedAt) === attestation.message.verifiedAt
    && BigInt(profile.expiresAt) === attestation.message.expiresAt
    && profile.active === true
    && verified === true;
  invariant(exact, 'The confirmed transaction did not produce the exact verified creator profile');
  const expiresAtMs = Number(BigInt(profile.expiresAt) * 1_000n);
  invariant(Number.isSafeInteger(expiresAtMs), 'The Base profile expiry cannot be represented safely');
  return Object.freeze({
    profileId: BigInt(profile.profileId).toString(),
    identityHash: profile.identityHash.toLowerCase(),
    handleHash: profile.handleHash.toLowerCase(),
    verificationPostHash: profile.verificationPostHash.toLowerCase(),
    expiresAtMs,
  });
}

export async function promptForExactRelayConfirmation({
  input = process.stdin,
  output = process.stderr,
} = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('Broadcast confirmation requires a real interactive terminal');
  }
  const terminal = readline.createInterface({ input, output });
  try {
    output.write('STEP 1 OF 2 — this is the broadcast confirmation, not the password.\n');
    output.write('After it is accepted, STEP 2 asks for the hidden keystore password.\n');
    return await terminal.question(
      `Type ${BASE_SEPOLIA_RELAY_CONFIRMATION} to broadcast: `,
    );
  } finally {
    terminal.close();
  }
}

function defaultRelayerLoader(configuration) {
  return loadBaseSepoliaRelayer({
    env: {
      BASE_RELAYER_KEYSTORE_PATH: configuration.relayerKeystorePath,
    },
  });
}

export async function runPreviewBaseSepoliaRelay({
  configuration,
  previewUrl,
  databaseUrl,
  output = process.stdout,
  dependencies = {},
}) {
  const now = dependencies.now ?? (() => Date.now());
  const binding = bindingFromRelayConfiguration(configuration);
  const store = dependencies.store ?? new PreviewRelayStore({ databaseUrl });
  const createMaterial = dependencies.createAuthorizationMaterial
    ?? createOwnershipAuthorizationMaterial;
  const requestAuthorization = dependencies.requestAuthorizationCiphertext
    ?? requestOwnershipAuthorizationCiphertext;
  const decryptAuthorization = dependencies.decryptAuthorization
    ?? decryptOwnershipAuthorization;
  const preflightPublic = dependencies.preflightPublic ?? preflightExactPublicProof;
  const verifyAuthorization = dependencies.verifyAuthorization
    ?? verifyDecryptedCreatorAuthorization;
  const prepareRelay = dependencies.prepareRelay ?? prepareBaseSepoliaCreatorRelay;
  const promptConfirmation = dependencies.promptConfirmation ?? promptForExactRelayConfirmation;
  const loadRelayer = dependencies.loadRelayerAccount
    ?? (() => defaultRelayerLoader(configuration));
  const verifyProfile = dependencies.verifyProfile ?? readConfirmedCreatorProfile;
  const walletClientFactory = dependencies.createWalletClient
    ?? (({ account, rpcUrl }) => createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(rpcUrl),
    }));

  let material;
  let authorization;
  let prepared;
  let grantInserted = false;
  let broadcasting = false;
  let writeAttempted = false;
  let transactionHash = null;
  try {
    await secretStage('Preview database connection', () => store.connect());
    const publicPreflight = await preflightPublic({
      configuration,
      binding,
      nowMs: now(),
      dependencies: dependencies.publicPreflightDependencies,
    });
    await secretStage('Exact Preview proof precheck', () => store.readExactState(binding, now()));

    material = await secretStage('Ephemeral authorization creation', () => createMaterial({
      binding,
      nowMs: now(),
      ttlMs: configuration.grantTtlMs,
    }));
    await secretStage('One-time authorization grant insertion', () => store.createGrantAndMarkQuorum({
      grant: material.grant,
      binding,
      nowMs: now(),
    }));
    grantInserted = true;

    const ciphertext = await secretStage('Preview authorization broker', () => requestAuthorization({
      previewUrl,
      brokerPath: configuration.brokerPath,
      projectId: configuration.vercelProjectId,
      teamSlug: configuration.vercelTeamSlug,
      binding,
      token: material.token,
      publicJwk: material.publicJwk,
    }));
    authorization = await secretStage('Ownership authorization decryption', () => decryptAuthorization({
      ciphertext,
      privateKey: material.privateKey,
      publicJwk: material.publicJwk,
      binding,
    }));
    material.token = undefined;
    await secretStage('Creator authorization precheck', () => verifyAuthorization({
      authorization,
      publicPreflight,
      configuration,
      binding,
    }));

    const relayState = { transactionHash: null };
    prepared = await secretStage('Watcher quorum and Base simulation', () => prepareRelay({
      ownershipIntentSignature: authorization,
      resolver: binding.resolver,
      txHash: binding.genlayerTxHash,
      requestId: binding.requestId,
      receiver: binding.baseReceiver,
      watcherCredentials: configuration.watcherCredentials,
      simulationAccount: configuration.simulationAccount,
      rpcUrl: configuration.rpcUrl,
      dependencies: {
        ...(dependencies.relayDependencies ?? {}),
        createWalletClient: ({ account, rpcUrl }) => {
          const client = walletClientFactory({ account, rpcUrl });
          return {
            writeContract: async (request) => {
              writeAttempted = true;
              const hash = await client.writeContract(request);
              transactionHash = hash.toLowerCase();
              relayState.transactionHash = transactionHash;
              await store.recordBroadcastHash({
                binding,
                transactionHash,
                nowMs: now(),
              });
              return hash;
            },
          };
        },
      },
    }));
    output.write(`${JSON.stringify(prepared.summary)}\n`);
    const confirmation = await promptConfirmation();
    if (confirmation !== BASE_SEPOLIA_RELAY_CONFIRMATION) {
      throw new Error('Base Sepolia broadcast was cancelled; the proof remains retryable');
    }

    let broadcastResult;
    try {
      broadcastResult = await prepared.broadcast({
        confirmation,
        loadRelayerAccount: async () => {
          const account = await loadRelayer();
          await secretStage('BROADCASTING state fence', () => store.markBroadcasting({
            binding,
            nowMs: now(),
          }));
          broadcasting = true;
          return account;
        },
      });
    } catch (error) {
      if (!broadcasting) {
        throw new Error('The Base relayer was not loaded; the proof remains retryable');
      }
      throw error;
    }
    transactionHash = broadcastResult.hash.toLowerCase();
    invariant(relayState.transactionHash === transactionHash,
      'The confirmed transaction hash does not match the fenced broadcast');
    const profile = await secretStage('Base creator registry confirmation', () => verifyProfile({
      publicClient: publicPreflight.publicClient,
      binding,
      attestation: publicPreflight.attestation,
      transactionHash,
    }));
    await secretStage('Base confirmation persistence', () => store.markConfirmed({
      binding,
      transactionHash,
      profile,
      nowMs: now(),
    }));
    broadcasting = false;
    const safeResult = Object.freeze({
      ...broadcastResult,
      registry: binding.baseRegistry,
      wallet: binding.expectedWallet,
      profileId: profile.profileId,
      baseVerified: true,
    });
    output.write(`${JSON.stringify(safeResult)}\n`);
    return safeResult;
  } catch (error) {
    if (broadcasting || writeAttempted || transactionHash) {
      try {
        await store.markReconciliationRequired({
          binding,
          transactionHash,
          nowMs: now(),
        });
      } catch {
        throw new Error('Base relay state is uncertain and database reconciliation also failed');
      }
      throw new Error(
        transactionHash
          ? `Base relay requires reconciliation by transaction hash ${transactionHash}`
          : 'Base relay requires reconciliation before any retry',
      );
    }
    throw error;
  } finally {
    prepared?.dispose();
    authorization = undefined;
    if (material) material.token = undefined;
    if (grantInserted && material?.grant?.tokenHash) {
      await store.deleteGrantIfUnconsumed(material.grant.tokenHash).catch(() => {});
    }
    await store.close().catch(() => {});
  }
}
