import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ok } from "../core/http.ts";
import { imageTagsInput, parse, tagCreateInput, tagDisplayUpdateInput, tagSlugInput, uuidInput } from "../core/validation.ts";
import { upsertTag, deleteTag, deleteTags, reorderTags, setImageTags, setTagDisplayName } from "../tags/service.ts";
import { listTagsWithCounts } from "../tags/query.ts";
import { registerAdminEntityRoutes } from "./admin-entity-routes.ts";

export function registerAdminTagRoutes(app: Hono) {
  registerAdminEntityRoutes(app, {
    path: "tags",
    slugInput: tagSlugInput,
    createInput: tagCreateInput,
    updateInput: tagDisplayUpdateInput,
    list: listTagsWithCounts,
    create: async (input) => ({ item: await upsertTag(input.slug, input.display_name) }),
    reorder: reorderTags,
    batchDelete: deleteTags,
    update: async (slug, input) => setTagDisplayName(slug, input.display_name),
    remove: deleteTag
  });

  app.post(`${adminApiBasePath}/images/:id/tags`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    const input = parse(imageTagsInput, await c.req.json().catch(() => ({})));
    const tags = await setImageTags(id, input.tags);
    return c.json(ok({ tags }));
  });
}
