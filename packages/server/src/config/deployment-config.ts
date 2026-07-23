import { z } from "zod";

function normalizeBlankEnvironmentValues(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, fieldValue]) => [
      name,
      typeof fieldValue === "string" && fieldValue.trim() === "" ? undefined : fieldValue
    ])
  );
}

const deploymentEnvironmentSchema = z.preprocess(
  normalizeBlankEnvironmentValues,
  z.object({
    DATABASE_HOST: z.string().trim().min(1).default("postgresql"),
    DATABASE_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
    DATABASE_NAME: z.string().trim().min(1),
    DATABASE_USER: z.string().trim().min(1),
    DATABASE_PASSWORD: z.string().min(1),
    REDIS_HOST: z.string().trim().min(1).default("redis"),
    REDIS_PORT: z.coerce.number().int().min(1).max(65_535).default(6379),
    REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),
    REDIS_PASSWORD: z.string().max(512).default("")
  })
);

function parseDeploymentConfig(environment: NodeJS.ProcessEnv) {
  const parsed = deploymentEnvironmentSchema.parse(environment);
  return Object.freeze({
    database: Object.freeze({
      host: parsed.DATABASE_HOST,
      port: parsed.DATABASE_PORT,
      name: parsed.DATABASE_NAME,
      user: parsed.DATABASE_USER,
      password: parsed.DATABASE_PASSWORD
    }),
    redis: Object.freeze({
      host: parsed.REDIS_HOST,
      port: parsed.REDIS_PORT,
      db: parsed.REDIS_DB,
      password: parsed.REDIS_PASSWORD || undefined
    })
  });
}

export const deploymentConfig = parseDeploymentConfig(process.env);
