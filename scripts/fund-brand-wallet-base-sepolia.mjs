import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
} from 'viem';
import { baseSepolia } from 'viem/chains';

import { loadBaseSepoliaDeployer } from './lib/base-deployer-account.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RPC_URL = 'https://sepolia.base.org';
const SOURCE = getAddress('0x87e94EDAb4418e8A9eA37c0FAb0675Cf0602A9F2');
const TARGET = getAddress('0xAebc04668E36361e6EFa9a564C176e8dcA2cFDD2');
const USDC = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
const ETH_AMOUNT = 2_000_000_000_000_000n;
const USDC_AMOUNT = 1_000_000n;
const CONFIRMATION = 'FUND INFLUENCEDX BRAND WALLET';
const KEYSTORE_PATH = path.join(
  PROJECT_ROOT,
  '.secrets',
  'testnet-deployer',
  'grounding-bradbury.keystore.json',
);
const STATE_DIR = path.join(PROJECT_ROOT, '.secrets', 'brand-wallet-funding');
const INTENT_PATH = path.join(STATE_DIR, `${TARGET.toLowerCase()}.intent.json`);
const PUBLIC_PATH = path.join(STATE_DIR, `${TARGET.toLowerCase()}.public.json`);
const TRANSFER_DATA = encodeFunctionData({
  abi: erc20Abi,
  functionName: 'transfer',
  args: [TARGET, USDC_AMOUNT],
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson(filePath, label) {
  const stat = await fs.lstat(filePath);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 256 * 1024,
    `${label} is not a bounded regular file`);
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const staging = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(staging, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await fs.rename(staging, filePath);
  } catch (error) {
    await fs.rm(staging, { force: true }).catch(() => {});
    throw error;
  }
}

function hashPattern(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function rawTransactionPattern(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value);
}

async function validateSignedTransaction(serialized, expected) {
  invariant(rawTransactionPattern(serialized), 'Persisted signed transaction is malformed');
  const transaction = parseTransaction(serialized);
  const signer = getAddress(await recoverTransactionAddress({ serializedTransaction: serialized }));
  invariant(signer === SOURCE, 'Persisted signed transaction has the wrong signer');
  invariant(transaction.chainId === baseSepolia.id, 'Persisted signed transaction has the wrong chain');
  invariant(transaction.nonce === expected.nonce, 'Persisted signed transaction has the wrong nonce');
  invariant(getAddress(transaction.to) === expected.to, 'Persisted signed transaction has the wrong target');
  invariant((transaction.value ?? 0n) === expected.value,
    'Persisted signed transaction has the wrong value');
  invariant((transaction.data ?? '0x').toLowerCase() === expected.data.toLowerCase(),
    'Persisted signed transaction has the wrong calldata');
  return keccak256(serialized);
}

async function validateIntent(intent) {
  invariant(intent?.schemaVersion === 1
    && intent?.chainId === baseSepolia.id
    && intent?.source === SOURCE
    && intent?.target === TARGET
    && intent?.usdc === USDC
    && intent?.ethAmountWei === ETH_AMOUNT.toString()
    && intent?.usdcAmountAtoms === USDC_AMOUNT.toString()
    && Number.isSafeInteger(intent?.startingNonce)
    && intent.startingNonce >= 0,
  'Persisted brand-wallet funding intent is invalid');
  const ethHash = await validateSignedTransaction(intent.ethSerializedTransaction, {
    nonce: intent.startingNonce,
    to: TARGET,
    value: ETH_AMOUNT,
    data: '0x',
  });
  const usdcHash = await validateSignedTransaction(intent.usdcSerializedTransaction, {
    nonce: intent.startingNonce + 1,
    to: USDC,
    value: 0n,
    data: TRANSFER_DATA,
  });
  invariant(intent.ethTransactionHash === ethHash && intent.usdcTransactionHash === usdcHash,
    'Persisted brand-wallet funding hashes do not match the signed transactions');
  return intent;
}

async function chainState(publicClient) {
  const [sourceEth, sourceUsdc, sourceLatestNonce, sourcePendingNonce,
    targetEth, targetUsdc, targetLatestNonce, targetPendingNonce] = await Promise.all([
    publicClient.getBalance({ address: SOURCE }),
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [SOURCE] }),
    publicClient.getTransactionCount({ address: SOURCE, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: SOURCE, blockTag: 'pending' }),
    publicClient.getBalance({ address: TARGET }),
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [TARGET] }),
    publicClient.getTransactionCount({ address: TARGET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: TARGET, blockTag: 'pending' }),
  ]);
  return {
    sourceEth,
    sourceUsdc,
    sourceLatestNonce,
    sourcePendingNonce,
    targetEth,
    targetUsdc,
    targetLatestNonce,
    targetPendingNonce,
  };
}

function printPlan(state) {
  process.stdout.write('\nInfluencedX brand-wallet funding / Base Sepolia\n');
  process.stdout.write(`Source: ${SOURCE}\n`);
  process.stdout.write(`Target: ${TARGET}\n`);
  process.stdout.write('Native ETH: 0.002 Base Sepolia ETH\n');
  process.stdout.write('Token: 1.000000 native Base Sepolia test USDC\n');
  process.stdout.write(`Source public balance: ${state.sourceEth} wei / ${state.sourceUsdc} USDC atoms\n`);
  process.stdout.write(`Target public balance: ${state.targetEth} wei / ${state.targetUsdc} USDC atoms\n\n`);
}

async function confirm() {
  invariant(process.stdin.isTTY && process.stdout.isTTY, 'Funding requires a visible interactive terminal');
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`Type ${CONFIRMATION} to sign the two fixed testnet transfers: `);
    invariant(answer === CONFIRMATION, 'Funding confirmation did not match; nothing was signed');
  } finally {
    terminal.close();
  }
}

async function createIntent(publicClient) {
  const state = await chainState(publicClient);
  printPlan(state);
  invariant(state.sourceLatestNonce === state.sourcePendingNonce,
    'The source wallet has a pending transaction; wait for it before funding');
  invariant(state.sourceUsdc >= USDC_AMOUNT, 'The source wallet does not have 1 test USDC');
  invariant(state.sourceEth > ETH_AMOUNT + 500_000_000_000_000n,
    'The source wallet does not have enough Base Sepolia ETH');
  invariant(state.targetEth === 0n && state.targetUsdc === 0n
    && state.targetLatestNonce === 0 && state.targetPendingNonce === 0,
  'The target wallet is not unused; refusing a first-time funding intent');
  await confirm();
  const deployer = await loadBaseSepoliaDeployer({
    env: { BASE_SEPOLIA_DEPLOYER_KEYSTORE_PATH: KEYSTORE_PATH },
    cwd: PROJECT_ROOT,
  });
  invariant(getAddress(deployer.address) === SOURCE, 'The encrypted keystore is not the expected source wallet');
  const walletClient = createWalletClient({
    account: deployer,
    chain: baseSepolia,
    transport: http(RPC_URL, { timeout: 20_000, retryCount: 2 }),
  });
  const ethRequest = await walletClient.prepareTransactionRequest({
    account: deployer,
    to: TARGET,
    value: ETH_AMOUNT,
    nonce: state.sourcePendingNonce,
  });
  const usdcRequest = await walletClient.prepareTransactionRequest({
    account: deployer,
    to: USDC,
    data: TRANSFER_DATA,
    value: 0n,
    nonce: state.sourcePendingNonce + 1,
  });
  const ethSerializedTransaction = await walletClient.signTransaction(ethRequest);
  const usdcSerializedTransaction = await walletClient.signTransaction(usdcRequest);
  const intent = {
    schemaVersion: 1,
    chainId: baseSepolia.id,
    source: SOURCE,
    target: TARGET,
    usdc: USDC,
    ethAmountWei: ETH_AMOUNT.toString(),
    usdcAmountAtoms: USDC_AMOUNT.toString(),
    startingNonce: state.sourcePendingNonce,
    ethTransactionHash: keccak256(ethSerializedTransaction),
    usdcTransactionHash: keccak256(usdcSerializedTransaction),
    ethSerializedTransaction,
    usdcSerializedTransaction,
    signedAt: new Date().toISOString(),
  };
  await validateIntent(intent);
  await writeJsonAtomic(INTENT_PATH, intent);
  return intent;
}

async function transactionOrNull(publicClient, hash) {
  try {
    return await publicClient.getTransaction({ hash });
  } catch (error) {
    if (String(error?.name).includes('TransactionNotFound')) return null;
    throw new Error('Base Sepolia transaction lookup failed');
  }
}

async function receiptOrNull(publicClient, hash) {
  try {
    return await publicClient.getTransactionReceipt({ hash });
  } catch (error) {
    if (String(error?.name).includes('TransactionReceiptNotFound')) return null;
    throw new Error('Base Sepolia receipt lookup failed');
  }
}

async function broadcastOrReconcile(publicClient, serializedTransaction, hash) {
  const [transaction, receipt] = await Promise.all([
    transactionOrNull(publicClient, hash),
    receiptOrNull(publicClient, hash),
  ]);
  if (!transaction && !receipt) {
    try {
      const returnedHash = await publicClient.sendRawTransaction({ serializedTransaction });
      invariant(returnedHash === hash, 'Base Sepolia returned an unexpected transaction hash');
    } catch (error) {
      const message = String(error?.shortMessage ?? error?.message ?? '');
      if (!/already known|known transaction/i.test(message)) {
        throw new Error('Base Sepolia rejected a bounded funding transaction');
      }
    }
  }
  const confirmed = receipt ?? await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 2,
    timeout: 120_000,
  });
  invariant(confirmed.status === 'success', 'A bounded funding transaction reverted');
  return confirmed;
}

async function verifyTransaction(publicClient, hash, expected) {
  const transaction = await publicClient.getTransaction({ hash });
  invariant(getAddress(transaction.from) === SOURCE
    && getAddress(transaction.to) === expected.to
    && (transaction.value ?? 0n) === expected.value
    && (transaction.input ?? transaction.data ?? '0x').toLowerCase() === expected.data.toLowerCase(),
  'Confirmed funding transaction does not match the bounded transfer');
}

async function reconcile(publicClient, intent) {
  await broadcastOrReconcile(publicClient, intent.ethSerializedTransaction, intent.ethTransactionHash);
  await verifyTransaction(publicClient, intent.ethTransactionHash, {
    to: TARGET,
    value: ETH_AMOUNT,
    data: '0x',
  });
  await broadcastOrReconcile(publicClient, intent.usdcSerializedTransaction, intent.usdcTransactionHash);
  await verifyTransaction(publicClient, intent.usdcTransactionHash, {
    to: USDC,
    value: 0n,
    data: TRANSFER_DATA,
  });
  const state = await chainState(publicClient);
  invariant(state.targetEth >= ETH_AMOUNT, 'Confirmed Base Sepolia ETH is not visible at the target');
  invariant(state.targetUsdc >= USDC_AMOUNT, 'Confirmed test USDC is not visible at the target');
  if (!(await exists(PUBLIC_PATH))) {
    await writeJsonAtomic(PUBLIC_PATH, {
      schemaVersion: 1,
      chainId: baseSepolia.id,
      source: SOURCE,
      target: TARGET,
      usdc: USDC,
      ethAmountWei: ETH_AMOUNT.toString(),
      usdcAmountAtoms: USDC_AMOUNT.toString(),
      ethTransactionHash: intent.ethTransactionHash,
      usdcTransactionHash: intent.usdcTransactionHash,
      confirmedAt: new Date().toISOString(),
    });
  }
  process.stdout.write('\nBrand wallet funded successfully.\n');
  process.stdout.write(`ETH tx: https://sepolia.basescan.org/tx/${intent.ethTransactionHash}\n`);
  process.stdout.write(`USDC tx: https://sepolia.basescan.org/tx/${intent.usdcTransactionHash}\n`);
  process.stdout.write(`Target: https://sepolia.basescan.org/address/${TARGET}\n`);
}

async function main() {
  const mode = process.argv.slice(2);
  invariant(mode.length === 1 && (mode[0] === '--apply' || mode[0] === '--preflight'),
    'Use exactly --preflight or --apply');
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL, { timeout: 20_000, retryCount: 2 }),
  });
  if (mode[0] === '--preflight') {
    printPlan(await chainState(publicClient));
    process.stdout.write('Read-only preflight complete; nothing was signed or sent.\n');
    return;
  }
  let intent;
  if (await exists(INTENT_PATH)) {
    process.stdout.write('Existing signed funding intent found; reconciling without signing again.\n');
    intent = await validateIntent(await readJson(INTENT_PATH, 'Brand-wallet funding intent'));
  } else {
    invariant(!(await exists(PUBLIC_PATH)), 'Public funding record exists without its signed intent');
    intent = await createIntent(publicClient);
  }
  await reconcile(publicClient, intent);
}

main().catch((error) => {
  process.stderr.write(`Funding stopped safely: ${error instanceof Error ? error.message : 'Unknown error'}\n`);
  process.exitCode = 1;
});
