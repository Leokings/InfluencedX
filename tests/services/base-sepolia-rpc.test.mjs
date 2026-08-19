import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BASE_SEPOLIA_FALLBACK_RPC_URL,
  BASE_SEPOLIA_PUBLIC_RPC_URL,
  baseSepoliaRpcUrls,
  createBaseSepoliaFallbackTransport,
  safeCutoverErrorMessage,
} from '../../scripts/lib/base-sepolia-rpc.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('Base Sepolia transport retains a distinct fallback after a configured endpoint', () => {
  assert.deepEqual(baseSepoliaRpcUrls('https://example.invalid/base'), [
    'https://example.invalid/base',
    BASE_SEPOLIA_PUBLIC_RPC_URL,
    BASE_SEPOLIA_FALLBACK_RPC_URL,
  ]);
  assert.deepEqual(baseSepoliaRpcUrls(BASE_SEPOLIA_PUBLIC_RPC_URL), [
    BASE_SEPOLIA_PUBLIC_RPC_URL,
    BASE_SEPOLIA_FALLBACK_RPC_URL,
  ]);
  assert.equal(typeof createBaseSepoliaFallbackTransport(), 'function');
});

test('cutover RPC errors are reduced to a bounded reconciliation message', () => {
  const error = Object.assign(new Error([
    'Request exceeds defined limit.',
    'URL: https://provider.example/secret-path',
    'Request body: {"method":"eth_call"}',
    'abi: [{"name":"pause"}]',
  ].join('\n')), {
    name: 'ContractFunctionExecutionError',
    shortMessage: 'Request exceeds defined limit.',
  });
  const message = safeCutoverErrorMessage(error);

  assert.match(message, /reconcile on-chain state before any mutation/i);
  assert.doesNotMatch(message, /provider\.example|secret-path|request body|abi|pause/i);
  assert.ok(message.length <= 240);
});

test('operator-facing invariant errors remain actionable and single-line', () => {
  const message = safeCutoverErrorMessage(new Error(
    'The Base receiver owner has a pending transaction. Wait for it to settle.',
  ));
  assert.equal(
    message,
    'The Base receiver owner has a pending transaction. Wait for it to settle.',
  );
});

test('StudioNet cutover refuses to mutate while the receiver owner has a pending transaction', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'scripts', 'cutover-base-receiver-studionet.mjs'),
    'utf8',
  );
  const pendingGuard = source.indexOf('ownerPendingNonce !== ownerLatestNonce');
  const confirmation = source.indexOf("requireMutationConfirmation('pause the receiver");

  assert.ok(pendingGuard >= 0 && pendingGuard < confirmation);
  assert.match(source, /createBaseSepoliaFallbackTransport/);
  assert.match(source, /safeCutoverErrorMessage\(error\)/);
});
