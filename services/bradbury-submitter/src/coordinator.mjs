import {
  DEFAULT_MAX_POLL_ATTEMPTS,
  DEFAULT_POLL_INTERVAL_MS,
  PINNED_BRADBURY_RESOLVER,
  SUBMITTER_METHOD,
  SUBMITTER_NETWORK,
  SUBMITTER_SCHEMA_VERSION,
  TERMINAL_SUBMISSION_STATUSES,
} from './constants.mjs';
import { submissionCallFingerprint } from './envelope.mjs';
import { SubmitterProblem } from './problem.mjs';

const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const RESULT_OUTCOMES = new Set(['VERIFIED', 'REJECTED', 'UNDETERMINED']);

export class OwnershipSubmissionCoordinator {
  constructor({
    store,
    client,
    now = () => Date.now(),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
  }) {
    this.store = store;
    this.client = client;
    this.now = now;
    this.pollIntervalMs = pollIntervalMs;
    this.maxPollAttempts = maxPollAttempts;
  }

  async submit(envelope) {
    const existing = await this.store.get();
    if (existing && !['PRECHECKING', 'PRECHECK_FAILED'].includes(existing.status)) {
      if (existing.status === 'BROADCASTING' && !existing.txHash) {
        const quarantined = await this.#update(existing, {
          status: 'RECONCILIATION_REQUIRED',
          errorCode: 'AMBIGUOUS_BROADCAST_STATE',
        });
        return { replayed: true, submission: project(quarantined) };
      }
      return { replayed: true, submission: project(existing) };
    }

    const callFingerprint = await submissionCallFingerprint(envelope);
    let record = existing ?? newRecord(envelope.requestId, callFingerprint, this.now());
    if (record.callFingerprint !== callFingerprint) {
      const quarantined = await this.#update(record, {
        status: 'RECONCILIATION_REQUIRED',
        errorCode: 'ENVELOPE_FINGERPRINT_MISMATCH',
      });
      return { replayed: true, submission: project(quarantined) };
    }
    record = await this.#update(record, {
      status: 'PRECHECKING',
      errorCode: null,
    });
    await this.#schedulePoll();

    let alreadyResolved;
    try {
      alreadyResolved = await this.client.readExistingResult(envelope.requestId);
    } catch {
      const failed = await this.#update(record, {
        status: 'PRECHECK_FAILED',
        errorCode: 'BRADBURY_PRECHECK_UNAVAILABLE',
      });
      throw new SubmitterProblem(
        503,
        'BRADBURY_PRECHECK_UNAVAILABLE',
        `Bradbury could not be checked safely; no transaction was submitted (${failed.requestId}).`,
      );
    }
    if (alreadyResolved) {
      try {
        assertResolverResult(alreadyResolved, envelope.requestId);
      } catch {
        const quarantined = await this.#update(record, {
          status: 'RECONCILIATION_REQUIRED',
          errorCode: 'EXISTING_RESULT_INVALID',
        });
        return { replayed: true, submission: project(quarantined) };
      }
      const quarantined = await this.#update(record, {
        status: 'RECONCILIATION_REQUIRED',
        errorCode: 'RESULT_EXISTS_WITHOUT_LOCAL_TRANSACTION',
        resultOutcome: alreadyResolved.outcome,
      });
      return { replayed: true, submission: project(quarantined) };
    }

    record = await this.#update(record, {
      status: 'BROADCASTING',
      broadcastStartedAt: this.now(),
    });
    await this.#schedulePoll();
    let txHash;
    try {
      txHash = await this.client.submitOwnership(envelope);
    } catch {
      const quarantined = await this.#update(record, {
        status: 'RECONCILIATION_REQUIRED',
        errorCode: 'BROADCAST_OUTCOME_UNKNOWN',
      });
      throw new SubmitterProblem(
        503,
        'BROADCAST_OUTCOME_UNKNOWN',
        `The broadcast outcome is ambiguous and will not be retried automatically (${quarantined.requestId}).`,
      );
    }
    if (typeof txHash !== 'string' || !TRANSACTION_HASH.test(txHash)) {
      await this.#update(record, {
        status: 'RECONCILIATION_REQUIRED',
        errorCode: 'INVALID_TRANSACTION_HASH',
      });
      throw new SubmitterProblem(
        503,
        'INVALID_TRANSACTION_HASH',
        'Bradbury returned an invalid transaction hash; automatic resubmission is disabled.',
      );
    }

    const submitted = await this.#update(record, {
      status: 'SUBMITTED',
      txHash: txHash.toLowerCase(),
      submittedAt: this.now(),
      pollAttempts: 0,
    });
    await this.#schedulePoll();
    return { replayed: false, submission: project(submitted) };
  }

  async poll() {
    const record = await this.store.get();
    if (!record) throw new SubmitterProblem(404, 'SUBMISSION_NOT_FOUND', 'Submission not found.');
    if (TERMINAL_SUBMISSION_STATUSES.has(record.status)) return project(record);
    if (!record.txHash) {
      if (record.status === 'PRECHECKING') {
        const retryable = await this.#update(record, {
          status: 'PRECHECK_FAILED',
          errorCode: 'PRECHECK_INTERRUPTED',
        });
        return project(retryable);
      }
      if (record.status === 'PRECHECK_FAILED') return project(record);
      const quarantined = await this.#update(record, {
        status: 'RECONCILIATION_REQUIRED',
        errorCode: 'TRANSACTION_HASH_MISSING',
      });
      return project(quarantined);
    }
    const attempt = (record.pollAttempts ?? 0) + 1;
    if (attempt > this.maxPollAttempts) {
      const exhausted = await this.#update(record, {
        status: 'POLLING_EXHAUSTED',
        errorCode: 'POLLING_ATTEMPTS_EXHAUSTED',
      });
      return project(exhausted);
    }

    let receipt;
    try {
      receipt = await this.client.getTransaction(record.txHash);
    } catch {
      const pending = await this.#update(record, {
        pollAttempts: attempt,
        lastPolledAt: this.now(),
        errorCode: 'BRADBURY_POLL_UNAVAILABLE',
      });
      await this.#schedulePoll();
      return project(pending);
    }

    const bindingError = await transactionBindingError(receipt, record);
    if (bindingError) {
      const quarantined = await this.#update(record, {
        status: 'RECONCILIATION_REQUIRED',
        pollAttempts: attempt,
        lastPolledAt: this.now(),
        errorCode: bindingError,
      });
      return project(quarantined);
    }

    const lifecycleStatus = normalizedStatus(receipt);
    const executionResult = normalizedExecutionResult(receipt);
    if (lifecycleStatus === 'CANCELED') {
      const canceled = await this.#update(record, {
        status: 'NETWORK_TERMINATED',
        lifecycleStatus,
        executionResult,
        pollAttempts: attempt,
        lastPolledAt: this.now(),
        errorCode: 'TRANSACTION_CANCELED',
      });
      return project(canceled);
    }

    if (lifecycleStatus === 'FINALIZED') {
      if (executionResult !== 'FINISHED_WITH_RETURN') {
        const failed = await this.#update(record, {
          status: 'EXECUTION_FAILED',
          lifecycleStatus,
          executionResult,
          pollAttempts: attempt,
          lastPolledAt: this.now(),
          finalizedAt: this.now(),
          errorCode: 'GENLAYER_EXECUTION_FAILED',
        });
        return project(failed);
      }
      let result;
      try {
        result = await this.client.readFinalResult(record.requestId);
        assertResolverResult(result, record.requestId);
      } catch {
        const quarantined = await this.#update(record, {
          status: 'RECONCILIATION_REQUIRED',
          lifecycleStatus,
          executionResult,
          pollAttempts: attempt,
          lastPolledAt: this.now(),
          errorCode: 'FINAL_RESULT_INVALID',
        });
        return project(quarantined);
      }
      const finalized = await this.#update(record, {
        status: 'FINALIZED',
        lifecycleStatus,
        executionResult,
        resultOutcome: result.outcome,
        pollAttempts: attempt,
        lastPolledAt: this.now(),
        finalizedAt: this.now(),
        errorCode: null,
      });
      return project(finalized);
    }

    const pending = await this.#update(record, {
      status: 'POLLING',
      lifecycleStatus,
      executionResult,
      pollAttempts: attempt,
      lastPolledAt: this.now(),
      errorCode: null,
    });
    await this.#schedulePoll();
    return project(pending);
  }

  async status() {
    const record = await this.store.get();
    if (!record) throw new SubmitterProblem(404, 'SUBMISSION_NOT_FOUND', 'Submission not found.');
    return project(record);
  }

  async #update(record, changes) {
    const updated = {
      ...record,
      ...changes,
      updatedAt: this.now(),
    };
    await this.store.put(updated);
    return updated;
  }

  async #schedulePoll() {
    await this.store.setAlarm(this.now() + this.pollIntervalMs);
  }
}

function newRecord(requestId, callFingerprint, now) {
  return {
    schemaVersion: SUBMITTER_SCHEMA_VERSION,
    requestId,
    network: SUBMITTER_NETWORK,
    resolver: PINNED_BRADBURY_RESOLVER,
    functionName: SUBMITTER_METHOD,
    callFingerprint,
    status: 'PRECHECKING',
    lifecycleStatus: null,
    executionResult: null,
    resultOutcome: null,
    txHash: null,
    pollAttempts: 0,
    errorCode: null,
    broadcastStartedAt: null,
    submittedAt: null,
    lastPolledAt: null,
    finalizedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function project(record) {
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    requestId: record.requestId,
    network: record.network,
    resolver: record.resolver,
    functionName: record.functionName,
    status: record.status,
    lifecycleStatus: record.lifecycleStatus,
    executionResult: record.executionResult,
    resultOutcome: record.resultOutcome,
    txHash: record.txHash,
    pollAttempts: record.pollAttempts,
    errorCode: record.errorCode,
    submittedAt: toIso(record.submittedAt),
    lastPolledAt: toIso(record.lastPolledAt),
    finalizedAt: toIso(record.finalizedAt),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  });
}

async function transactionBindingError(receipt, record) {
  const recipient = receipt?.toAddress ?? receipt?.recipient ?? receipt?.to_address;
  if (typeof recipient !== 'string') return 'TRANSACTION_RESOLVER_MISSING';
  if (recipient.toLowerCase() !== PINNED_BRADBURY_RESOLVER.toLowerCase()) {
    return 'TRANSACTION_RESOLVER_MISMATCH';
  }
  const callData = receipt?.txDataDecoded?.callData;
  const method = callData instanceof Map ? callData.get('method') : callData?.method;
  const args = callData instanceof Map ? callData.get('args') : callData?.args;
  if (typeof method !== 'string') return 'TRANSACTION_METHOD_MISSING';
  if (method !== SUBMITTER_METHOD) return 'TRANSACTION_METHOD_MISMATCH';
  if (!Array.isArray(args)) return 'TRANSACTION_ARGUMENTS_MISSING';
  let fingerprint;
  try {
    fingerprint = await submissionCallFingerprint(args);
  } catch {
    return 'TRANSACTION_ARGUMENTS_INVALID';
  }
  if (fingerprint !== record.callFingerprint) return 'TRANSACTION_ARGUMENTS_MISMATCH';
  return null;
}

function assertResolverResult(result, requestId) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Resolver result is missing.');
  }
  if (result.kind !== 'OWNERSHIP') throw new Error('Resolver result kind is not OWNERSHIP.');
  if (String(result.request_id).toLowerCase() !== requestId) throw new Error('Resolver request ID mismatch.');
  if (!RESULT_OUTCOMES.has(result.outcome)) throw new Error('Resolver outcome is unsupported.');
}

function normalizedStatus(receipt) {
  const status = receipt?.statusName ?? receipt?.status;
  return typeof status === 'string' ? status : 'UNKNOWN';
}

function normalizedExecutionResult(receipt) {
  const result = receipt?.txExecutionResultName ?? receipt?.txExecutionResult;
  return typeof result === 'string' ? result : null;
}

function toIso(value) {
  return Number.isSafeInteger(value) ? new Date(value).toISOString() : null;
}
