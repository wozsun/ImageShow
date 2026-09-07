import type { Pool, PoolClient, QueryResult } from "pg";
import { installProperties } from "../../support/property-descriptors.ts";

export function interceptPoolConnections(
  pool: Pool,
  connected: (client: PoolClient) => void | (() => void)
) {
  const connect = pool.connect;
  const restoreClients: Array<() => void> = [];
  const restore = installProperties(pool, {
    connect(...args: unknown[]) {
      const result = Reflect.apply(connect, pool, args);
      if (typeof args.at(-1) === "function") return result;
      return (result as Promise<PoolClient>).then((client) => {
        const restoreClient = connected(client);
        if (restoreClient) restoreClients.push(restoreClient);
        return client;
      });
    }
  });
  return () => {
    restore();
    for (const restoreClient of restoreClients.reverse()) restoreClient();
  };
}

export function interceptSqlQueries(
  target: Pool | PoolClient,
  intercept: (sql: string, values: unknown, query: () => Promise<QueryResult>) => Promise<QueryResult>
) {
  const original = target.query;
  return installProperties(target, {
    query(sql: unknown, ...args: unknown[]) {
      const query = () => Reflect.apply(original, target, [sql, ...args]) as Promise<QueryResult>;
      return typeof sql === "string" && typeof args.at(-1) !== "function"
        ? intercept(sql, args[0], query) : query();
    }
  });
}

export async function withCommitFault<T>(
  pool: Pool,
  mode: "success" | "rolled_back" | "committed" | "unknown",
  work: () => Promise<T>,
  beforeCommit: () => Promise<void> = async () => undefined,
  shouldFaultCommit: () => boolean = () => true
) {
  const connect = pool.connect;
  const query = pool.query;
  const clients = new Map<PoolClient, () => void>();
  const restore = installProperties(pool, {
    connect(...args: unknown[]) {
      const result = Reflect.apply(connect, pool, args);
      if (typeof args.at(-1) === "function") return result;
      return (result as Promise<PoolClient>).then((client) => {
        if (clients.has(client)) return client;
        const originalQuery = client.query;
        clients.set(client, installProperties(client, {
          async query(sql: unknown, ...parameters: unknown[]) {
            if (sql === "COMMIT") {
              await beforeCommit();
              if (mode === "success" || !shouldFaultCommit()) {
                return Reflect.apply(originalQuery, client, [sql, ...parameters]);
              }
              if (mode === "committed") {
                await Reflect.apply(originalQuery, client, [sql, ...parameters]);
                throw new Error("controlled commit acknowledgement loss");
              }
              throw new Error(mode === "unknown"
                ? "controlled commit outcome unknown"
                : "controlled commit rollback");
            }
            return Reflect.apply(originalQuery, client, [sql, ...parameters]);
          }
        }));
        return client;
      });
    },
    query(sql: unknown, ...parameters: unknown[]) {
      if (mode === "unknown" && typeof sql === "string"
        && sql.includes("SELECT pg_xact_status")) {
        throw new Error("controlled outcome inspection failure");
      }
      return Reflect.apply(query, pool, [sql, ...parameters]);
    }
  });
  try {
    return await work();
  } finally {
    restore();
    for (const restoreClient of clients.values()) restoreClient();
  }
}
