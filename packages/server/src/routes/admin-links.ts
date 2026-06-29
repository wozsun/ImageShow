import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ApiError, ok } from "../core/http.js";
import { linkCommitInput, linkPrepareInput, parse } from "../core/validation.js";
import { isReservedSubdomain } from "../themes/host.js";
import { commitLinkImage, prepareLinkImage } from "../images/link-import.js";

// Thin HTTP layer for the two-phase link import; the fetch/probe/stage/insert logic lives
// in images/link-import.ts. Kept off the /images/:id namespace so the path can't be parsed
// as an image id.
export function registerAdminLinkRoutes(app: Hono) {
  // Phase 1: download one URL, build + stage a thumbnail server-side, and return its preview
  // plus the detected device/brightness. No row is created yet.
  app.post(`${adminApiBasePath}/import-links/prepare`, async (c) => {
    const { url } = parse(linkPrepareInput, await c.req.json().catch(() => ({})));
    return c.json(ok(await prepareLinkImage(url)));
  });
  // Phase 2: with the card-edited metadata, write the staged thumbnail to the chosen backend
  // and insert the is_link row (object_key = the URL).
  app.post(`${adminApiBasePath}/import-links/commit`, async (c) => {
    const input = parse(linkCommitInput, await c.req.json().catch(() => ({})));
    if (isReservedSubdomain(input.theme)) throw new ApiError(400, "theme_reserved", "Theme conflicts with a reserved subdomain prefix", { theme: input.theme });
    return c.json(ok(await commitLinkImage(input)));
  });
}
