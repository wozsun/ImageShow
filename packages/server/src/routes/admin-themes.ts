import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ok } from "../core/http.js";
import { parse, slugListInput, themeCreateInput, themeDisplayUpdateInput, themeSlugInput } from "../core/validation.js";
import { invalidateImageReadCaches } from "../core/redis.js";
import { listThemesWithMeta } from "../themes/query.js";
import { createTheme, deleteTheme, deleteThemes, reorderThemes, setThemeDisplayName } from "../themes/service.js";

export function registerAdminThemeRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/themes`, async (c) => {
    return c.json(ok({ items: await listThemesWithMeta() }));
  });

  app.post(`${adminApiBasePath}/themes`, async (c) => {
    const input = parse(themeCreateInput, await c.req.json().catch(() => ({})));
    await createTheme(input.slug, input.display_name);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/themes/reorder`, async (c) => {
    const input = parse(slugListInput, await c.req.json().catch(() => ({})));
    await reorderThemes(input.slugs);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/themes/batch-delete`, async (c) => {
    const input = parse(slugListInput, await c.req.json().catch(() => ({})));
    const result = await deleteThemes(input.slugs);
    await invalidateImageReadCaches();
    return c.json(ok(result));
  });

  app.post(`${adminApiBasePath}/themes/:slug`, async (c) => {
    const slug = parse(themeSlugInput, c.req.param("slug"));
    const input = parse(themeDisplayUpdateInput, await c.req.json().catch(() => ({})));
    await setThemeDisplayName(slug, input.display_name);
    await invalidateImageReadCaches();
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/themes/:slug/delete`, async (c) => {
    const slug = parse(themeSlugInput, c.req.param("slug"));
    await deleteTheme(slug);
    await invalidateImageReadCaches();
    return c.json(ok());
  });
}
