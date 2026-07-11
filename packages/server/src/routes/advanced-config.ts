import type { Hono } from "hono";
import { z } from "zod";
import { adminApiBasePath } from "@imageshow/shared";
import { ok, privateNoStoreCacheControl, requireSuper } from "../core/http.ts";
import { parse } from "../core/validation.ts";
import {
  createConfigPackage,
  importConfigPackage,
  previewConfigPackage
} from "../config/config-package.ts";
import {
  getFullRuntimeConfig,
  saveFullRuntimeConfig,
  validateFullRuntimeConfig
} from "../config/full-config.ts";

const previewInput = z.strictObject({ package: z.unknown() });
const importInput = z.strictObject({
  package: z.unknown(),
  slug_mappings: z.record(z.string(), z.string()).default({})
});
const runtimeInput = z.strictObject({ config: z.unknown() });

function exportFilename(exportedAt: string) {
  const timestamp = exportedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `imageshow-config-${timestamp}.json`;
}

export function registerAdvancedConfigRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/advanced-config/runtime`, requireSuper, (c) => {
    c.header("Cache-Control", privateNoStoreCacheControl);
    return c.json(ok({ config: getFullRuntimeConfig() }));
  });

  app.post(`${adminApiBasePath}/advanced-config/runtime/validate`, requireSuper, async (c) => {
    const input = parse(runtimeInput, await c.req.json().catch(() => ({})));
    const result = validateFullRuntimeConfig(input.config);
    c.header("Cache-Control", privateNoStoreCacheControl);
    return c.json(ok({ changes: result.changes }));
  });

  app.post(`${adminApiBasePath}/advanced-config/runtime`, requireSuper, async (c) => {
    const input = parse(runtimeInput, await c.req.json().catch(() => ({})));
    const result = await saveFullRuntimeConfig(input.config);
    c.header("Cache-Control", privateNoStoreCacheControl);
    return c.json(ok(result));
  });

  app.get(`${adminApiBasePath}/advanced-config/export`, requireSuper, async (c) => {
    const pkg = await createConfigPackage();
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="${exportFilename(pkg.exported_at)}"`);
    c.header("Cache-Control", "private, no-store");
    return c.body(`${JSON.stringify(pkg, null, 2)}\n`);
  });

  app.post(`${adminApiBasePath}/advanced-config/preview`, requireSuper, async (c) => {
    const input = parse(previewInput, await c.req.json().catch(() => ({})));
    return c.json(ok({ preview: await previewConfigPackage(input.package) }));
  });

  app.post(`${adminApiBasePath}/advanced-config/import`, requireSuper, async (c) => {
    const input = parse(importInput, await c.req.json().catch(() => ({})));
    return c.json(ok({ result: await importConfigPackage(input.package, input.slug_mappings) }));
  });
}
