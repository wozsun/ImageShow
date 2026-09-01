import {
  adminApiBasePath,
  adminPermissions,
  type AdminEntityDto,
  type AdminEntityListResponseDto,
  type AdminPermission
} from "@imageshow/shared/browser";
import type { Hono } from "hono";
import type { z } from "zod";
import { listAuthorsWithMeta } from "../authors/query.ts";
import {
  createAuthor,
  deleteAuthor,
  reorderAuthors,
  updateAuthorProfile
} from "../authors/mutations.ts";
import { readJsonBody } from "../core/http/json-body.ts";
import {
  apiSuccess,
  privateCacheableApiSuccess
} from "../core/http/responses.ts";
import {
  authorCreateInput,
  authorMetaUpdateInput,
  authorSlugInput,
  tagCreateInput,
  tagDisplayUpdateInput,
  tagSlugInput,
  themeCreateInput,
  themeDisplayUpdateInput,
  themeSlugInput,
  vocabularySlugListInput
} from "./validation/vocabulary.ts";
import { parse } from "./validation/parse.ts";
import {
  createTag,
  deleteTag,
  reorderTags,
  setTagDisplayName
} from "../tags/mutations.ts";
import { listTagsWithCounts } from "../tags/query.ts";
import { listThemesWithMeta } from "../themes/query.ts";
import {
  createTheme,
  deleteTheme,
  reorderThemes,
  updateThemeDisplayName
} from "../themes/mutations.ts";
import { requireAdminPermission } from "../users/admin-authorization.ts";

type EntityRouteOptions<CreateSchema extends z.ZodType, UpdateSchema extends z.ZodType> = {
  path: string;
  slugInput: z.ZodType<string>;
  createInput: CreateSchema;
  updateInput: UpdateSchema;
  deletePermission: AdminPermission;
  list: () => Promise<AdminEntityDto[]>;
  create: (input: z.infer<CreateSchema>) => Promise<AdminEntityDto | void>;
  reorder: (slugs: string[]) => Promise<void>;
  update: (
    slug: string,
    input: z.infer<UpdateSchema>
  ) => Promise<AdminEntityDto | void>;
  remove: (slug: string) => Promise<void>;
};

function registerAdminEntityRoutes<
  CreateSchema extends z.ZodType,
  UpdateSchema extends z.ZodType
>(app: Hono, options: EntityRouteOptions<CreateSchema, UpdateSchema>) {
  const base = `${adminApiBasePath}/${options.path}`;
  app.get(base, async (c) => {
    const response = {
      items: await options.list()
    } satisfies AdminEntityListResponseDto;
    return privateCacheableApiSuccess(c, response);
  });

  app.post(base, async (c) => {
    const input = parse(options.createInput, await readJsonBody(c));
    const item = await options.create(input);
    return c.json(item ? apiSuccess({ item }) : apiSuccess());
  });

  app.post(`${base}/reorder`, async (c) => {
    const input = parse(vocabularySlugListInput, await readJsonBody(c));
    await options.reorder(input.slugs);
    return c.json(apiSuccess());
  });

  app.post(`${base}/:slug`, async (c) => {
    const slug = parse(options.slugInput, c.req.param("slug"));
    const input = parse(options.updateInput, await readJsonBody(c));
    const item = await options.update(slug, input);
    return c.json(item ? apiSuccess({ item }) : apiSuccess());
  });

  app.post(
    `${base}/:slug/delete`,
    requireAdminPermission(options.deletePermission),
    async (c) => {
      const slug = parse(options.slugInput, c.req.param("slug"));
      await options.remove(slug);
      return c.json(apiSuccess());
    }
  );
}

export function registerAdminVocabularyRoutes(app: Hono) {
  registerAdminEntityRoutes(app, {
    path: "tags",
    slugInput: tagSlugInput,
    createInput: tagCreateInput,
    updateInput: tagDisplayUpdateInput,
    deletePermission: adminPermissions.tagDelete,
    list: listTagsWithCounts,
    create: async (input) => { await createTag(input.slug, input.display_name); },
    reorder: reorderTags,
    update: async (slug, input) => setTagDisplayName(slug, input.display_name),
    remove: deleteTag
  });
  registerAdminEntityRoutes(app, {
    path: "themes",
    slugInput: themeSlugInput,
    createInput: themeCreateInput,
    updateInput: themeDisplayUpdateInput,
    deletePermission: adminPermissions.themeDelete,
    list: listThemesWithMeta,
    create: async (input) => { await createTheme(input.slug, input.display_name); },
    reorder: reorderThemes,
    update: async (slug, input) => updateThemeDisplayName(slug, input.display_name),
    remove: deleteTheme
  });
  registerAdminEntityRoutes(app, {
    path: "authors",
    slugInput: authorSlugInput,
    createInput: authorCreateInput,
    updateInput: authorMetaUpdateInput,
    deletePermission: adminPermissions.authorDelete,
    list: listAuthorsWithMeta,
    create: (input) => createAuthor(input.slug, input.display_name, input.link),
    reorder: reorderAuthors,
    update: (slug, input) => updateAuthorProfile(
      slug,
      input.display_name,
      input.link
    ),
    remove: deleteAuthor
  });
}
