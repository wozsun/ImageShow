import { readFile } from "node:fs/promises";
import { deploymentConfig } from "./config/deployment-config.ts";
import {
  closeDatabasePools,
  configureDatabasePools,
  pool
} from "./core/database/pools.ts";
import { assertDatabaseReadiness } from "./core/database/readiness.ts";
import { databaseAssetPath } from "./core/database/schema.ts";

const args = process.argv.slice(2);
if (args.join(" ") !== "--inspect" && args.join(" ") !== "--apply --offline") {
  throw new Error("Usage: theme-null-migration-cli --inspect | --apply --offline (stop ImageShow and back up PostgreSQL, Redis and data first)");
}
configureDatabasePools(deploymentConfig.database);
const client = await pool.connect();
async function readMigrationSummary() {
  return (await client.query(
    `SELECT current_database() AS database,
            count(*)::text AS total_images,
            count(*) FILTER (WHERE theme='none' AND status='ready')::text AS ready_to_convert,
            count(*) FILTER (WHERE theme='none' AND status='deleted')::text AS trash_to_convert,
            count(*) FILTER (WHERE theme IS NULL)::text AS unset_images,
            count(*) FILTER (WHERE theme IS NOT NULL AND theme <> 'none')::text AS themed_images,
            (SELECT count(*)::text FROM admin_account
              WHERE preferences ? 'image_card_density') AS layout_preferences_to_clear
       FROM metadata`
  )).rows[0];
}

try {
  const apply = args[0] === "--apply";
  await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
  await client.query("SET LOCAL lock_timeout='10s'");
  await client.query("SET LOCAL statement_timeout='10min'");
  if (apply) {
    const others = (await client.query(
      `SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND pid <> pg_backend_pid()
          AND backend_type='client backend'`
    )).rows[0].count;
    if (others !== 0) throw new Error("Database has other clients; stop ImageShow and all writers before this offline migration");
    await client.query("LOCK TABLE theme, metadata, ready_image_revision, admin_account IN ACCESS EXCLUSIVE MODE");
  }
  const before = await readMigrationSummary();
  console.log(JSON.stringify({ mode: apply ? "apply" : "inspect", before }));
  if (apply) {
    await client.query(await readFile(databaseAssetPath("schema-theme-null.sql"), "utf8"));
    await assertDatabaseReadiness(client);
    console.log(JSON.stringify({ pending_commit: await readMigrationSummary() }));
  }
  await client.query("COMMIT");
  console.log(apply ? "6.2.0 migration committed; start ImageShow 6.2.0 to rebuild derived caches." : "Inspection complete; no data changed.");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await closeDatabasePools();
}
