BEGIN;

ALTER TABLE xproof_bradbury_submission_status
  DROP CONSTRAINT IF EXISTS xproof_bradbury_submission_status_function_name_check;
ALTER TABLE xproof_bradbury_submission_status
  ADD CONSTRAINT xproof_bradbury_submission_status_function_name_check
  CHECK (function_name IN ('verify_ownership', 'resolve_submission'));

ALTER TABLE xproof_bradbury_submission_status
  DROP CONSTRAINT IF EXISTS xproof_bradbury_submission_status_result_outcome_check;
ALTER TABLE xproof_bradbury_submission_status
  ADD CONSTRAINT xproof_bradbury_submission_status_result_outcome_check
  CHECK (
    result_outcome IS NULL
    OR result_outcome IN ('VERIFIED', 'REJECTED', 'PASS', 'FAIL', 'UNDETERMINED')
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
      )
    )
  );

CREATE INDEX IF NOT EXISTS xproof_bradbury_status_function_idx
  ON xproof_bradbury_submission_status (function_name, status, updated_at DESC);

COMMIT;
