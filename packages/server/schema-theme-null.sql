-- 6.2.0 controlled, offline theme migration. The caller owns the transaction.
-- Retain until every controlled database has completed the 6.2.0 upgrade.
DO $theme_null$
DECLARE
  required_value boolean;
  default_value text;
  changed_rows bigint;
BEGIN
  SELECT a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
    INTO STRICT required_value, default_value
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid='public.metadata'::regclass AND a.attname='theme'
     AND NOT a.attisdropped;

  IF NOT required_value AND default_value IS NULL THEN
    IF EXISTS (SELECT 1 FROM theme WHERE slug='none') THEN
      RAISE EXCEPTION 'Nullable theme schema still has the old reserved theme; inspect the database before proceeding';
    END IF;
    RETURN;
  END IF;
  IF NOT required_value OR default_value IS DISTINCT FROM '''none''::text' THEN
    RAISE EXCEPTION 'Unexpected metadata.theme contract; only the sealed NOT NULL DEFAULT none baseline is supported';
  END IF;

  ALTER TABLE metadata ALTER COLUMN theme DROP NOT NULL;
  ALTER TABLE metadata ALTER COLUMN theme DROP DEFAULT;
  UPDATE metadata SET theme=NULL WHERE theme='none';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  DELETE FROM theme WHERE slug='none';
  UPDATE ready_image_revision SET revision=revision+1, updated_at=now()
   WHERE singleton=1;
  RAISE NOTICE 'Converted % image theme associations to NULL', changed_rows;
END;
$theme_null$;

-- 6.2.0 also retires the image-list layout preference; preserve other choices.
UPDATE admin_account
   SET preferences=preferences-'image_card_density'
 WHERE preferences ? 'image_card_density';
