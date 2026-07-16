import type { Hono } from "hono";
import { themeCreateInput, themeDisplayUpdateInput, themeSlugInput } from "../core/validation.ts";
import { listThemesWithMeta } from "../themes/query.ts";
import { upsertTheme, deleteTheme, deleteThemes, reorderThemes, setThemeDisplayName } from "../themes/service.ts";
import { registerAdminEntityRoutes } from "./admin-entity-routes.ts";

export function registerAdminThemeRoutes(app: Hono) {
  registerAdminEntityRoutes(app, {
    path: "themes",
    slugInput: themeSlugInput,
    createInput: themeCreateInput,
    updateInput: themeDisplayUpdateInput,
    list: listThemesWithMeta,
    create: async (input) => {
      await upsertTheme(input.slug, input.display_name);
    },
    reorder: reorderThemes,
    batchDelete: deleteThemes,
    update: async (slug, input) => setThemeDisplayName(slug, input.display_name),
    remove: deleteTheme
  });
}
