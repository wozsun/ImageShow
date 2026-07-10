import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ok } from "../core/http.ts";
import { imageTagsInput, parse, slugListInput, tagCreateInput, tagDisplayUpdateInput, tagSlugInput, uuidInput } from "../core/validation.ts";
import { upsertTag, deleteTag, deleteTags, reorderTags, setImageTags, setTagDisplayName } from "../tags/service.ts";
import { listTagsWithCounts } from "../tags/query.ts";

export function registerAdminTagRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/tags`, async (c) => {
    return c.json(ok({ items: await listTagsWithCounts() }));
  });

  app.post(`${adminApiBasePath}/tags`, async (c) => {
    const input = parse(tagCreateInput, await c.req.json().catch(() => ({})));
    return c.json(ok({ item: await upsertTag(input.slug, input.display_name) }));
  });

  app.post(`${adminApiBasePath}/tags/reorder`, async (c) => {
    const input = parse(slugListInput, await c.req.json().catch(() => ({})));
    await reorderTags(input.slugs);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/tags/batch-delete`, async (c) => {
    const input = parse(slugListInput, await c.req.json().catch(() => ({})));
    const result = await deleteTags(input.slugs);
    return c.json(ok(result));
  });

  app.post(`${adminApiBasePath}/tags/:slug`, async (c) => {
    const slug = parse(tagSlugInput, c.req.param("slug"));
    const input = parse(tagDisplayUpdateInput, await c.req.json().catch(() => ({})));
    await setTagDisplayName(slug, input.display_name);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/tags/:slug/delete`, async (c) => {
    const slug = parse(tagSlugInput, c.req.param("slug"));
    await deleteTag(slug);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/images/:id/tags`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    const input = parse(imageTagsInput, await c.req.json().catch(() => ({})));
    const tags = await setImageTags(id, input.tags);
    return c.json(ok({ tags }));
  });
}
