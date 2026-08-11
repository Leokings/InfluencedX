import {
  PINNED_BRADBURY_RESOLVER,
  X_EPOCH_MS,
} from '../../services/bradbury-submitter/src/constants.mjs';
import { ownershipRequestId } from '../../services/bradbury-submitter/src/envelope.mjs';

export const NOW_EPOCH = 1_786_233_600;
export const NOW_MS = NOW_EPOCH * 1_000;
export const TX_HASH = `0x${'ab'.repeat(32)}`;

export async function makeEnvelope(overrides = {}) {
  const issuedAtEpoch = overrides.issuedAtEpoch ?? NOW_EPOCH - 60;
  const expiresAtEpoch = overrides.expiresAtEpoch ?? issuedAtEpoch + 15 * 60;
  const credentialExpiresAtEpoch = overrides.credentialExpiresAtEpoch ?? issuedAtEpoch + 30 * 24 * 60 * 60;
  const postEpoch = overrides.postEpoch ?? issuedAtEpoch + 30;
  const withoutRequestId = {
    schemaVersion: 1,
    baseWallet: overrides.baseWallet ?? `0x${'12'.repeat(20)}`,
    expectedHandle: overrides.expectedHandle ?? 'xproof_creator',
    postId: overrides.postId ?? snowflakeAt(postEpoch),
    challenge: overrides.challenge ?? `APV2-${'a'.repeat(24)}`,
    issuedAtEpoch,
    expiresAtEpoch,
    credentialExpiresAtEpoch,
  };
  return {
    ...withoutRequestId,
    requestId: overrides.requestId ?? await ownershipRequestId(withoutRequestId),
    ...overrides.extra,
  };
}

export function validConfigEnv(overrides = {}) {
  return {
    XPROOF_SUBMITTER_ENABLED: 'true',
    XPROOF_SUBMITTER_STAGE: 'testnet',
    XPROOF_GENLAYER_NETWORK: 'testnet-bradbury',
    XPROOF_GENLAYER_RESOLVER: PINNED_BRADBURY_RESOLVER,
    XPROOF_SUBMITTER_SHARED_SECRET: 'service-secret-with-at-least-32-chars',
    GENLAYER_SUBMITTER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
    ...overrides,
  };
}

export function snowflakeAt(epochSeconds) {
  return ((BigInt(epochSeconds) * 1_000n - X_EPOCH_MS) << 22n).toString();
}

export class MemoryStore {
  record = undefined;
  alarms = [];

  async get() {
    return this.record;
  }

  async put(record) {
    this.record = structuredClone(record);
  }

  async setAlarm(timestamp) {
    this.alarms.push(timestamp);
  }
}

export function finalizedReceipt(envelope, overrides = {}) {
  const requestId = typeof envelope === 'string' ? envelope : envelope.requestId;
  const args = typeof envelope === 'string'
    ? [requestId]
    : [
        envelope.requestId,
        envelope.baseWallet,
        envelope.expectedHandle,
        envelope.postId,
        envelope.challenge,
        envelope.issuedAtEpoch,
        envelope.expiresAtEpoch,
        envelope.credentialExpiresAtEpoch,
      ];
  return {
    statusName: 'FINALIZED',
    txExecutionResultName: 'FINISHED_WITH_RETURN',
    recipient: PINNED_BRADBURY_RESOLVER,
    txDataDecoded: {
      callData: {
        method: 'verify_ownership',
        args,
      },
    },
    ...overrides,
  };
}

export function ownershipResult(requestId, outcome = 'VERIFIED') {
  return { kind: 'OWNERSHIP', request_id: requestId, outcome };
}
