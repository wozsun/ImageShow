import {
  adminApiBasePath,
  type AdminPermission
} from "@imageshow/shared";
import type { Hono } from "hono";
import type { z } from "zod";
import { apiSuccess } from "../core/http/responses.ts";
import { parse, slugListInput } from "../core/validation.ts";
import { requireAdminPermission } from "../users/admin-authorization.ts";

type EntityRouteOptions<CreateSchema extends z.ZodType, UpdateSchema extends z.ZodType> = {
  path: string;
  slugInput: z.ZodType<string>;
  createInput: CreateSchema;
  updateInput: UpdateSchema;
  deletePermission: AdminPermission;
  list: () => Promise<unknown[]>;
  create: (input: z.infer<CreateSchema>) => Promise<void>;
  reorder: (slugs: string[]) => Promise<void>;
  batchDelete: (slugs: string[]) => Promise<void>;
  update: (slug: string, input: z.infer<UpdateSchema>) => Promise<void>;
  remove: (slug: string) => Promise<void>;
};

export function registerAdminEntityRoutes<
  CreateSchema extends z.ZodType,
  UpdateSchema extends z.ZodType
>(app: Hono, options: EntityRouteOptions<CreateSchema, UpdateSchema>) {
  const base = `${adminApiBasePath}/${options.path}`;
  app.get(base, async (c) => c.json(apiSuccess({ items: await options.list() })));

  app.post(base, async (c) => {
    const input = parse(options.createInput, await c.req.json().catch(() => ({})));
    await options.create(input);
    return c.json(apiSuccess());
  });

  app.post(`${base}/reorder`, async (c) => {
    const input = parse(slugListInput, await c.req.json().catch(() => ({})));
    await options.reorder(input.slugs);
    return c.json(apiSuccess());
  });

  app.post(
    `${base}/batch-delete`,
    requireAdminPermission(options.deletePermission),
    async (c) => {
      const input = parse(slugListInput, await c.req.json().catch(() => ({})));
      await options.batchDelete(input.slugs);
      return c.json(apiSuccess());
    }
  );

  app.post(`${base}/:slug`, async (c) => {
    const slug = parse(options.slugInput, c.req.param("slug"));
    const input = parse(options.updateInput, await c.req.json().catch(() => ({})));
    await options.update(slug, input);
    return c.json(apiSuccess());
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
