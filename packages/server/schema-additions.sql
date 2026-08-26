-- Current-release additions contain only explicitly reviewed, bounded schema
-- changes or one-time data changes for the active release cycle.
-- After every controlled database has applied an entry, the following release
-- moves it into schema.sql and removes it here. Keep this asset as a comment-only
-- placeholder when no delta is pending; do not skip a release carrying entries.
-- The schema bootstrap owns the transaction that covers this file and the
-- following readiness check. Do not add transaction control statements here.

-- 5.0.1 removes the retired PostgreSQL import workspace after proving it is
-- empty. ACCESS EXCLUSIVE closes the check/drop race; omitting CASCADE makes
-- any deployment-owned dependency fail the surrounding startup transaction.
DO $$
DECLARE
  legacy_rows_exist BOOLEAN;
BEGIN
  IF to_regclass('public.import_session') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE public.import_session IN ACCESS EXCLUSIVE MODE';
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.import_session)'
      INTO legacy_rows_exist;
    IF legacy_rows_exist THEN
      RAISE EXCEPTION
        'legacy public.import_session must be empty before removal'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    EXECUTE 'DROP TABLE public.import_session';
  END IF;
END
$$;

-- 5.0.1 also removes the project's known historical background job enum while
-- preserving deployment-owned CHECK constraints. The fixed current marker is
-- accepted only when its behavior matches the current enum. Unsupported rows
-- are not deleted automatically; they abort the same startup transaction.
DO $$
DECLARE
  current_constraint_expression TEXT;
  current_constraint_oid OID;
  current_constraint_validated BOOLEAN := FALSE;
  current_constraint_is_valid BOOLEAN := FALSE;
  historical_constraint_expression TEXT;
  historical_constraint_name TEXT;
  historical_constraint_oid OID;
  historical_constraint_is_legacy BOOLEAN := FALSE;
  type_attribute SMALLINT;
  unsupported_type TEXT;
BEGIN
  IF to_regclass('public.background_job') IS NOT NULL THEN
    LOCK TABLE public.background_job IN ACCESS EXCLUSIVE MODE;
    SELECT attribute.attnum::SMALLINT
      INTO type_attribute
      FROM pg_attribute attribute
     WHERE attribute.attrelid = 'public.background_job'::regclass
       AND attribute.attname = 'type'
       AND NOT attribute.attisdropped;

    IF type_attribute IS NOT NULL THEN
      SELECT current_constraint.oid,
             current_constraint.convalidated,
             pg_get_expr(
               current_constraint.conbin,
               current_constraint.conrelid
             )
        INTO current_constraint_oid,
             current_constraint_validated,
             current_constraint_expression
        FROM pg_constraint current_constraint
       WHERE current_constraint.conrelid = 'public.background_job'::regclass
         AND current_constraint.conname = 'background_job_current_type_check'
         AND current_constraint.contype = 'c'
         AND current_constraint.conkey = ARRAY[type_attribute]::SMALLINT[];

      IF current_constraint_oid IS NOT NULL THEN
        current_constraint_is_valid = current_constraint_validated
          AND current_constraint_expression =
            '(type = ANY (ARRAY[''move.cleanup''::text, '
            || '''trash.purge''::text, ''cache.rebuild''::text]))';
      END IF;

      SELECT historical_constraint.oid,
             historical_constraint.conname,
             pg_get_expr(
               historical_constraint.conbin,
               historical_constraint.conrelid
             )
        INTO historical_constraint_oid,
             historical_constraint_name,
             historical_constraint_expression
        FROM pg_constraint historical_constraint
       WHERE historical_constraint.conrelid = 'public.background_job'::regclass
         AND historical_constraint.conname = 'background_job_type_check'
         AND historical_constraint.contype = 'c'
         AND historical_constraint.convalidated
         AND historical_constraint.conkey = ARRAY[type_attribute]::SMALLINT[];

      IF historical_constraint_oid IS NOT NULL THEN
        historical_constraint_is_legacy = historical_constraint_expression IN (
          '(type = ANY (ARRAY[''move.cleanup''::text, '
            || '''import.cleanup''::text, ''trash.purge''::text, '
            || '''cache.rebuild''::text]))',
          '(type = ANY (ARRAY[''thumb.generate''::text, '
            || '''move.cleanup''::text, ''import.cleanup''::text, '
            || '''trash.purge''::text, ''cache.rebuild''::text]))'
        );
      END IF;

      IF NOT current_constraint_is_valid
        OR historical_constraint_is_legacy
      THEN
        SELECT job.type
          INTO unsupported_type
          FROM public.background_job job
         WHERE job.type NOT IN ('move.cleanup', 'trash.purge', 'cache.rebuild')
         LIMIT 1;
        IF unsupported_type IS NOT NULL THEN
          RAISE EXCEPTION
            'unsupported historical background_job type % must be removed before constraint cleanup',
            unsupported_type
            USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;

        IF current_constraint_oid IS NOT NULL
          AND NOT current_constraint_is_valid
        THEN
          EXECUTE format(
            'ALTER TABLE public.background_job DROP CONSTRAINT %I',
            'background_job_current_type_check'
          );
        END IF;

        IF historical_constraint_is_legacy THEN
          EXECUTE format(
            'ALTER TABLE public.background_job DROP CONSTRAINT %I',
            historical_constraint_name
          );
        END IF;

        IF NOT current_constraint_is_valid THEN
          ALTER TABLE public.background_job
            ADD CONSTRAINT background_job_current_type_check
            CHECK (type IN ('move.cleanup', 'trash.purge', 'cache.rebuild'));
        END IF;
      END IF;
    END IF;
  END IF;
END
$$;
