import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = resolve(import.meta.dirname, "../../../..");
const moduleUrl = (relativePath: string) => (
  pathToFileURL(resolve(workspace, relativePath)).href
);
const [host, port, name, user, password] = process.argv.slice(2);
const databasePools = await import(moduleUrl("packages/server/src/core/database/pools.ts"));
databasePools.configureDatabasePools({
  host,
  port: Number(port),
  name,
  user,
  password
});
const databaseSchema = await import(moduleUrl("packages/server/src/core/database/schema.ts"));
let maximumConcurrentQueries = 0;
databasePools.pool.on("connect", (client: {
  query: (...args: unknown[]) => Promise<unknown>;
}) => {
  const query = client.query.bind(client);
  let activeQueries = 0;
  client.query = async (...args: unknown[]) => {
    maximumConcurrentQueries = Math.max(maximumConcurrentQueries, ++activeQueries);
    try { return await query(...args); }
    finally { activeQueries--; }
  };
});
try {
  await databaseSchema.initializeDatabaseSchema();
  if (maximumConcurrentQueries !== 1) {
    throw new Error("startup must execute one SQL query at a time per client: " + maximumConcurrentQueries);
  }
} finally {
  await databasePools.closeDatabasePools();
}
