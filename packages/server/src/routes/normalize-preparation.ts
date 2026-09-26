import type { Hono } from "hono";
import { adminApiBasePath, adminPermissions } from "@imageshow/shared/browser";
import { apiSuccess } from "../core/http/responses.ts";
import { ApiError } from "../core/api-error.ts";
import { requireAdminPermission } from "../users/admin-authorization.ts";
import { controlPreparation, readPreparationStatus } from "../images/preparation/service.ts";
import { previewPreparationImage } from "../images/preparation/preview.ts";
import { exportPreparationRecords } from "../images/preparation/export.ts";
import { parse } from "./validation/parse.ts";
import { uuidInput } from "./validation/primitives.ts";
import { preparationControlInput, preparationPageInput, preparationVariantInput } from "./validation/normalize-preparation.ts";

const base = `${adminApiBasePath}/check/normalize-preparation`;

export function registerNormalizePreparationRoutes(app: Hono) {
  app.use(`${base}/*`, requireAdminPermission(adminPermissions.normalizePreparation));
  app.get(`${base}/status`, async (c) => {
    const page = parse(preparationPageInput, c.req.query("page") ?? 1);
    return c.json(apiSuccess(await readPreparationStatus(page)));
  });
  app.post(`${base}/control`, async (c) => {
    const input = parse(preparationControlInput, await c.req.json());
    try { return c.json(apiSuccess(await controlPreparation(input))); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, "preparation_control_failed", error instanceof Error ? error.message : "预生成操作失败");
    }
  });
  app.get(`${base}/preview/:image/:variant`, async (c) => {
    const image = parse(uuidInput, c.req.param("image"));
    const variant = parse(preparationVariantInput, c.req.param("variant"));
    return previewPreparationImage(image, variant, c.req.raw.signal);
  });
  app.get(`${base}/export`, async (c) => {
    const { stream, filename } = await exportPreparationRecords(c.req.raw.signal);
    return new Response(stream, { headers: {
      "Content-Type": "application/x-ndjson", "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${filename}"`
    } });
  });
}
