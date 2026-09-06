import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, toNamespacedPath } from "node:path";
import { after } from "node:test";
import { runtimeConfigEnvironmentBindings } from "../../../packages/server/src/config/runtime-config-environment.ts";
import { temporaryTestRoot } from "./test-directory.ts";

// Each scenario owns its configuration seeds, independent of the host shell.
for (const { environmentVariable } of runtimeConfigEnvironmentBindings) {
  delete process.env[environmentVariable];
}

// Complete setup synchronously before the suite imports Server runtime paths.
mkdirSync(temporaryTestRoot, { recursive: true });
const dataDirectory = mkdtempSync(join(temporaryTestRoot, "server-environment-"));
Object.assign(process.env, {
  NODE_ENV: "development",
  IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: toNamespacedPath(dataDirectory),
  DATABASE_HOST: "database.invalid",
  DATABASE_PORT: "5432",
  DATABASE_NAME: "imageshow_test",
  DATABASE_USER: "imageshow_test",
  DATABASE_PASSWORD: randomUUID(),
  REDIS_HOST: "redis.invalid",
  REDIS_PORT: "6379",
  REDIS_DB: "0",
  REDIS_PASSWORD: "",
  ADMIN_USERNAME: "test-admin",
  ADMIN_PASSWORD: randomUUID()
});

after(() => rm(dataDirectory, { recursive: true, force: true }));
