-- Give already-prepared sessions an explicit image staging key before new
-- preparation attempts begin writing attempt-scoped object names.
ALTER TABLE import_session
ADD COLUMN execution_token UUID,
ADD COLUMN raw_token UUID;

UPDATE import_session
SET prepared_payload = prepared_payload || jsonb_build_object(
  'prepared_image_key', id::text || '.image.webp'
)
WHERE status IN ('ready', 'committing')
  AND NOT (prepared_payload ? 'prepared_image_key');
