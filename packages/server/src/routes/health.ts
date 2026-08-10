import type { Context, Hono } from "hono";
import { assertCoreDatabaseReady } from "../core/database-schema.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import { noStoreCacheControl } from "../core/http/headers.ts";
import {
  isRedisRequiredCommandsError
} from "../core/redis-client.ts";
import {
  probeRedisOperationalState,
  runtimeInitializationIsComplete
} from "../core/runtime-availability.ts";

type HealthDependencies = {
  pingDatabase(): Promise<void>;
  assertRedisFeatures(): Promise<unknown>;
  initializationComplete?(): boolean;
};

const defaultHealthDependencies: HealthDependencies = {
  pingDatabase: assertCoreDatabaseReady,
  assertRedisFeatures: probeRedisOperationalState,
  initializationComplete: runtimeInitializationIsComplete
};

export function registerHealthRoutes(
  app: Hono,
  dependencies: HealthDependencies = defaultHealthDependencies
) {
  app.all("/livez", async (c) => {
    if (c.req.method !== "GET") return apiErrorResponse({ status: 405, message: "Method Not Allowed" });
    c.header("Cache-Control", noStoreCacheControl);
    return c.json({ message: "ImageShow process is alive", ok: true, status: "alive" });
  });

  app.all("/readyz", (context) => readinessHandler(context, dependencies));
}

async function readinessHandler(
  c: Context,
  dependencies: HealthDependencies
) {
  if (c.req.method !== "GET") return apiErrorResponse({ status: 405, message: "Method Not Allowed" });
  if (new URL(c.req.url).search) return apiErrorResponse({ status: 403, message: "Forbidden: Query parameters are not allowed on this route" });
  if (dependencies.initializationComplete?.() === false) {
    return apiErrorResponse({
      status: 503,
      code: "initialization_incomplete",
      message: "ImageShow initialization is incomplete"
    });
  }
  try {
    await Promise.all([
      Promise.resolve().then(() => dependencies.pingDatabase()),
      Promise.resolve().then(() => dependencies.assertRedisFeatures())
    ]);
    c.header("Cache-Control", noStoreCacheControl);
    return c.json({ message: "ImageShow is healthy", ok: true, status: "healthy" });
  } catch (error) {
    if (isRedisRequiredCommandsError(error)) {
      return apiErrorResponse(
        {
          status: 503,
          code: error.code,
          message: "Redis required commands are unavailable"
        },
        {
          required_commands: error.capabilities.commands,
          missing_commands: error.capabilities.missing
        }
      );
    }
    return apiErrorResponse({
      status: 503,
      code: "dependency_unavailable",
      message: "ImageShow dependencies are unavailable"
    });
  }
}
