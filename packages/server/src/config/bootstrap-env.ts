import { join, resolve } from "node:path";
import { z } from "zod";
export { runtimeConfigFromEnvironment } from "./runtime-config-environment.ts";

const optionalEnvironmentString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional()
);

const processEnvironmentSchema = z.object({
  NODE_ENV: z.string().default("development"),
  ADMIN_USERNAME: optionalEnvironmentString,
  ADMIN_PASSWORD: optionalEnvironmentString,
  IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: optionalEnvironmentString
});

function parseBootstrapAdminEnvironment(environment: NodeJS.ProcessEnv) {
  const parsed = processEnvironmentSchema.parse(environment);
  return {
    nodeEnvironment: parsed.NODE_ENV,
    adminUsername: parsed.ADMIN_USERNAME,
    adminPassword: parsed.ADMIN_PASSWORD,
    developmentDataDirectory: parsed.IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY
  };
}

export const bootstrapEnvironment = Object.freeze(parseBootstrapAdminEnvironment(process.env));
const dataDirectory = bootstrapEnvironment.nodeEnvironment === "production"
  ? "/app/data"
  : bootstrapEnvironment.developmentDataDirectory
    ? resolve(bootstrapEnvironment.developmentDataDirectory)
    : join(process.cwd(), "data");

export const runtimePaths = Object.freeze({
  configDirectory: dataDirectory,
  storageDirectory: join(dataDirectory, "storage"),
  tempDirectory: join(dataDirectory, "tmp"),
  logDirectory: join(dataDirectory, "log"),
  configFile: join(dataDirectory, "config.json")
});
