import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ok } from "../core/http.js";
import { imageTagsInput, parse, slugListInput, tagCreateInput, tagDisplayUpdateInput, tagSlugInput, uuidInput } from "../core/validation.js";
import { invalidateImageReadCaches } from "../core/redis.js";
import { createTag, deleteTag, deleteTags, reorderTags, setImageTags, setTagDisplayName } from "../tags/service.js";
import { listTagsWithCounts } from "../tags/query.js";

// Thin HTTP layer for tag management; logic lives in tags/service.ts (mutations)
// and tags/query.ts (reads).
export function registerAdminTagRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/tags`, async (c) => {
    return c.json(ok({ items: await listTagsWithCounts() }));
  });

  app.post(`${adminApiBasePath}/tags`, async (c) => {
    const input = parse(tagCreateInput, await c.req.json().catch(() => ({})));
    return c.json(ok({ item: await createTag(input.slug, input.display_name) }));
  });

  // Static routes before the `:slug` param route. Manual drag-to-sort order.
  app.post(`${adminApiBasePath}/tags/reorder`, async (c) => {
    const input = parse(slugListInput, await c.req.json().catch(() => ({})));
    await reorderTags(input.slugs);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/tags/batch-delete`, async (c) => {
    const input = parse(slugListInput, await c.req.json().catch(() => ({})));
    const result = await deleteTags(input.slugs);
    await invalidateImageReadCaches();
    return c.json(ok(result));
  });

  // Sets a tag's display name.
  app.post(`${adminApiBasePath}/tags/:slug`, async (c) => {
    const slug = parse(tagSlugInput, c.req.param("slug"));
    const input = parse(tagDisplayUpdateInput, await c.req.json().catch(() => ({})));
    await setTagDisplayName(slug, input.display_name);
    await invalidateImageReadCaches();
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/tags/:slug/delete`, async (c) => {
    const slug = parse(tagSlugInput, c.req.param("slug"));
    await deleteTag(slug);
    await invalidateImageReadCaches();
    return c.json(ok());
  });

  // Replaces the image's whole tag set; tags not yet in the vocabulary are created.
  app.post(`${adminApiBasePath}/images/:id/tags`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    const input = parse(imageTagsInput, await c.req.json().catch(() => ({})));
    const tags = await setImageTags(id, input.tags);
    await invalidateImageReadCaches();
    return c.json(ok({ tags }));
  });
}
