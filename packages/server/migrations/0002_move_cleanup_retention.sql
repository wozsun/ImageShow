-- Exhausted object-deletion work is also the durable ownership receipt for
-- its captured physical namespace. Mark existing rows so generic job-history
-- pruning cannot discard that protection.
UPDATE background_job
SET payload = jsonb_set(
  COALESCE(payload, '{}'::jsonb),
  '{retain_exhausted}',
  'true'::jsonb,
  true
)
WHERE type = 'move.cleanup'
  AND payload->>'retain_exhausted' IS DISTINCT FROM 'true';
