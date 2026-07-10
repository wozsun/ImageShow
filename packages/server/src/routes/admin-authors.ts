import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ok } from "../core/http.ts";
import { authorCreateInput, authorMetaUpdateInput, authorSlugInput, parse, slugListInput } from "../core/validation.ts";
import { listAuthorsWithMeta } from "../authors/query.ts";
import { upsertAuthor, deleteAuthor, deleteAuthors, reorderAuthors, setAuthorMeta } from "../authors/service.ts";

export function registerAdminAuthorRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/authors`, async (c) => {
    return c.json(ok({ items: await listAuthorsWithMeta() }));
  });

  app.post(`${adminApiBasePath}/authors`, async (c) => {
    const input = parse(authorCreateInput, await c.req.json().catch(() => ({})));
    await upsertAuthor(input.slug, input.display_name, input.link);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/authors/reorder`, async (c) => {
    const input = parse(slugListInput, await c.req.json().catch(() => ({})));
    await reorderAuthors(input.slugs);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/authors/batch-delete`, async (c) => {
    const input = parse(slugListInput, await c.req.json().catch(() => ({})));
    const result = await deleteAuthors(input.slugs);
    return c.json(ok(result));
  });

  app.post(`${adminApiBasePath}/authors/:slug`, async (c) => {
    const slug = parse(authorSlugInput, c.req.param("slug"));
    const input = parse(authorMetaUpdateInput, await c.req.json().catch(() => ({})));
    await setAuthorMeta(slug, input.display_name, input.link);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/authors/:slug/delete`, async (c) => {
    const slug = parse(authorSlugInput, c.req.param("slug"));
    await deleteAuthor(slug);
    return c.json(ok());
  });
}
