import type { Hono } from "hono";
import { tagCreateInput, tagDisplayUpdateInput, tagSlugInput } from "../core/validation.ts";
import { upsertTag, deleteTag, deleteTags, reorderTags, setTagDisplayName } from "../tags/service.ts";
import { listTagsWithCounts } from "../tags/query.ts";
import { registerAdminEntityRoutes } from "./admin-entity-routes.ts";

export function registerAdminTagRoutes(app: Hono) {
  registerAdminEntityRoutes(app, {
    path: "tags",
    slugInput: tagSlugInput,
    createInput: tagCreateInput,
    updateInput: tagDisplayUpdateInput,
    list: listTagsWithCounts,
    create: async (input) => { await upsertTag(input.slug, input.display_name); },
    reorder: reorderTags,
    batchDelete: deleteTags,
    update: async (slug, input) => setTagDisplayName(slug, input.display_name),
    remove: deleteTag
  });
}
