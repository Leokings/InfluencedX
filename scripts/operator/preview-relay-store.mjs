import { Client } from 'pg';

const ALLOWED_PRE_RELAY_STATUSES = new Set(['NOT_STARTED', 'QUORUM_PENDING', 'FAILED']);
const BRADBURY_NETWORK = 'testnet-bradbury';
const BRADBURY_METHOD = 'verify_ownership';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function rows(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function lower(value) {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

function exactStateQueries(binding, { forUpdate = false } = {}) {
  return {
    verification: {
      text: `
        select
          id, status, request_expires_at, wallet, finalized_request_id,
          receiver_contract, genlayer_contract, intent_signature_status,
          sealed_evidence_ciphertext is not null as sealed_ciphertext_present,
          sealed_evidence_hash is not null as sealed_hash_present,
          sealed_evidence_expires_at, sealed_evidence_purged_at,
          submission_status, genlayer_tx_hash, genlayer_outcome,
          genlayer_error_code, genlayer_finalized_at,
          base_relay_status, base_relay_tx_hash, base_confirmed_at,
          base_profile_verified, credential_expires_at
        from verification_requests
        where finalized_request_id = $1
        limit 1
        ${forUpdate ? 'for update' : ''}
      `,
      values: [binding.requestId],
    },
    bradbury: {
      text: `
        select request_id, status, network, resolver, function_name,
          lifecycle_status, execution_result, result_outcome, tx_hash,
          error_code, finalized_at
        from xproof_bradbury_submission_status
        where request_id = $1
        limit 1
      `,
      values: [binding.requestId],
    },
  };
}

export function assertExactPreviewRelayState({ verification, bradbury, binding, nowMs }) {
  invariant(verification, 'The exact verification request is unavailable');
  invariant(bradbury, 'The exact Bradbury terminal projection is unavailable');
  const rowReady = verification.status === 'READY_FOR_GENLAYER'
    && Number(verification.request_expires_at) > nowMs
    && lower(verification.wallet) === lower(binding.expectedWallet)
    && verification.finalized_request_id === binding.requestId
    && lower(verification.receiver_contract) === lower(binding.baseReceiver)
    && lower(verification.genlayer_contract) === lower(binding.resolver)
    && verification.intent_signature_status === 'VERIFIED'
    && verification.sealed_ciphertext_present === true
    && verification.sealed_hash_present === true
    && verification.sealed_evidence_purged_at === null
    && Number(verification.sealed_evidence_expires_at) > nowMs
    && verification.submission_status === 'FINALIZED'
    && lower(verification.genlayer_tx_hash) === binding.genlayerTxHash
    && verification.genlayer_outcome === 'VERIFIED'
    && verification.genlayer_error_code === null
    && verification.genlayer_finalized_at !== null
    && Number(verification.credential_expires_at) > nowMs
    && ALLOWED_PRE_RELAY_STATUSES.has(verification.base_relay_status)
    && verification.base_relay_tx_hash === null
    && verification.base_confirmed_at === null
    && verification.base_profile_verified === false;
  invariant(rowReady, 'The exact Preview verification row is not relayable');

  const bradburyReady = bradbury.request_id === binding.requestId
    && bradbury.status === 'FINALIZED'
    && bradbury.network === BRADBURY_NETWORK
    && lower(bradbury.resolver) === lower(binding.resolver)
    && bradbury.function_name === BRADBURY_METHOD
    && bradbury.lifecycle_status === 'FINALIZED'
    && bradbury.execution_result === 'FINISHED_WITH_RETURN'
    && bradbury.result_outcome === 'VERIFIED'
    && lower(bradbury.tx_hash) === binding.genlayerTxHash
    && bradbury.error_code === null
    && bradbury.finalized_at !== null;
  invariant(bradburyReady, 'The Bradbury proof is not FINALIZED with a successful VERIFIED execution');
  return verification;
}

export class PreviewRelayStore {
  constructor({ databaseUrl, clientFactory = (configuration) => new Client(configuration) }) {
    invariant(typeof databaseUrl === 'string' && databaseUrl.length > 0, 'Preview DATABASE_URL is required');
    this.client = clientFactory({ connectionString: databaseUrl, application_name: 'xproof-preview-base-relay' });
    this.connected = false;
    this.closed = false;
  }

  async connect() {
    invariant(!this.closed, 'Preview relay store is closed');
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.connected) await this.client.end();
  }

  async readExactState(binding, nowMs) {
    const queries = exactStateQueries(binding);
    const [verificationResult, bradburyResult] = await Promise.all([
      this.client.query(queries.verification),
      this.client.query(queries.bradbury),
    ]);
    const verification = rows(verificationResult)[0];
    const bradbury = rows(bradburyResult)[0];
    assertExactPreviewRelayState({ verification, bradbury, binding, nowMs });
    return Object.freeze({ verificationId: verification.id });
  }

  async createGrantAndMarkQuorum({ grant, binding, nowMs }) {
    await this.client.query('begin');
    try {
      const queries = exactStateQueries(binding, { forUpdate: true });
      const verificationResult = await this.client.query(queries.verification);
      const bradburyResult = await this.client.query(queries.bradbury);
      const verification = rows(verificationResult)[0];
      const bradbury = rows(bradburyResult)[0];
      assertExactPreviewRelayState({ verification, bradbury, binding, nowMs });

      const updated = await this.client.query({
        text: `
          update verification_requests
          set base_relay_status = 'QUORUM_PENDING',
              base_relay_updated_at = $2,
              base_relay_error_code = null,
              updated_at = $2,
              revision = revision + 1
          where id = $1
            and base_relay_status = $3
            and base_relay_tx_hash is null
            and base_confirmed_at is null
            and base_profile_verified is false
          returning id
        `,
        values: [verification.id, nowMs, verification.base_relay_status],
      });
      invariant(rows(updated).length === 1, 'The relay row changed before quorum preparation');
      await this.client.query({
        text: `
          insert into ownership_authorization_grants (
            token_hash, request_id, genlayer_tx_hash, resolver_address,
            base_receiver_address, base_registry_address, expected_wallet,
            expires_at, consumed_at, consumer_key_fingerprint, created_at
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,null,null,$9)
        `,
        values: [
          grant.tokenHash,
          grant.requestId,
          grant.genlayerTxHash,
          grant.resolverAddress,
          grant.baseReceiverAddress,
          grant.baseRegistryAddress,
          grant.expectedWallet,
          grant.expiresAt,
          grant.createdAt,
        ],
      });
      await this.client.query('commit');
    } catch (error) {
      await this.client.query('rollback').catch(() => {});
      throw error;
    }
  }

  async deleteGrantIfUnconsumed(tokenHash) {
    await this.client.query({
      text: 'delete from ownership_authorization_grants where token_hash = $1 and consumed_at is null',
      values: [tokenHash],
    });
  }

  async markBroadcasting({ binding, nowMs }) {
    const result = await this.client.query({
      text: `
        update verification_requests
        set base_relay_status = 'BROADCASTING',
            base_relay_updated_at = $2,
            base_relay_error_code = null,
            updated_at = $2,
            revision = revision + 1
        where finalized_request_id = $1
          and base_relay_status = 'QUORUM_PENDING'
          and submission_status = 'FINALIZED'
          and genlayer_outcome = 'VERIFIED'
          and genlayer_error_code is null
          and genlayer_tx_hash = $3
          and lower(genlayer_contract) = lower($4)
          and lower(receiver_contract) = lower($5)
          and lower(wallet) = lower($6)
          and base_relay_tx_hash is null
          and base_confirmed_at is null
          and base_profile_verified is false
        returning id
      `,
      values: [
        binding.requestId,
        nowMs,
        binding.genlayerTxHash,
        binding.resolver,
        binding.baseReceiver,
        binding.expectedWallet,
      ],
    });
    invariant(rows(result).length === 1, 'The exact relay row could not enter BROADCASTING');
  }

  async recordBroadcastHash({ binding, transactionHash, nowMs }) {
    const result = await this.client.query({
      text: `
        update verification_requests
        set base_relay_tx_hash = $2,
            base_relay_updated_at = $3,
            updated_at = $3,
            revision = revision + 1
        where finalized_request_id = $1
          and base_relay_status = 'BROADCASTING'
          and base_relay_tx_hash is null
          and base_confirmed_at is null
        returning id
      `,
      values: [binding.requestId, transactionHash, nowMs],
    });
    invariant(rows(result).length === 1, 'The broadcast transaction hash could not be fenced');
  }

  async markReconciliationRequired({ binding, transactionHash = null, nowMs }) {
    const result = await this.client.query({
      text: `
        update verification_requests
        set base_relay_status = 'RECONCILIATION_REQUIRED',
            base_relay_tx_hash = coalesce(base_relay_tx_hash, $2),
            base_relay_updated_at = $3,
            base_relay_error_code = 'BASE_RELAY_UNCERTAIN',
            updated_at = $3,
            revision = revision + 1
        where finalized_request_id = $1
          and base_relay_status = 'BROADCASTING'
          and ($2::text is null or base_relay_tx_hash is null or base_relay_tx_hash = $2)
        returning id
      `,
      values: [binding.requestId, transactionHash, nowMs],
    });
    invariant(rows(result).length === 1, 'The uncertain Base relay could not be quarantined');
  }

  async resetAfterProvenNoBroadcast({ binding, nowMs }) {
    const result = await this.client.query({
      text: `
        update verification_requests
        set base_relay_status = 'QUORUM_PENDING',
            base_relay_updated_at = $2,
            base_relay_error_code = null,
            updated_at = $2,
            revision = revision + 1
        where finalized_request_id = $1
          and base_relay_status = 'RECONCILIATION_REQUIRED'
          and base_relay_error_code = 'BASE_RELAY_UNCERTAIN'
          and base_relay_tx_hash is null
          and base_confirmed_at is null
          and base_profile_verified is false
          and submission_status = 'FINALIZED'
          and genlayer_outcome = 'VERIFIED'
          and genlayer_error_code is null
          and genlayer_tx_hash = $3
          and lower(genlayer_contract) = lower($4)
          and lower(receiver_contract) = lower($5)
          and lower(wallet) = lower($6)
          and sealed_evidence_ciphertext is not null
          and sealed_evidence_hash is not null
          and sealed_evidence_purged_at is null
        returning id
      `,
      values: [
        binding.requestId,
        nowMs,
        binding.genlayerTxHash,
        binding.resolver,
        binding.baseReceiver,
        binding.expectedWallet,
      ],
    });
    invariant(rows(result).length === 1,
      'The quarantined relay row changed before no-broadcast reconciliation');
  }

  async markConfirmed({ binding, transactionHash, profile, nowMs }) {
    await this.client.query('begin');
    try {
      const result = await this.client.query({
        text: `
          update verification_requests
          set base_relay_status = 'CONFIRMED',
              base_relay_updated_at = $3,
              base_confirmed_at = $3,
              base_relay_error_code = null,
              base_registry_address = $4,
              base_profile_id = $5,
              base_profile_identity_hash = $6,
              base_profile_handle_hash = $7,
              base_profile_verification_post_hash = $8,
              base_profile_expires_at = $9,
              base_profile_active = true,
              base_profile_verified = true,
              sealed_evidence_ciphertext = null,
              sealed_evidence_hash = null,
              sealed_evidence_purged_at = $3,
              updated_at = $3,
              revision = revision + 1
          where finalized_request_id = $1
            and base_relay_status = 'BROADCASTING'
            and base_relay_tx_hash = $2
            and base_confirmed_at is null
            and submission_status = 'FINALIZED'
            and genlayer_outcome = 'VERIFIED'
            and genlayer_error_code is null
            and genlayer_tx_hash = $10
            and lower(genlayer_contract) = lower($11)
            and lower(receiver_contract) = lower($12)
            and lower(wallet) = lower($13)
            and sealed_evidence_ciphertext is not null
            and sealed_evidence_hash is not null
            and sealed_evidence_purged_at is null
          returning id
        `,
        values: [
          binding.requestId,
          transactionHash,
          nowMs,
          binding.baseRegistry,
          profile.profileId,
          profile.identityHash,
          profile.handleHash,
          profile.verificationPostHash,
          profile.expiresAtMs,
          binding.genlayerTxHash,
          binding.resolver,
          binding.baseReceiver,
          binding.expectedWallet,
        ],
      });
      invariant(rows(result).length === 1, 'The confirmed Base profile could not be committed');
      await this.client.query('commit');
    } catch (error) {
      await this.client.query('rollback').catch(() => {});
      throw error;
    }
  }

  async markConfirmedFromReconciliation({ binding, transactionHash, profile, nowMs }) {
    await this.client.query('begin');
    try {
      const result = await this.client.query({
        text: `
          update verification_requests
          set base_relay_status = 'CONFIRMED',
              base_relay_updated_at = $3,
              base_confirmed_at = $3,
              base_relay_error_code = null,
              base_registry_address = $4,
              base_profile_id = $5,
              base_profile_identity_hash = $6,
              base_profile_handle_hash = $7,
              base_profile_verification_post_hash = $8,
              base_profile_expires_at = $9,
              base_profile_active = true,
              base_profile_verified = true,
              sealed_evidence_ciphertext = null,
              sealed_evidence_hash = null,
              sealed_evidence_purged_at = $3,
              updated_at = $3,
              revision = revision + 1
          where finalized_request_id = $1
            and base_relay_status = 'RECONCILIATION_REQUIRED'
            and base_relay_error_code = 'BASE_RELAY_UNCERTAIN'
            and base_relay_tx_hash = $2
            and base_confirmed_at is null
            and base_profile_verified is false
            and submission_status = 'FINALIZED'
            and genlayer_outcome = 'VERIFIED'
            and genlayer_error_code is null
            and genlayer_tx_hash = $10
            and lower(genlayer_contract) = lower($11)
            and lower(receiver_contract) = lower($12)
            and lower(wallet) = lower($13)
            and sealed_evidence_ciphertext is not null
            and sealed_evidence_hash is not null
            and sealed_evidence_purged_at is null
          returning id
        `,
        values: [
          binding.requestId,
          transactionHash,
          nowMs,
          binding.baseRegistry,
          profile.profileId,
          profile.identityHash,
          profile.handleHash,
          profile.verificationPostHash,
          profile.expiresAtMs,
          binding.genlayerTxHash,
          binding.resolver,
          binding.baseReceiver,
          binding.expectedWallet,
        ],
      });
      invariant(rows(result).length === 1,
        'The reconciled Base profile could not be committed');
      await this.client.query('commit');
    } catch (error) {
      await this.client.query('rollback').catch(() => {});
      throw error;
    }
  }
}
