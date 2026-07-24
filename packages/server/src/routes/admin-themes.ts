import { adminPermissions } from "@imageshow/shared";
import type { Hono } from "hono";
import { themeCreateInput, themeDisplayUpdateInput, themeSlugInput } from "../core/validation.ts";
import { listThemesWithMeta } from "../themes/query.ts";
import {
  createTheme,
  deleteTheme,
  deleteThemes,
  reorderThemes,
  updateThemeDisplayName
} from "../themes/mutations.ts";
import { registerAdminEntityRoutes } from "./admin-entity-routes.ts";

export function registerAdminThemeRoutes(app: Hono) {
  registerAdminEntityRoutes(app, {
    path: "themes",
    slugInput: themeSlugInput,
    createInput: themeCreateInput,
    updateInput: themeDisplayUpdateInput,
    deletePermission: adminPermissions.themeDelete,
    list: listThemesWithMeta,
    create: async (input) => {
      await createTheme(input.slug, input.display_name);
    },
    reorder: reorderThemes,
    batchDelete: deleteThemes,
    update: async (slug, input) => updateThemeDisplayName(slug, input.display_name),
    remove: deleteTheme
  });
}
