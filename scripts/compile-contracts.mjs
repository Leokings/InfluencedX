import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const projectRoot = path.resolve(import.meta.dirname, '..');
const contractsRoot = path.join(projectRoot, 'contracts', 'base');
const artifactsRoot = path.join(projectRoot, 'artifacts', 'base');

const sourceFiles = [
  'AdProofCreatorRegistry.sol',
  'AdProofEscrow.sol',
  'AdProofAttestationReceiver.sol',
  'test/MockUSDC.sol',
  'test/Mock1271.sol',
];

const sources = Object.fromEntries(
  sourceFiles.map((relativePath) => [
    relativePath,
    { content: fs.readFileSync(path.join(contractsRoot, relativePath), 'utf8') },
  ]),
);

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 500 },
    viaIR: true,
    evmVersion: 'shanghai',
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'],
      },
    },
  },
};

function findImports(importPath) {
  const candidates = [
    path.join(projectRoot, 'node_modules', importPath),
    path.join(contractsRoot, importPath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { contents: fs.readFileSync(candidate, 'utf8') };
  }
  return { error: `Import not found: ${importPath}` };
}

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const diagnostics = output.errors ?? [];
for (const diagnostic of diagnostics) {
  const writer = diagnostic.severity === 'error' ? console.error : console.warn;
  writer(diagnostic.formattedMessage.trim());
}
if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) process.exit(1);

fs.mkdirSync(artifactsRoot, { recursive: true });
const wanted = new Set([
  'AdProofCreatorRegistry',
  'AdProofEscrow',
  'AdProofAttestationReceiver',
  'MockUSDC',
  'Mock1271',
]);

let written = 0;
for (const [sourceName, contracts] of Object.entries(output.contracts ?? {})) {
  for (const [contractName, artifact] of Object.entries(contracts)) {
    if (!wanted.has(contractName)) continue;
    const bytecode = artifact.evm?.bytecode?.object ?? '';
    if (!bytecode) throw new Error(`${contractName} has no deployable bytecode`);
    fs.writeFileSync(
      path.join(artifactsRoot, `${contractName}.json`),
      `${JSON.stringify(
        {
          contractName,
          sourceName,
          compilerVersion: solc.version(),
          abi: artifact.abi,
          bytecode: `0x${bytecode}`,
          deployedBytecode: `0x${artifact.evm.deployedBytecode.object}`,
        },
        null,
        2,
      )}\n`,
    );
    written += 1;
  }
}

if (written !== wanted.size) {
  throw new Error(`Expected ${wanted.size} artifacts, wrote ${written}`);
}
console.log(`Compiled ${written} contracts with ${solc.version()}`);
