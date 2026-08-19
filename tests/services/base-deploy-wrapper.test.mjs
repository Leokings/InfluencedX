import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { getAddress, isAddress } from 'viem';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const REAL_WATCHERS = [
  '0x51a54A0E3Fc06B108175b06bE25bFB253Ec53c40',
  '0x8C6b2b9151f004F8a9941a21Aad87bef5B3fCAd1',
  '0x08C6D0B23D30bA84978Eba0CcC334a401c77572c',
];

test('PowerShell deploy wrapper pins public inputs and keeps secrets out of its pipeline', async () => {
  const source = await fs.readFile(
    path.join(projectRoot, 'scripts', 'deploy-base-sepolia.ps1'),
    'utf8',
  );

  assert.match(source, /0x0913b5593Ff16974E2fd616cA678A4986Cb48600/);
  assert.match(source, /0x2b71436526cb7fe24e81a2c88e8914121d5b4f1c350fc6946fe6c37cbbf16369/);
  assert.match(source, /BASE_SEPOLIA_RECOVER_REGISTRY_TRANSACTION_HASH/);
  assert.match(source, /grounding-bradbury\.keystore\.json/);
  assert.match(source, /testnet-watcher-addresses\.json/);
  assert.match(source, /\$requiredThreshold = 2/);
  assert.match(source, /BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY/);
  assert.match(source, /BASE_SEPOLIA_DEPLOYER_KEYSTORE_PASSWORD/);
  assert.match(source, /SetEnvironmentVariable\(\$name, \$null, "Process"\)/);
  assert.match(source, /Tee-Object -FilePath \$publicLogPath/);
  assert.doesNotMatch(source, /2>&1/);

  const preflightBranch = source.indexOf('if ($PreflightOnly)');
  const confirmation = source.indexOf('$confirmation = Read-Host');
  const signerInvocation = source.indexOf('& $nodeCommand $deployScript');
  assert.ok(preflightBranch >= 0 && preflightBranch < confirmation);
  assert.ok(confirmation < signerInvocation);
});

test('Node deployer refuses an existing manifest before loading the signer', async () => {
  const source = await fs.readFile(
    path.join(projectRoot, 'scripts', 'deploy-base-sepolia.mjs'),
    'utf8',
  );
  const duplicateGuard = source.indexOf('fs.existsSync(output)');
  const signerLoad = source.indexOf('await loadBaseSepoliaDeployer()');
  assert.ok(duplicateGuard >= 0 && duplicateGuard < signerLoad);
});

test('Node deployer parses the real comma-separated watcher list entry by entry', async () => {
  const source = await fs.readFile(
    path.join(projectRoot, 'scripts', 'deploy-base-sepolia.mjs'),
    'utf8',
  );
  const checkedAddress = source.match(/function checkedAddress\([\s\S]*?\n}\n/);
  const watcherExpression = source.match(/const watchers = ([\s\S]*?);\nconst threshold/);
  assert.ok(checkedAddress, 'checkedAddress helper must remain available');
  assert.ok(watcherExpression, 'watcher parser expression must remain available');
  assert.doesNotMatch(
    watcherExpression[1],
    /addressOr\(['"]BASE_WATCHER_ADDRESSES['"]/,
    'list entries must not re-read the full environment value',
  );

  const context = {
    getAddress,
    isAddress,
    process: { env: { BASE_WATCHER_ADDRESSES: REAL_WATCHERS.join(',') } },
    result: null,
  };
  vm.runInNewContext(
    `${checkedAddress[0]}\nresult = ${watcherExpression[1]};`,
    context,
  );
  assert.deepEqual([...context.result], REAL_WATCHERS);
});
