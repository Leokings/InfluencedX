import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import ganache from 'ganache';
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  keccak256,
  stringToHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  buildAttestation,
  buildOwnershipIntent,
} from '../../src/relay/attestations.mjs';
import { verifyCreatorOwnershipAuthorization } from '../../src/relay/ownership-authorization.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const artifact = (name) => JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'artifacts', 'base', `${name}.json`), 'utf8'),
);

const localChain = defineChain({
  id: 31_337,
  name: 'Watcher authorization test EVM',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1'] } },
});
const provider = ganache.provider({
  chain: { chainId: localChain.id, hardfork: 'shanghai' },
  logging: { quiet: true },
  wallet: { totalAccounts: 10, defaultBalance: 1_000 },
});
test.after(() => provider.disconnect());

const accounts = Object.values(provider.getInitialAccounts()).map(({ secretKey }) => privateKeyToAccount(secretKey));
const [owner, creator, watcherA, watcherB, watcherC, outsider] = accounts;
const transport = custom(provider);
const publicClient = createPublicClient({ chain: localChain, transport });
const walletClient = createWalletClient({ account: owner, chain: localChain, transport });
const resolver = `0x${'22'.repeat(20)}`;
const resolverBytes32 = `0x${'00'.repeat(12)}${'22'.repeat(20)}`;
const txHash = `0x${'44'.repeat(32)}`;

async function deploy(name, args = []) {
  const contract = artifact(name);
  const hash = await walletClient.deployContract({ abi: contract.abi, bytecode: contract.bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  return receipt.contractAddress;
}

const receiver = await deploy('AdProofAttestationReceiver', [
  owner.address,
  accounts[6].address,
  accounts[7].address,
  resolverBytes32,
  [watcherA.address, watcherB.address, watcherC.address],
  2n,
]);

function ownershipResult({ wallet = creator.address, verifiedAt, expiresAt, suffix = 'valid' }) {
  return {
    kind: 'OWNERSHIP',
    request_id: keccak256(stringToHex(`request:${suffix}`)),
    base_wallet: wallet,
    identity_hash: keccak256(stringToHex(`identity:${suffix}`)),
    handle: `Creator_${suffix}`,
    post_id: `1900000000000000${suffix.length}`,
    challenge_hash: keccak256(stringToHex(`challenge:${suffix}`)),
    verified_at_epoch: verifiedAt,
    credential_expires_at_epoch: expiresAt,
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
  };
}

async function fixture({ wallet = creator.address, signer = creator, suffix = 'valid', verifiedAt, expiresAt } = {}) {
  const now = Number((await publicClient.getBlock()).timestamp);
  const bundle = buildAttestation({
    result: ownershipResult({
      wallet,
      suffix,
      verifiedAt: verifiedAt ?? now,
      expiresAt: expiresAt ?? now + 7_200,
    }),
    resolver,
    txHash,
    receiver,
    chainId: localChain.id,
  });
  const ownershipIntent = buildOwnershipIntent({
    attestation: bundle,
    receiver,
    chainId: localChain.id,
  });
  return {
    bundle,
    ownershipSignature: await signer.signTypedData(ownershipIntent),
  };
}

function verify({ bundle, ownershipSignature, client = publicClient, watcher = watcherA.address }) {
  return verifyCreatorOwnershipAuthorization({
    publicClient: client,
    attestation: bundle,
    ownershipSignature,
    receiver,
    resolver,
    watcher,
    expectedChainId: localChain.id,
  });
}

test('watcher accepts an EOA signature only for the exact finalized ownership intent', async () => {
  const authorization = await fixture();
  const verified = await verify(authorization);
  assert.equal(verified.ownershipIntent.message.wallet, creator.address);
  assert.match(verified.intentDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(typeof verified.verifiedAtBlockNumber, 'bigint');
});

test('watcher accepts a deployed EIP-1271 wallet authorized by its signer', async () => {
  const contractWallet = await deploy('Mock1271', [creator.address]);
  const authorization = await fixture({
    wallet: contractWallet,
    signer: creator,
    suffix: 'eip1271',
  });
  const verified = await verify(authorization);
  assert.equal(verified.ownershipIntent.message.wallet.toLowerCase(), contractWallet.toLowerCase());

  const wrongAuthorization = await fixture({
    wallet: contractWallet,
    signer: outsider,
    suffix: 'eip1271-wrong-signer',
  });
  await assert.rejects(verify(wrongAuthorization), /Creator ownership signature is invalid/);
});

test('watcher rejects missing authorization and every creator-bound field mutation', async () => {
  const authorization = await fixture({ suffix: 'mutations' });
  await assert.rejects(
    verify({ ...authorization, ownershipSignature: undefined }),
    /Creator ownership signature is required/,
  );

  const mutations = [
    { label: 'request', path: 'message', value: { attestationId: keccak256(stringToHex('other-request')) } },
    { label: 'wallet', path: 'message', value: { wallet: outsider.address } },
    { label: 'handle', path: 'message', value: { handleHash: keccak256(stringToHex('other-handle')) } },
    { label: 'post', path: 'message', value: { verificationPostHash: keccak256(stringToHex('other-post')) } },
    { label: 'challenge', path: 'message', value: { challengeHash: keccak256(stringToHex('other-challenge')) } },
    { label: 'expiry', path: 'message', value: { expiresAt: authorization.bundle.message.expiresAt + 1n } },
  ];
  for (const mutation of mutations) {
    const bundle = {
      ...authorization.bundle,
      [mutation.path]: { ...authorization.bundle[mutation.path], ...mutation.value },
    };
    await assert.rejects(
      verify({ bundle, ownershipSignature: authorization.ownershipSignature }),
      /Creator ownership signature is invalid/,
      mutation.label,
    );
  }

  await assert.rejects(
    verify({
      ...authorization,
      bundle: {
        ...authorization.bundle,
        domain: { ...authorization.bundle.domain, verifyingContract: outsider.address },
      },
    }),
    /wrong Base receiver/,
  );
  await assert.rejects(
    verify({
      ...authorization,
      bundle: {
        ...authorization.bundle,
        domain: { ...authorization.bundle.domain, chainId: localChain.id + 1 },
      },
    }),
    /wrong Base chain/,
  );
  await assert.rejects(
    verify({
      ...authorization,
      bundle: {
        ...authorization.bundle,
        message: {
          ...authorization.bundle.message,
          genlayerContract: `0x${'00'.repeat(12)}${'23'.repeat(20)}`,
        },
      },
    }),
    /wrong GenLayer resolver/,
  );
});

test('watcher rejects expired credentials, disabled watchers, and Base replay state', async () => {
  const now = Number((await publicClient.getBlock()).timestamp);
  const expired = await fixture({
    suffix: 'expired',
    verifiedAt: now - 100,
    expiresAt: now - 1,
  });
  await assert.rejects(verify(expired), /has expired/);

  const authorization = await fixture({ suffix: 'replay' });
  await assert.rejects(
    verify({ ...authorization, watcher: outsider.address }),
    /Watcher is not enabled/,
  );

  const replayClient = (replayedFunction) => ({
    getChainId: (...args) => publicClient.getChainId(...args),
    getBlock: (...args) => publicClient.getBlock(...args),
    readContract: (parameters) => (
      parameters.functionName === replayedFunction
        ? Promise.resolve(true)
        : publicClient.readContract(parameters)
    ),
    verifyTypedData: (...args) => publicClient.verifyTypedData(...args),
  });
  await assert.rejects(
    verify({ ...authorization, client: replayClient('usedAttestations') }),
    /attestation was already relayed/,
  );
  await assert.rejects(
    verify({ ...authorization, client: replayClient('usedOwnershipIntents') }),
    /authorization was already consumed/,
  );
});
