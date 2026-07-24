import { adminPermissions } from "@imageshow/shared";
import type { Hono } from "hono";
import { tagCreateInput, tagDisplayUpdateInput, tagSlugInput } from "../core/validation.ts";
import {
  createTag,
  deleteTag,
  deleteTags,
  reorderTags,
  setTagDisplayName
} from "../tags/mutations.ts";
import { listTagsWithCounts } from "../tags/query.ts";
import { registerAdminEntityRoutes } from "./admin-entity-routes.ts";

export function registerAdminTagRoutes(app: Hono) {
  registerAdminEntityRoutes(app, {
    path: "tags",
    slugInput: tagSlugInput,
    createInput: tagCreateInput,
    updateInput: tagDisplayUpdateInput,
    deletePermission: adminPermissions.tagDelete,
    list: listTagsWithCounts,
    create: async (input) => { await createTag(input.slug, input.display_name); },
    reorder: reorderTags,
    batchDelete: deleteTags,
    update: async (slug, input) => setTagDisplayName(slug, input.display_name),
    remove: deleteTag
  });
}
