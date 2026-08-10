-- Cumulative, behavior-neutral additions for existing ImageShow databases.
-- Keep this file small and append only reviewed nullable columns, columns with
-- simple constant defaults, their directly required indexes, or stable system
-- seeds that never overwrite an existing row.

DO $imageshow_additions$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid=to_regclass('public.metadata')
       AND attname='purge_error'
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    ALTER TABLE public.metadata ADD COLUMN purge_error TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid=to_regclass('public.admin_account')
       AND attname='preferences'
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    ALTER TABLE public.admin_account
      ADD COLUMN preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
  END IF;
END
$imageshow_additions$;

INSERT INTO public.theme(slug, display_name)
VALUES ('none', '未设置')
ON CONFLICT (slug) DO NOTHING;
