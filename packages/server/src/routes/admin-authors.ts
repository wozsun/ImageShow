import type { Hono } from "hono";
import { authorCreateInput, authorMetaUpdateInput, authorSlugInput } from "../core/validation.ts";
import { listAuthorsWithMeta } from "../authors/query.ts";
import { upsertAuthor, deleteAuthor, deleteAuthors, reorderAuthors, setAuthorMeta } from "../authors/service.ts";
import { registerAdminEntityRoutes } from "./admin-entity-routes.ts";

export function registerAdminAuthorRoutes(app: Hono) {
  registerAdminEntityRoutes(app, {
    path: "authors",
    slugInput: authorSlugInput,
    createInput: authorCreateInput,
    updateInput: authorMetaUpdateInput,
    list: listAuthorsWithMeta,
    create: async (input) => {
      await upsertAuthor(input.slug, input.display_name, input.link);
    },
    reorder: reorderAuthors,
    batchDelete: deleteAuthors,
    update: async (slug, input) => setAuthorMeta(slug, input.display_name, input.link),
    remove: deleteAuthor
  });
}
