import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono } from "hono";
import { adminBasePath } from "@imageshow/shared/browser";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { siteConfigPayload } from "../config/app-settings.ts";
import {
  embedSpaDocumentHeaders,
  immutableCacheControl,
  markEmbedDocumentResponse,
  noStoreCacheControl,
  publicStaticCacheControl
} from "../core/http/headers.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import { serveStaticWithValidators } from "../core/http/static-conditional.ts";
import {
  createSpaDocumentRepresentation,
  spaDocumentResponse
} from "./spa-response.ts";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../public");

export function registerSpaRoutes(app: Hono) {
  const assetStatic = serveStatic({ root: publicDir, precompressed: true });
  const faviconStatic = serveStatic({ path: join(publicDir, "favicon.ico") });
  app.use("/assets/*", async (c, next) => {
    await next();
    c.header("Cache-Control", c.res.status < 400
      ? c.req.path.startsWith("/assets/brand/") ? publicStaticCacheControl : immutableCacheControl
      : noStoreCacheControl);
  });
  app.use("/assets/*", async (c, next) => {
    return await serveStaticWithValidators(c, assetStatic) ?? next();
  });
  app.use("/favicon.ico", async (c, next) => {
    await next();
    c.header("Cache-Control", c.res.status < 400 ? publicStaticCacheControl : noStoreCacheControl);
  });
  app.get("/favicon.ico", async (c, next) => {
    return await serveStaticWithValidators(c, faviconStatic) ?? next();
  });

  app.get("/", spaHandler);
  app.get("/home", spaHandler);
  app.get("/gallery", spaHandler);
  app.get("/embed/home", embedSpaHandler);
  app.get("/embed/gallery", embedSpaHandler);
  app.get(adminBasePath, spaHandler);
  app.get(`${adminBasePath}/*`, spaHandler);
}

let spaTemplate: string | null = null;
let cachedSpaRepresentation: ReturnType<typeof createSpaDocumentRepresentation> | null = null;

function escapeHtmlText(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttr(value: string) {
  return escapeHtmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildSpaDocument(): string {
  spaTemplate ??= readFileSync(join(publicDir, "index.html"), "utf8");
  const site = getRuntimeConfig().site;
  const inlineConfig = JSON.stringify(siteConfigPayload()).replace(/</g, "\\u003c");
  const title = escapeHtmlText(site.name || "ImageShow");
  const description = escapeHtmlAttr(site.home.tagline || site.name || "ImageShow");
  const iconUrl = escapeHtmlAttr(site.icon_url || "/assets/brand/favicon.svg");
  const head =
    `<link rel="preconnect" href="https://${site.static_subdomain}.${site.domain}" crossorigin>` +
    `<script type="application/json" id="__site_config__">${inlineConfig}</script>`;
  return spaTemplate
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`)
    .replace(/<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i, `<meta name="description" content="${description}" />`)
    .replace(/<link\s+rel="icon"[^>]*>/i, `<link rel="icon" type="${iconUrl.endsWith(".svg") ? "image/svg+xml" : ""}" href="${iconUrl}" />`)
    .replace("</head>", `${head}</head>`);
}

function currentSpaRepresentation() {
  const body = buildSpaDocument();
  if (cachedSpaRepresentation?.body === body) return cachedSpaRepresentation;
  cachedSpaRepresentation = createSpaDocumentRepresentation(body);
  return cachedSpaRepresentation;
}

async function spaHandler(c: Context) {
  return spaDocumentResponse(
    currentSpaRepresentation(),
    { ifNoneMatch: c.req.header("if-none-match") }
  );
}

async function embedSpaHandler(c: Context) {
  const embed = getRuntimeConfig().embed;
  if (!embed.enabled || embed.allowed_origins.length === 0) {
    return apiErrorResponse({ status: 404, message: "Not Found" });
  }
  return markEmbedDocumentResponse(
    c,
    spaDocumentResponse(currentSpaRepresentation(), {
      cacheControl: noStoreCacheControl,
      headers: embedSpaDocumentHeaders(embed.allowed_origins),
      ifNoneMatch: c.req.header("if-none-match")
    })
  );
}
