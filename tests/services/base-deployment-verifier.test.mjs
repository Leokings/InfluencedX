import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { encodeDeployData, encodeFunctionData, getAddress } from 'viem';

import { verifyBaseSepoliaDeployment } from '../../scripts/lib/base-deployment-verifier.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(
  path.join(projectRoot, 'deployments', 'base-sepolia.json'),
  'utf8',
));
const artifacts = {
  registry: JSON.parse(fs.readFileSync(
    path.join(projectRoot, 'artifacts', 'base', 'AdProofCreatorRegistry.json'),
    'utf8',
  )),
  escrow: JSON.parse(fs.readFileSync(
    path.join(projectRoot, 'artifacts', 'base', 'AdProofEscrow.json'),
    'utf8',
  )),
  receiver: JSON.parse(fs.readFileSync(
    path.join(projectRoot, 'artifacts', 'base', 'AdProofAttestationReceiver.json'),
    'utf8',
  )),
};
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function deploymentArguments(key) {
  if (key === 'registry') return [manifest.initialOwner];
  if (key === 'escrow') {
    return [
      manifest.initialOwner,
      manifest.usdc,
      manifest.contracts.registry.address,
      manifest.treasury,
      manifest.feeBps,
    ];
  }
  return [
    manifest.initialOwner,
    manifest.contracts.registry.address,
    manifest.contracts.escrow.address,
    manifest.initialGenlayerContract ?? manifest.genlayerContract,
    manifest.watchers,
    BigInt(manifest.threshold),
  ];
}

function mockClient({ registryReceiptAddress, disabledWatcher } = {}) {
  const deploymentsByHash = new Map(Object.entries(manifest.contracts).map(([key, deployment]) => [
    deployment.transactionHash.toLowerCase(),
    { key, deployment },
  ]));
  const wiringByHash = new Map([
    [manifest.wiringTransactions.registry.toLowerCase(), {
      key: 'registry',
      blockNumber: 45_242_276n,
      functionName: 'setAttestationReceiver',
      args: [manifest.contracts.receiver.address],
      target: manifest.contracts.registry.address,
    }],
    [manifest.wiringTransactions.escrow.toLowerCase(), {
      key: 'escrow',
      blockNumber: 45_242_277n,
      functionName: 'setResolutionReceiver',
      args: [manifest.contracts.receiver.address],
      target: manifest.contracts.escrow.address,
    }],
  ]);
  if (manifest.resolverUpdate) {
    wiringByHash.set(manifest.resolverUpdate.transactionHash.toLowerCase(), {
      key: 'receiver',
      blockNumber: BigInt(manifest.resolverUpdate.blockNumber),
      functionName: 'setGenLayerContract',
      args: [manifest.genlayerContract],
      target: manifest.contracts.receiver.address,
      from: manifest.finalOwner,
    });
  }

  return {
    getChainId: async () => 84_532,
    getBlockNumber: async () => 45_242_300n,
    getCode: async ({ address }) => {
      if (address.toLowerCase() === manifest.usdc.toLowerCase()) return '0x60006000';
      for (const [key, deployment] of Object.entries(manifest.contracts)) {
        if (address.toLowerCase() === deployment.address.toLowerCase()) return artifacts[key].deployedBytecode;
      }
      return '0x';
    },
    getTransactionReceipt: async ({ hash }) => {
      const deploymentRecord = deploymentsByHash.get(hash.toLowerCase());
      if (deploymentRecord) {
        const { key, deployment } = deploymentRecord;
        return {
          transactionHash: hash,
          status: 'success',
          contractAddress: key === 'registry' && registryReceiptAddress
            ? registryReceiptAddress
            : deployment.address,
          blockNumber: BigInt(deployment.blockNumber),
          from: manifest.deployer,
          to: null,
        };
      }
      const wiring = wiringByHash.get(hash.toLowerCase());
      if (!wiring) throw new Error(`unexpected receipt ${hash}`);
      return {
        transactionHash: hash,
        status: 'success',
        contractAddress: null,
        blockNumber: wiring.blockNumber,
        from: wiring.from ?? manifest.deployer,
        to: wiring.target,
      };
    },
    getTransaction: async ({ hash }) => {
      const deploymentRecord = deploymentsByHash.get(hash.toLowerCase());
      if (deploymentRecord) {
        const { key, deployment } = deploymentRecord;
        return {
          hash,
          from: manifest.deployer,
          to: null,
          blockNumber: BigInt(deployment.blockNumber),
          nonce: BigInt(['registry', 'escrow', 'receiver'].indexOf(key)),
          input: encodeDeployData({
            abi: artifacts[key].abi,
            bytecode: artifacts[key].bytecode,
            args: deploymentArguments(key),
          }),
        };
      }
      const wiring = wiringByHash.get(hash.toLowerCase());
      if (!wiring) throw new Error(`unexpected transaction ${hash}`);
      return {
        hash,
        from: wiring.from ?? manifest.deployer,
        to: wiring.target,
        blockNumber: wiring.blockNumber,
        nonce: 3n,
        input: encodeFunctionData({
          abi: artifacts[wiring.key].abi,
          functionName: wiring.functionName,
          args: wiring.args,
        }),
      };
    },
    readContract: async ({ address, functionName, args = [] }) => {
      const normalized = getAddress(address);
      if (normalized === getAddress(manifest.contracts.registry.address)) {
        if (functionName === 'owner') return manifest.finalOwner;
        if (functionName === 'pendingOwner') return ZERO_ADDRESS;
        if (functionName === 'attestationReceiver') return manifest.contracts.receiver.address;
      }
      if (normalized === getAddress(manifest.contracts.escrow.address)) {
        if (functionName === 'owner') return manifest.finalOwner;
        if (functionName === 'pendingOwner') return ZERO_ADDRESS;
        if (functionName === 'usdc') return manifest.usdc;
        if (functionName === 'creatorRegistry') return manifest.contracts.registry.address;
        if (functionName === 'treasury') return manifest.treasury;
        if (functionName === 'protocolFeeBps') return BigInt(manifest.feeBps);
        if (functionName === 'resolutionReceiver') return manifest.contracts.receiver.address;
        if (functionName === 'paused') return false;
      }
      if (normalized === getAddress(manifest.contracts.receiver.address)) {
        if (functionName === 'owner') return manifest.finalOwner;
        if (functionName === 'pendingOwner') return ZERO_ADDRESS;
        if (functionName === 'creatorRegistry') return manifest.contracts.registry.address;
        if (functionName === 'escrow') return manifest.contracts.escrow.address;
        if (functionName === 'genlayerContract') return manifest.genlayerContract;
        if (functionName === 'threshold') return BigInt(manifest.threshold);
        if (functionName === 'watcherCount') return BigInt(manifest.watchers.length);
        if (functionName === 'paused') return false;
        if (functionName === 'isWatcher') {
          return !disabledWatcher || args[0].toLowerCase() !== disabledWatcher.toLowerCase();
        }
      }
      throw new Error(`unexpected read ${address} ${functionName}`);
    },
  };
}

test('verifies receipts, exact deployment inputs, runtime code, wiring, and configuration', async () => {
  const evidence = await verifyBaseSepoliaDeployment({
    manifest,
    artifacts,
    publicClient: mockClient(),
    now: () => new Date('2026-08-09T06:30:00.000Z'),
  });

  assert.equal(evidence.ok, true);
  assert.equal(evidence.network.chainId, 84_532);
  assert.equal(evidence.contracts.registry.runtimeVerification, 'exact');
  assert.equal(evidence.configuration.escrow.protocolFeeBps, 250);
  assert.equal(evidence.configuration.receiver.threshold, 2);
  assert.equal(evidence.configuration.receiver.watchers.length, 3);
  assert.ok(evidence.configuration.receiver.watchers.every(({ enabled }) => enabled));
});

test('rejects a deployment receipt whose contract address differs from the manifest', async () => {
  await assert.rejects(
    verifyBaseSepoliaDeployment({
      manifest,
      artifacts,
      publicClient: mockClient({ registryReceiptAddress: manifest.contracts.escrow.address }),
    }),
    /registry receipt contract address differs from manifest/,
  );
});

test('rejects a configured watcher that is not enabled on the receiver', async () => {
  await assert.rejects(
    verifyBaseSepoliaDeployment({
      manifest,
      artifacts,
      publicClient: mockClient({ disabledWatcher: manifest.watchers[1] }),
    }),
    new RegExp(`watcher ${manifest.watchers[1]} is not enabled`, 'i'),
  );
});

test('verification CLI contains no signer or write path', () => {
  const cli = fs.readFileSync(path.join(projectRoot, 'scripts', 'verify-base-sepolia.mjs'), 'utf8');
  const verifier = fs.readFileSync(
    path.join(projectRoot, 'scripts', 'lib', 'base-deployment-verifier.mjs'),
    'utf8',
  );
  const source = `${cli}\n${verifier}`;
  assert.doesNotMatch(source, /createWalletClient|deployContract|writeContract|sendTransaction|sendRawTransaction/);
});

test('StudioNet cutover requires the exact ceremony confirmation before every mutation path', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'scripts', 'cutover-base-receiver-studionet.mjs'),
    'utf8',
  );

  assert.match(source, /const CONFIRMATION = 'CUT OVER INFLUENCEDX TO STUDIONET'/);
  assert.match(
    source,
    /if \(currentContract\.toLowerCase\(\) === oldContract\.toLowerCase\(\)\) \{[\s\S]*?await requireMutationConfirmation\([\s\S]*?await write\('setGenLayerContract'/,
  );
  assert.match(
    source,
    /if \(pausedAfterUpdate\) \{\s*await requireMutationConfirmation\([\s\S]*?await write\('unpause'\)/,
  );
});
