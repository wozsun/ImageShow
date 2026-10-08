import { adminApiBasePath, adminPermissions, type ImageGroupListResponseDto } from "@imageshow/shared/browser";
import type { Hono } from "hono";
import { runWithAdvisoryLockAcquisitionSignal } from "../core/database/advisory-locks.ts";
import { readJsonBody } from "../core/http/json-body.ts";
import { apiSuccess, privateCacheableApiSuccess } from "../core/http/responses.ts";
import {
  addImageGroupMembers, createImageGroup, deleteImageGroup,
  removeImageGroupMembers, renameImageGroup, setImageGroupSortOrder
} from "../images/groups/mutations.ts";
import { listImageGroups } from "../images/groups/queries.ts";
import { requireAdminPermission } from "../users/admin-authorization.ts";
import { groupAddInput, groupCreateInput, groupRemoveInput, groupRenameInput, groupSlugInput } from "./validation/groups.ts";
import { sortOrderUpdateInput } from "./validation/sort-order.ts";
import { parse } from "./validation/parse.ts";

export function registerAdminGroupRoutes(app: Hono) {
  const base = `${adminApiBasePath}/groups`;
  app.get(base, async (c) => {
    const response = { items: await listImageGroups() } satisfies ImageGroupListResponseDto;
    return privateCacheableApiSuccess(c, response);
  });
  app.post(base, async (c) => {
    const input = parse(groupCreateInput, await readJsonBody(c));
    await runWithAdvisoryLockAcquisitionSignal(c.req.raw.signal, () => createImageGroup(input.slug, input.display_name, input.sort_order));
    return c.json(apiSuccess());
  });
  app.post(`${base}/:slug/sort-order`, async (c) => {
    const slug = parse(groupSlugInput, c.req.param("slug"));
    const input = parse(sortOrderUpdateInput, await readJsonBody(c));
    await setImageGroupSortOrder(slug, input.sort_order);
    return c.json(apiSuccess());
  });
  app.post(`${base}/:slug`, async (c) => {
    const slug = parse(groupSlugInput, c.req.param("slug"));
    const input = parse(groupRenameInput, await readJsonBody(c));
    await renameImageGroup(slug, input.display_name);
    return c.json(apiSuccess());
  });
  app.post(`${base}/:slug/delete`, requireAdminPermission(adminPermissions.groupDelete), async (c) => {
    const slug = parse(groupSlugInput, c.req.param("slug"));
    await runWithAdvisoryLockAcquisitionSignal(c.req.raw.signal, () => deleteImageGroup(slug));
    return c.json(apiSuccess());
  });
  app.post(`${base}/:slug/members/add`, async (c) => {
    const slug = parse(groupSlugInput, c.req.param("slug"));
    const { ids } = parse(groupAddInput, await readJsonBody(c));
    const result = await runWithAdvisoryLockAcquisitionSignal(c.req.raw.signal, () => addImageGroupMembers(slug, ids));
    return c.json(apiSuccess(result));
  });
  app.post(`${base}/:slug/members/remove`, async (c) => {
    const slug = parse(groupSlugInput, c.req.param("slug"));
    const { ids } = parse(groupRemoveInput, await readJsonBody(c));
    const result = await runWithAdvisoryLockAcquisitionSignal(c.req.raw.signal, () => removeImageGroupMembers(slug, ids));
    return c.json(apiSuccess(result));
  });
}
