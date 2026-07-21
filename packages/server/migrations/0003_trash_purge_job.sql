ALTER TABLE background_job
  DROP CONSTRAINT background_job_type_check;

ALTER TABLE background_job
  ADD CONSTRAINT background_job_type_check
  CHECK (type IN (
    'thumb.generate',
    'move.cleanup',
    'import.cleanup',
    'trash.purge',
    'cache.rebuild'
  ));
