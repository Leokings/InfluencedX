import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createJournalSaver,
  loadOrCreateJournal,
  resumeContractDeployment,
  resumeContractWrite,
} from '../../scripts/lib/base-deployment-journal.mjs';

const TX_HASH = `0x${'12'.repeat(32)}`;
const WRITE_HASH = `0x${'34'.repeat(32)}`;
const CONTRACT = `0x${'56'.repeat(20)}`;
const OWNER = `0x${'78'.repeat(20)}`;
const ARTIFACT = { abi: [], bytecode: '0x6000' };
const CONFIG = { chainId: 84532, deployer: OWNER, watchers: ['one', 'two', 'three'] };

function temporaryJournal() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xproof-base-journal-'));
  const journalPath = path.join(directory, 'base-sepolia.journal.json');
  const loaded = loadOrCreateJournal({ journalPath, config: CONFIG });
  return {
    ...loaded,
    directory,
    journalPath,
    saveJournal: createJournalSaver({ journalPath, journal: loaded.journal }),
  };
}

function receipt(transactionHash = TX_HASH) {
  return {
    status: 'success',
    transactionHash,
    contractAddress: CONTRACT,
    blockNumber: 123n,
  };
}

test('persists a new deployment hash before waiting for its receipt', async (t) => {
  const state = temporaryJournal();
  t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));
  const events = [];
  let deployCalls = 0;

  const result = await resumeContractDeployment({
    key: 'registry',
    contractName: 'AdProofCreatorRegistry',
    artifact: ARTIFACT,
    args: [OWNER],
    journal: state.journal,
    saveJournal: state.saveJournal,
    walletClient: {
      deployContract: async () => {
        deployCalls += 1;
        return TX_HASH;
      },
    },
    publicClient: {
      waitForTransactionReceipt: async () => {
        const onDisk = JSON.parse(fs.readFileSync(state.journalPath, 'utf8'));
        assert.equal(onDisk.contracts.registry.transactionHash, TX_HASH);
        return receipt();
      },
      getCode: async () => '0x6000',
    },
    emit: (event) => events.push(event),
    sleep: async () => {},
  });

  assert.equal(deployCalls, 1);
  assert.equal(result.address, CONTRACT);
  assert.equal(events[0].stage, 'registry-submitted');
  assert.equal(events[0].transactionHash, TX_HASH);
});

test('recovers a mined pre-journal registry and polls through delayed bytecode visibility', async (t) => {
  const state = temporaryJournal();
  t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));
  state.journal.contracts.registry = {
    contractName: 'AdProofCreatorRegistry',
    transactionHash: TX_HASH,
    submittedAt: new Date().toISOString(),
    adoptedFromPreJournalRun: true,
  };
  state.saveJournal();
  let codeCalls = 0;
  let deployCalls = 0;

  const result = await resumeContractDeployment({
    key: 'registry',
    contractName: 'AdProofCreatorRegistry',
    artifact: ARTIFACT,
    args: [OWNER],
    journal: state.journal,
    saveJournal: state.saveJournal,
    walletClient: {
      deployContract: async () => {
        deployCalls += 1;
        throw new Error('must not redeploy');
      },
    },
    publicClient: {
      waitForTransactionReceipt: async ({ hash }) => {
        assert.equal(hash, TX_HASH);
        return receipt();
      },
      getCode: async () => {
        codeCalls += 1;
        return codeCalls < 3 ? '0x' : '0x6000';
      },
    },
    sleep: async () => {},
    codePollAttempts: 3,
  });

  assert.equal(deployCalls, 0);
  assert.equal(codeCalls, 3);
  assert.equal(result.transactionHash, TX_HASH);
  const onDisk = JSON.parse(fs.readFileSync(state.journalPath, 'utf8'));
  assert.equal(onDisk.contracts.registry.address, CONTRACT);
  assert.equal(onDisk.contracts.registry.codePollAttempts, 3);
});

test('resumes a journaled wiring transaction without signing it again', async (t) => {
  const state = temporaryJournal();
  t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));
  const deployment = { address: CONTRACT };
  let writes = 0;
  const clients = {
    walletClient: {
      writeContract: async () => {
        writes += 1;
        return WRITE_HASH;
      },
    },
    publicClient: {
      simulateContract: async () => ({ request: { to: CONTRACT } }),
      waitForTransactionReceipt: async () => ({
        status: 'success',
        transactionHash: WRITE_HASH,
        blockNumber: 124n,
      }),
    },
  };
  const options = {
    key: 'registryWiring',
    contractName: 'AdProofCreatorRegistry',
    deployment,
    artifact: ARTIFACT,
    functionName: 'setAttestationReceiver',
    args: [OWNER],
    journal: state.journal,
    saveJournal: state.saveJournal,
    account: { address: OWNER },
    ...clients,
  };

  assert.equal(await resumeContractWrite(options), WRITE_HASH);
  clients.walletClient.writeContract = async () => {
    throw new Error('must not sign twice');
  };
  clients.publicClient.simulateContract = async () => {
    throw new Error('must not simulate a completed journal entry');
  };
  assert.equal(await resumeContractWrite(options), WRITE_HASH);
  assert.equal(writes, 1);
});

test('refuses to resume a journal under different deployment configuration', (t) => {
  const state = temporaryJournal();
  t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));
  assert.throws(
    () => loadOrCreateJournal({
      journalPath: state.journalPath,
      config: { ...CONFIG, deployer: CONTRACT },
    }),
    /configuration differs/,
  );
});

test('atomically replaces the journal across repeated Windows saves', (t) => {
  const state = temporaryJournal();
  t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));
  for (let revision = 1; revision <= 5; revision += 1) {
    state.journal.testRevision = revision;
    state.saveJournal();
    const onDisk = JSON.parse(fs.readFileSync(state.journalPath, 'utf8'));
    assert.equal(onDisk.testRevision, revision);
  }
  assert.deepEqual(
    fs.readdirSync(state.directory).filter((name) => name.endsWith('.tmp')),
    [],
  );
});
