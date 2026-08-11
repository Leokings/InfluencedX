import assert from 'node:assert/strict';
import test from 'node:test';

import { SerializedBradburySigner } from '../../services/bradbury-submitter/src/signer.mjs';
import { makeEnvelope } from './helpers.mjs';

test('one signer boundary serializes two distinct request IDs', async () => {
  let activeWrites = 0;
  let maximumConcurrentWrites = 0;
  const order = [];
  const signer = new SerializedBradburySigner({
    async submitOwnership(envelope) {
      activeWrites += 1;
      maximumConcurrentWrites = Math.max(maximumConcurrentWrites, activeWrites);
      order.push(`start:${envelope.requestId}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`finish:${envelope.requestId}`);
      activeWrites -= 1;
      return envelope.requestId;
    },
  });
  const first = await makeEnvelope({ challenge: `APV2-${'a'.repeat(24)}` });
  const second = await makeEnvelope({ challenge: `APV2-${'b'.repeat(24)}` });

  const [firstHash, secondHash] = await Promise.all([
    signer.submit(first),
    signer.submit(second),
  ]);

  assert.notEqual(first.requestId, second.requestId);
  assert.equal(firstHash, first.requestId);
  assert.equal(secondHash, second.requestId);
  assert.equal(maximumConcurrentWrites, 1);
  assert.deepEqual(order, [
    `start:${first.requestId}`,
    `finish:${first.requestId}`,
    `start:${second.requestId}`,
    `finish:${second.requestId}`,
  ]);
});
