import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

function timestamp(now) {
  return now().toISOString();
}

export function atomicWriteJson(filePath, value, { exclusive = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (exclusive && fs.existsSync(filePath)) {
      throw new Error(`Refusing to overwrite existing file: ${filePath}`);
    }
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

export function loadOrCreateJournal({ journalPath, config, now = () => new Date() }) {
  let journal;
  if (fs.existsSync(journalPath)) {
    try {
      journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    } catch {
      throw new Error(`Deployment journal is not valid JSON: ${journalPath}`);
    }
    if (journal.schemaVersion !== 1 || journal.network !== 'base-sepolia') {
      throw new Error('Unsupported Base Sepolia deployment journal');
    }
    if (!isDeepStrictEqual(journal.config, config)) {
      throw new Error('Deployment configuration differs from the existing journal; refusing to continue');
    }
    if (!journal.contracts || !journal.transactions) {
      throw new Error('Base Sepolia deployment journal is incomplete');
    }
    return { journal, resumed: true };
  }

  journal = {
    schemaVersion: 1,
    network: 'base-sepolia',
    createdAt: timestamp(now),
    updatedAt: timestamp(now),
    config,
    contracts: {},
    transactions: {},
  };
  atomicWriteJson(journalPath, journal, { exclusive: true });
  return { journal, resumed: false };
}

export function createJournalSaver({ journalPath, journal, now = () => new Date() }) {
  return () => {
    journal.updatedAt = timestamp(now);
    atomicWriteJson(journalPath, journal);
  };
}

function normalizeReceipt(receipt) {
  return {
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
  };
}

function transactionIntent(contractName, target, functionName, args) {
  return {
    contractName,
    target,
    functionName,
    args: args.map((value) => value.toString()),
  };
}

export async function resumeContractDeployment({
  key,
  contractName,
  artifact,
  args,
  journal,
  saveJournal,
  walletClient,
  publicClient,
  emit = () => {},
  sleep = delay,
  now = () => new Date(),
  codePollAttempts = 20,
  codePollDelayMs = 1_500,
}) {
  let entry = journal.contracts[key];
  const resumed = Boolean(entry);
  if (entry && entry.contractName !== contractName) {
    throw new Error(`Journal contract mismatch for ${key}`);
  }

  if (!entry) {
    const transactionHash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args,
    });
    entry = {
      contractName,
      transactionHash,
      submittedAt: timestamp(now),
    };
    journal.contracts[key] = entry;
    saveJournal();
  }
  emit({
    stage: resumed ? `${key}-resuming` : `${key}-submitted`,
    transactionHash: entry.transactionHash,
    ...(entry.address ? { address: entry.address } : {}),
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: entry.transactionHash,
    confirmations: 1,
  });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`${contractName} deployment failed: ${entry.transactionHash}`);
  }
  if (entry.address && entry.address.toLowerCase() !== receipt.contractAddress.toLowerCase()) {
    throw new Error(`${contractName} receipt address differs from the deployment journal`);
  }
  entry.address = receipt.contractAddress;
  Object.assign(entry, normalizeReceipt(receipt), { receiptRecordedAt: timestamp(now) });
  saveJournal();
  emit({
    stage: `${key}-mined`,
    transactionHash: entry.transactionHash,
    address: entry.address,
    blockNumber: entry.blockNumber,
  });

  let lastCodeError;
  for (let attempt = 1; attempt <= codePollAttempts; attempt += 1) {
    try {
      const code = await publicClient.getCode({ address: entry.address });
      if (code && code !== '0x') {
        entry.codeVerifiedAt = timestamp(now);
        entry.codePollAttempts = attempt;
        saveJournal();
        return {
          address: entry.address,
          transactionHash: entry.transactionHash,
          blockNumber: entry.blockNumber,
        };
      }
    } catch (error) {
      lastCodeError = error;
    }
    if (attempt < codePollAttempts) await sleep(codePollDelayMs);
  }

  const suffix = lastCodeError instanceof Error ? ` Last RPC error: ${lastCodeError.message}` : '';
  throw new Error(
    `${contractName} receipt succeeded at ${entry.address}, but bytecode is not visible after `
    + `${codePollAttempts} polls. Re-run to resume ${entry.transactionHash} without redeploying.${suffix}`,
  );
}

export async function resumeContractWrite({
  key,
  contractName,
  deployment,
  artifact,
  functionName,
  args,
  journal,
  saveJournal,
  walletClient,
  publicClient,
  account,
  emit = () => {},
  now = () => new Date(),
}) {
  const intent = transactionIntent(contractName, deployment.address, functionName, args);
  let entry = journal.transactions[key];
  const resumed = Boolean(entry);
  if (entry && !isDeepStrictEqual(entry.intent, intent)) {
    throw new Error(`Journal transaction mismatch for ${key}`);
  }

  if (!entry) {
    const { request } = await publicClient.simulateContract({
      account,
      address: deployment.address,
      abi: artifact.abi,
      functionName,
      args,
    });
    const transactionHash = await walletClient.writeContract(request);
    entry = {
      intent,
      transactionHash,
      submittedAt: timestamp(now),
    };
    journal.transactions[key] = entry;
    saveJournal();
  }
  emit({
    stage: resumed ? `${key}-resuming` : `${key}-submitted`,
    transactionHash: entry.transactionHash,
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: entry.transactionHash,
    confirmations: 1,
  });
  if (receipt.status !== 'success') {
    throw new Error(`${functionName} failed: ${entry.transactionHash}`);
  }
  Object.assign(entry, normalizeReceipt(receipt), { receiptRecordedAt: timestamp(now) });
  saveJournal();
  return entry.transactionHash;
}
