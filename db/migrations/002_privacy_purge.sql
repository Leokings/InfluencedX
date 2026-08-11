ALTER TABLE x_accounts ALTER COLUMN x_user_id DROP NOT NULL;
ALTER TABLE x_accounts ALTER COLUMN current_handle DROP NOT NULL;
ALTER TABLE submissions ALTER COLUMN x_post_id DROP NOT NULL;
ALTER TABLE submissions ALTER COLUMN x_post_url DROP NOT NULL;

CREATE OR REPLACE FUNCTION purge_creator_x_data(target_creator_profile_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  target_x_account_id uuid;
BEGIN
  SELECT id INTO target_x_account_id
  FROM x_accounts
  WHERE creator_profile_id = target_creator_profile_id
  FOR UPDATE;

  IF target_x_account_id IS NULL THEN
    RAISE EXCEPTION 'X account not found for creator profile %', target_creator_profile_id;
  END IF;

  DELETE FROM creator_metric_snapshots
  WHERE x_account_id = target_x_account_id;

  DELETE FROM x_verification_challenges
  WHERE creator_profile_id = target_creator_profile_id;

  UPDATE submissions
  SET x_post_id = NULL,
      x_post_url = NULL,
      source_status = 'deleted',
      deletion_requested_at = COALESCE(deletion_requested_at, now()),
      deleted_at = now()
  WHERE creator_profile_id = target_creator_profile_id;

  UPDATE x_accounts
  SET x_user_id = NULL,
      current_handle = NULL,
      source_status = 'deleted',
      deletion_requested_at = COALESCE(deletion_requested_at, now()),
      deleted_at = now(),
      updated_at = now()
  WHERE id = target_x_account_id;
END;
$$;

COMMENT ON FUNCTION purge_creator_x_data(uuid) IS
  'Irreversibly removes stored X identifiers, challenges, metric rows, and post URLs while retaining commitments needed for chain reconciliation.';
