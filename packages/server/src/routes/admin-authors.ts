import { adminPermissions } from "@imageshow/shared";
import type { Hono } from "hono";
import { authorCreateInput, authorMetaUpdateInput, authorSlugInput } from "../core/validation.ts";
import { listAuthorsWithMeta } from "../authors/query.ts";
import {
  createAuthor,
  deleteAuthor,
  reorderAuthors,
  updateAuthorProfile
} from "../authors/mutations.ts";
import { registerAdminEntityRoutes } from "./admin-entity-routes.ts";

export function registerAdminAuthorRoutes(app: Hono) {
  registerAdminEntityRoutes(app, {
    path: "authors",
    slugInput: authorSlugInput,
    createInput: authorCreateInput,
    updateInput: authorMetaUpdateInput,
    deletePermission: adminPermissions.authorDelete,
    list: listAuthorsWithMeta,
    create: async (input) => {
      await createAuthor(input.slug, input.display_name, input.link);
    },
    reorder: reorderAuthors,
    update: async (slug, input) => updateAuthorProfile(slug, input.display_name, input.link),
    remove: deleteAuthor
  });
}
