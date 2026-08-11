import { loadSubmitterConfig, publicConfig } from './config.mjs';
import { OwnershipSubmissionCoordinator } from './coordinator.mjs';
import { MAX_REQUEST_BYTES } from './constants.mjs';
import { validateOwnershipEnvelope } from './envelope.mjs';
import { createPinnedBradburyClient } from './genlayer-client.mjs';
import { jsonResponse, problemResponse, SubmitterProblem } from './problem.mjs';
import { requireServiceAuthorization } from './service-auth.mjs';
import { SerializedBradburySigner } from './signer.mjs';

const REQUEST_ID = '0x[0-9a-fA-F]{64}';
const STATUS_PATH = new RegExp(`^/v1/ownership-submissions/(${REQUEST_ID})$`);
const POLL_PATH = new RegExp(`^/v1/ownership-submissions/(${REQUEST_ID})/poll$`);

export default {
  async fetch(request, env) {
    try {
      const config = loadSubmitterConfig(env);
      await requireServiceAuthorization(request, config.sharedSecret);
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/healthz') {
        return jsonResponse({ ok: true, config: publicConfig(config) });
      }

      if (request.method === 'POST' && url.pathname === '/v1/ownership-submissions') {
        const namespace = requireNamespace(env);
        const body = await readJsonBody(request);
        const envelope = await validateOwnershipEnvelope(body);
        const stub = namespace.get(namespace.idFromName(envelope.requestId));
        return stub.fetch(new Request('https://xproof-submit.internal/submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(envelope),
        }));
      }

      const statusMatch = request.method === 'GET' ? url.pathname.match(STATUS_PATH) : null;
      if (statusMatch) {
        const requestId = statusMatch[1].toLowerCase();
        const namespace = requireNamespace(env);
        const stub = namespace.get(namespace.idFromName(requestId));
        return stub.fetch('https://xproof-submit.internal/status');
      }

      const pollMatch = request.method === 'POST' ? url.pathname.match(POLL_PATH) : null;
      if (pollMatch) {
        const requestId = pollMatch[1].toLowerCase();
        const namespace = requireNamespace(env);
        const stub = namespace.get(namespace.idFromName(requestId));
        return stub.fetch('https://xproof-submit.internal/poll', { method: 'POST' });
      }

      throw new SubmitterProblem(404, 'ROUTE_NOT_FOUND', 'Private submitter route not found.');
    } catch (error) {
      return problemResponse(error);
    }
  },
};

export class OwnershipSubmissionObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.operation = Promise.resolve();
  }

  fetch(request) {
    return this.#exclusive(() => this.#handle(request));
  }

  alarm() {
    return this.#exclusive(async () => {
      const coordinator = this.#coordinator();
      await coordinator.poll();
    });
  }

  async #handle(request) {
    try {
      const url = new URL(request.url);
      const coordinator = this.#coordinator();
      if (request.method === 'POST' && url.pathname === '/submit') {
        const envelope = await validateOwnershipEnvelope(await request.json());
        const result = await coordinator.submit(envelope);
        return jsonResponse(result, result.replayed ? 200 : 202);
      }
      if (request.method === 'GET' && url.pathname === '/status') {
        return jsonResponse({ submission: await coordinator.status() });
      }
      if (request.method === 'POST' && url.pathname === '/poll') {
        return jsonResponse({ submission: await coordinator.poll() });
      }
      throw new SubmitterProblem(404, 'ROUTE_NOT_FOUND', 'Submission object route not found.');
    } catch (error) {
      return problemResponse(error);
    }
  }

  #coordinator() {
    const config = loadSubmitterConfig(this.env);
    const signer = requireSignerNamespace(this.env).get(
      requireSignerNamespace(this.env).idFromName('bradbury-signer-v1'),
    );
    const readClient = createPinnedBradburyClient(config);
    return new OwnershipSubmissionCoordinator({
      store: durableStore(this.state.storage),
      client: Object.freeze({
        readExistingResult: (requestId) => readClient.readExistingResult(requestId),
        getTransaction: (txHash) => readClient.getTransaction(txHash),
        readFinalResult: (requestId) => readClient.readFinalResult(requestId),
        async submitOwnership(envelope) {
          const response = await signer.fetch(
            new Request('https://xproof-submit.internal/sign', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(envelope),
            }),
          );
          const body = await response.json().catch(() => null);
          if (!response.ok || typeof body?.txHash !== 'string') {
            throw new SubmitterProblem(
              503,
              'SIGNER_UNAVAILABLE',
              'The serialized Bradbury signer did not accept the submission.',
            );
          }
          return body.txHash;
        },
      }),
    });
  }

  #exclusive(operation) {
    const next = this.operation.then(operation, operation);
    this.operation = next.catch(() => undefined);
    return next;
  }
}

export class BradburySignerObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.signer = new SerializedBradburySigner(
      createPinnedBradburyClient(loadSubmitterConfig(env)),
    );
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== '/sign') {
        throw new SubmitterProblem(404, 'ROUTE_NOT_FOUND', 'Signer route not found.');
      }
      const envelope = await validateOwnershipEnvelope(await request.json());
      return jsonResponse({ txHash: await this.signer.submit(envelope) }, 202);
    } catch (error) {
      return problemResponse(error);
    }
  }
}

function durableStore(storage) {
  return Object.freeze({
    get: () => storage.get('submission'),
    put: (record) => storage.put('submission', record),
    setAlarm: (timestamp) => storage.setAlarm(timestamp),
  });
}

function requireNamespace(env) {
  const namespace = env?.XPROOF_SUBMISSIONS;
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') {
    throw new SubmitterProblem(
      503,
      'SUBMITTER_STORAGE_UNAVAILABLE',
      'The private Durable Object binding is unavailable.',
    );
  }
  return namespace;
}

function requireSignerNamespace(env) {
  const namespace = env?.XPROOF_SIGNER;
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') {
    throw new SubmitterProblem(
      503,
      'SUBMITTER_SIGNER_UNAVAILABLE',
      'The singleton Bradbury signer binding is unavailable.',
    );
  }
  return namespace;
}

async function readJsonBody(request) {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new SubmitterProblem(415, 'JSON_REQUIRED', 'Content-Type must be application/json.');
  }
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_REQUEST_BYTES)) {
    throw new SubmitterProblem(413, 'REQUEST_TOO_LARGE', 'The submission body is too large.');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new SubmitterProblem(413, 'REQUEST_TOO_LARGE', 'The submission body is too large.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SubmitterProblem(400, 'INVALID_JSON', 'The submission body is not valid JSON.');
  }
}
