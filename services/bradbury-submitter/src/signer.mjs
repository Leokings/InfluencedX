import { SubmitterProblem } from './problem.mjs';

const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Serializes every state-changing call through one account-wide queue. The
 * Durable Object using this helper is addressed by one fixed name, so separate
 * ownership-request objects cannot race the Bradbury account nonce.
 */
export class SerializedBradburySigner {
  constructor(client) {
    this.client = client;
    this.operation = Promise.resolve();
  }

  submit(envelope) {
    const next = this.operation.then(async () => {
      const txHash = await this.client.submitOwnership(envelope);
      if (typeof txHash !== 'string' || !TRANSACTION_HASH.test(txHash)) {
        throw new SubmitterProblem(
          503,
          'INVALID_TRANSACTION_HASH',
          'Bradbury returned an invalid transaction hash.',
        );
      }
      return txHash.toLowerCase();
    });
    this.operation = next.catch(() => undefined);
    return next;
  }
}
