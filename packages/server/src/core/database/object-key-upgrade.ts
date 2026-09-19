import type { PoolClient } from "pg";

/** v6.4.9 maintenance-window upgrade; removed after deployments cross this release. */
export async function upgradeObjectKeyColumn(client: PoolClient) {
  const column = () => client.query<{ attnum: number; supported: boolean }>(
    `SELECT a.attnum,
            a.atttypid='text'::regtype AND a.attnotnull
            AND NOT a.atthasdef AND a.attgenerated='' AND a.attidentity=''
            AND c.relkind='r' AND NOT c.relispartition AS supported
       FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      WHERE a.attrelid=to_regclass('public.metadata')
        AND a.attname='object_key' AND NOT a.attisdropped`
  );
  if (!(await column()).rowCount) {
    return false;
  }
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("LOCK TABLE public.metadata IN ACCESS EXCLUSIVE MODE");
  const lockedColumn = (await column()).rows[0];
  if (!lockedColumn) return false;
  if (!lockedColumn.supported) throw new Error("object_key upgrade: unsupported column structure");
  const inherited = await client.query(
    `SELECT 1 FROM pg_inherits
      WHERE inhrelid='public.metadata'::regclass OR inhparent='public.metadata'::regclass`
  );
  if (inherited.rowCount) throw new Error("object_key upgrade: inherited metadata is unsupported");

  // DROP COLUMN RESTRICT alone also removes table-local indexes and expressions.
  // Follow the exact dependency closure. Some upgraded databases retain the
  // expression index from v4.7-v6.3, so require its complete known definition.
  const dependencies = await client.query<{ supported: boolean }>(
    `WITH RECURSIVE dependencies(classid, objid, objsubid) AS (
       SELECT classid, objid, objsubid FROM pg_depend
        WHERE refclassid='pg_class'::regclass
          AND refobjid='public.metadata'::regclass AND refobjsubid=$1
       UNION
       SELECT d.classid, d.objid, d.objsubid FROM pg_depend d
         JOIN dependencies p ON d.refclassid=p.classid
          AND d.refobjid=p.objid AND d.refobjsubid=p.objsubid
     ), expected_constraints AS (
       SELECT oid, conindid FROM pg_constraint
        WHERE conrelid='public.metadata'::regclass
          AND conkey=ARRAY[$1]::smallint[] AND NOT condeferrable
          AND convalidated AND conislocal AND coninhcount=0
          AND ((contype='u' AND conname='metadata_object_key_key')
            OR (contype='n' AND conname='metadata_object_key_not_null'))
     )
     SELECT CASE
       WHEN d.classid='pg_constraint'::regclass THEN
         EXISTS (SELECT 1 FROM expected_constraints c WHERE c.oid=d.objid)
       WHEN d.classid='pg_class'::regclass THEN
         EXISTS (SELECT 1 FROM expected_constraints c JOIN pg_index i ON i.indexrelid=c.conindid
           JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_am am ON am.oid=idx.relam
           WHERE c.conindid=d.objid AND i.indrelid='public.metadata'::regclass
             AND i.indisunique AND i.indisvalid AND i.indisready
             AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indkey[0]=$1
             AND i.indexprs IS NULL AND i.indpred IS NULL AND am.amname='btree')
         OR EXISTS (SELECT 1 FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
           WHERE i.indexrelid=d.objid AND idx.relkind='i' AND i.indisvalid AND i.indisready
             AND pg_get_indexdef(i.indexrelid)=$2)
       ELSE false END AS supported
       FROM dependencies d`,
    [lockedColumn.attnum,
      "CREATE INDEX idx_metadata_thumb_key ON public.metadata USING btree "
        + "(regexp_replace(object_key, '\\.[^/.]+$'::text, '.webp'::text))"]
  );
  if (dependencies.rows.some((row) => !row.supported)) {
    throw new Error("object_key upgrade: unknown column dependency; inspect before retrying");
  }
  // A forced RLS policy must fail this full-data proof, never hide a bad path.
  await client.query("SET LOCAL row_security=off");
  const invalid = await client.query(
    `SELECT 1 FROM public.metadata
      WHERE id IS NULL OR ext IS NULL OR ext NOT IN ('jpg','png','webp','gif','avif')
         OR object_key IS DISTINCT FROM right(id::text, 2) || '/' || id::text || '.' || ext
      LIMIT 1`
  );
  const duplicates = await client.query(
    "SELECT 1 FROM public.metadata GROUP BY id HAVING count(*) > 1 LIMIT 1"
  );
  if (invalid.rowCount || duplicates.rowCount) {
    throw new Error("object_key upgrade: image identity or stored path mismatch; no data changed");
  }
  await client.query("ALTER TABLE public.metadata DROP COLUMN object_key RESTRICT");
  return true;
}
