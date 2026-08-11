import {
  getAddress,
  hashTypedData,
  isAddressEqual,
  isHex,
  parseAbi,
} from 'viem';

import {
  buildOwnershipIntent,
  genLayerAddressToBytes32,
  RELAY_WINDOW_SECONDS,
} from './attestations.mjs';

const RECEIVER_AUTHORIZATION_ABI = parseAbi([
  'function genlayerContract() view returns (bytes32)',
  'function isWatcher(address) view returns (bool)',
  'function paused() view returns (bool)',
  'function usedAttestations(bytes32) view returns (bool)',
  'function usedOwnershipIntents(bytes32) view returns (bool)',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function uint(value, label) {
  let result;
  try {
    result = BigInt(value);
  } catch {
    throw new Error(`${label} must be an integer`);
  }
  invariant(result >= 0n, `${label} must be non-negative`);
  return result;
}

/**
 * Independently verifies the creator authorization a watcher is about to
 * attest. Reads are pinned to one Base block so smart-account validation and
 * replay/configuration checks are evaluated against the same chain state.
 */
export async function verifyCreatorOwnershipAuthorization({
  publicClient,
  attestation,
  ownershipSignature,
  receiver,
  resolver,
  watcher,
  expectedChainId,
}) {
  invariant(publicClient, 'Base public client is required');
  invariant(attestation?.primaryType === 'CreatorVerification', 'CreatorVerification attestation is required');
  invariant(isHex(ownershipSignature ?? '') && ownershipSignature !== '0x', 'Creator ownership signature is required');

  const normalizedReceiver = getAddress(receiver);
  const normalizedWatcher = getAddress(watcher);
  const domainChainId = Number(attestation.domain?.chainId);
  invariant(Number.isSafeInteger(expectedChainId) && expectedChainId > 0, 'Expected Base chain ID is invalid');
  invariant(domainChainId === expectedChainId, 'Ownership authorization targets the wrong Base chain');
  invariant(
    isAddressEqual(attestation.domain?.verifyingContract, normalizedReceiver),
    'Ownership authorization targets the wrong Base receiver',
  );

  const expectedResolver = genLayerAddressToBytes32(resolver);
  invariant(
    attestation.message?.genlayerContract?.toLowerCase() === expectedResolver,
    'Ownership authorization targets the wrong GenLayer resolver',
  );

  const ownershipIntent = buildOwnershipIntent({
    attestation,
    receiver: normalizedReceiver,
    chainId: expectedChainId,
  });
  const intentDigest = hashTypedData(ownershipIntent);

  const actualChainId = await publicClient.getChainId();
  invariant(actualChainId === expectedChainId, 'Base RPC is connected to the wrong chain');
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  invariant(block?.number !== null && block?.number !== undefined, 'Latest Base block has no number');
  const blockNumber = block.number;
  const blockTimestamp = uint(block.timestamp, 'Latest Base block timestamp');

  const verifiedAt = uint(attestation.message?.verifiedAt, 'Creator verification timestamp');
  const expiresAt = uint(attestation.message?.expiresAt, 'Creator credential expiry');
  const relayDeadline = uint(attestation.message?.relayDeadline, 'Creator relay deadline');
  invariant(expiresAt > verifiedAt, 'Creator credential validity window is invalid');
  invariant(verifiedAt <= blockTimestamp, 'Creator verification timestamp is in the future');
  invariant(expiresAt > blockTimestamp, 'Creator ownership authorization has expired');
  invariant(
    relayDeadline === verifiedAt + BigInt(RELAY_WINDOW_SECONDS),
    'Creator relay deadline does not match the protocol window',
  );
  invariant(relayDeadline >= blockTimestamp, 'Creator verification relay window has expired');

  const read = (functionName, args = []) => publicClient.readContract({
    address: normalizedReceiver,
    abi: RECEIVER_AUTHORIZATION_ABI,
    functionName,
    args,
    blockNumber,
  });
  const [configuredResolver, receiverPaused, watcherEnabled, attestationUsed, intentUsed] = await Promise.all([
    read('genlayerContract'),
    read('paused'),
    read('isWatcher', [normalizedWatcher]),
    read('usedAttestations', [attestation.message.attestationId]),
    read('usedOwnershipIntents', [intentDigest]),
  ]);
  invariant(configuredResolver.toLowerCase() === expectedResolver, 'Base receiver is configured for a different GenLayer resolver');
  invariant(receiverPaused === false, 'Base receiver is paused');
  invariant(watcherEnabled === true, 'Watcher is not enabled on the Base receiver');
  invariant(attestationUsed === false, 'Creator verification attestation was already relayed');
  invariant(intentUsed === false, 'Creator ownership authorization was already consumed');

  const signatureValid = await publicClient.verifyTypedData({
    address: attestation.message.wallet,
    ...ownershipIntent,
    signature: ownershipSignature,
    blockNumber,
  });
  invariant(signatureValid, 'Creator ownership signature is invalid for the finalized verification');

  return {
    ownershipIntent,
    intentDigest,
    verifiedAtBlockNumber: blockNumber,
  };
}
