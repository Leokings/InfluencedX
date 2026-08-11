BEGIN;

ALTER TABLE xproof_bradbury_submission_status
  DROP CONSTRAINT IF EXISTS xproof_bradbury_submission_status_function_name_check;
ALTER TABLE xproof_bradbury_submission_status
  ADD CONSTRAINT xproof_bradbury_submission_status_function_name_check
  CHECK (function_name IN ('verify_ownership', 'resolve_submission', 'snapshot_metrics'));

ALTER TABLE xproof_bradbury_submission_status
  ADD COLUMN IF NOT EXISTS result_json jsonb;
ALTER TABLE xproof_bradbury_submission_status
  DROP CONSTRAINT IF EXISTS xproof_bradbury_submission_status_result_json_check;
ALTER TABLE xproof_bradbury_submission_status
  ADD CONSTRAINT xproof_bradbury_submission_status_result_json_check
  CHECK (
    result_json IS NULL
    OR (
      function_name = 'snapshot_metrics'
      AND jsonb_typeof(result_json) = 'object'
      AND result_json ?& ARRAY[
        'kind', 'request_id', 'base_wallet', 'identity_hash', 'handle',
        'x_user_id', 'outcome', 'identity_match', 'protected', 'http_status',
        'measured_at_epoch', 'metrics_expires_at_epoch',
        'account_created_at_ms', 'followers', 'following', 'total_posts',
        'posts_analyzed', 'median_likes', 'median_replies',
        'median_reposts', 'median_views', 'engagement_rate_bps',
        'engagement_consistency'
      ]
    )
  );

ALTER TABLE xproof_bradbury_submission_jobs
  DROP CONSTRAINT IF EXISTS xproof_bradbury_submission_jobs_envelope_json_check;
ALTER TABLE xproof_bradbury_submission_jobs
  ADD CONSTRAINT xproof_bradbury_submission_jobs_envelope_json_check
  CHECK (
    envelope_json IS NULL
    OR (
      jsonb_typeof(envelope_json) = 'object'
      AND (
        envelope_json ?& ARRAY[
          'schemaVersion', 'requestId', 'baseWallet', 'expectedHandle',
          'postId', 'challenge', 'issuedAtEpoch', 'expiresAtEpoch',
          'credentialExpiresAtEpoch'
        ]
        OR
        envelope_json ?& ARRAY[
          'schemaVersion', 'kind', 'requestId', 'expectedHandle', 'postId',
          'requiredPhrasesJson', 'forbiddenPhrasesJson', 'requireAdDisclosure',
          'semanticBrief', 'resolveNotBeforeEpoch', 'assignmentId',
          'agreementHash', 'submissionHash'
        ]
        OR
        envelope_json ?& ARRAY[
          'schemaVersion', 'kind', 'requestId', 'baseWallet', 'identityHash',
          'expectedHandle', 'metricsExpiresAtEpoch'
        ]
      )
    )
  );

COMMIT;
