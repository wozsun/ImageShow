import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type AdminBootstrapModule = typeof import(
  "../../../../packages/server/src/users/admin-bootstrap.ts"
);
type DatabasePoolsModule = typeof import(
  "../../../../packages/server/src/core/database/pools.ts"
);
type RedisClientModule = typeof import(
  "../../../../packages/server/src/core/redis/client.ts"
);
type RuntimeConfigStoreModule = typeof import(
  "../../../../packages/server/src/config/runtime-config-store.ts"
);
type StorageRegistryModule = typeof import(
  "../../../../packages/server/src/storage/backends/registry.ts"
);

export type IntegrationRuntime = {
  dataDirectory: string;
  databasePools: DatabasePoolsModule;
  moduleUrl: (relativePath: string) => string;
  redisClient: RedisClientModule;
  runtimeConfigStore: RuntimeConfigStoreModule;
  storageRegistry: StorageRegistryModule;
};

const workspace = resolve(import.meta.dirname, "../../../..");

function requiredArgument(value: string | undefined, name: string) {
  assert.ok(value, `missing integration argument: ${name}`);
  return value;
}

export async function createIntegrationRuntime(): Promise<IntegrationRuntime> {
  const [
    rawHost,
    rawPort,
    rawName,
    rawUser,
    rawPassword,
    rawDataDirectory,
    rawRedisHost,
    rawRedisPort
  ] = process.argv.slice(2);
  const host = requiredArgument(rawHost, "database host");
  const port = requiredArgument(rawPort, "database port");
  const name = requiredArgument(rawName, "database name");
  const user = requiredArgument(rawUser, "database user");
  const password = requiredArgument(rawPassword, "database password");
  const dataDirectory = requiredArgument(rawDataDirectory, "data directory");
  const redisHost = requiredArgument(rawRedisHost, "Redis host");
  const redisPort = requiredArgument(rawRedisPort, "Redis port");
  const moduleUrl = (relativePath: string) => (
    pathToFileURL(resolve(workspace, relativePath)).href
  );

  Object.assign(process.env, {
    DATABASE_HOST: host,
    DATABASE_PORT: port,
    DATABASE_NAME: name,
    DATABASE_USER: user,
    DATABASE_PASSWORD: password,
    IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: dataDirectory,
    REDIS_HOST: redisHost,
    REDIS_PORT: redisPort,
    REDIS_DB: "0"
  });

  const [
    databasePools,
    redisClient,
    runtimeConfigStore,
    storageRegistry,
    adminBootstrap
  ] = await Promise.all([
    import(moduleUrl("packages/server/src/core/database/pools.ts")),
    import(moduleUrl("packages/server/src/core/redis/client.ts")),
    import(moduleUrl("packages/server/src/config/runtime-config-store.ts")),
    import(moduleUrl("packages/server/src/storage/backends/registry.ts")),
    import(moduleUrl("packages/server/src/users/admin-bootstrap.ts"))
  ]) as [
    DatabasePoolsModule,
    RedisClientModule,
    RuntimeConfigStoreModule,
    StorageRegistryModule,
    AdminBootstrapModule
  ];
  databasePools.configureDatabasePools({
    host,
    port: Number(port),
    name,
    user,
    password
  });
  const runtime = {
    dataDirectory,
    databasePools,
    moduleUrl,
    redisClient,
    runtimeConfigStore,
    storageRegistry
  };
  try {
    runtimeConfigStore.initializeRuntimeConfig();
    await redisClient.pingRedis();
    await adminBootstrap.ensureSuperAdmin({
      username: "integration-admin",
      password: "IntegrationAdmin123!"
    });
    return runtime;
  } catch (initializationError) {
    try {
      await closeIntegrationRuntime(runtime);
    } catch (cleanupError) {
      throw new AggregateError(
        [initializationError, cleanupError],
        "integration runtime initialization and cleanup failed"
      );
    }
    throw initializationError;
  }
}

async function closeIntegrationRuntime(runtime: IntegrationRuntime) {
  const errors: unknown[] = [];
  try {
    const { closeIngestionRawCleanupCursor } = await import(
      "../../../../packages/server/src/images/ingestion/raw/orphan-scanner.ts"
    );
    await closeIngestionRawCleanupCursor();
  } catch (error) {
    errors.push(error);
  }
  try {
    await runtime.storageRegistry.closeStorageBackendRegistry();
  } catch (error) {
    errors.push(error);
  }
  try {
    runtime.redisClient.redis.disconnect();
  } catch (error) {
    errors.push(error);
  }
  try {
    await runtime.databasePools.closeDatabasePools();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "integration runtime cleanup failed");
  }
}

export async function runIntegrationScenario(
  work: (runtime: IntegrationRuntime) => Promise<void>
) {
  const runtime = await createIntegrationRuntime();
  const errors: unknown[] = [];
  try {
    await work(runtime);
  } catch (error) {
    errors.push(error);
  }
  try {
    await closeIntegrationRuntime(runtime);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "integration scenario and cleanup failed");
  }
}
