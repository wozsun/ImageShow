import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono } from "hono";
import {
  adminBasePath,
  publicRootPath,
  type RuntimeConfig
} from "@imageshow/shared/browser";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { siteConfigPayload } from "../config/app-settings.ts";
import { effectiveEmbedAncestorSources } from "../config/embed-ancestors.ts";
import {
  appendVaryHeader,
  embedSpaDocumentHeaders,
  immutableCacheControl,
  markEmbedDocumentResponse,
  noStoreCacheControl,
  publicDocumentCacheControl,
  publicStaticCacheControl,
  spaDocumentHeaders
} from "../core/http/headers.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import { serveStaticWithValidators } from "../core/http/static-conditional.ts";
import { serveNegotiatedStatic } from "../core/http/static-encoding.ts";
import {
  contentResponse,
  createContentSnapshot,
  type ContentRepresentation
} from "../core/http/content-response.ts";
import { createEncodedContentCache } from "../core/http/encoded-content.ts";

const publicDir = join(import.meta.dirname, "../public");

export function registerSpaRoutes(app: Hono) {
  const assetStatic = serveNegotiatedStatic(publicDir);
  const faviconStatic = serveStatic({ path: join(publicDir, "favicon.ico") });
  app.use("/assets/*", async (c, next) => {
    await next();
    appendVaryHeader(c, "Accept-Encoding");
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

  app.get("/", rootSpaHandler);
  app.get("/home", spaHandler);
  app.get("/show", spaHandler);
  app.get("/gallery", spaHandler);
  app.get("/embed/home", embedSpaHandler);
  app.get("/embed/show", embedSpaHandler);
  app.get("/embed/gallery", embedSpaHandler);
  app.get(adminBasePath, spaHandler);
  app.get(`${adminBasePath}/*`, spaHandler);
}

let spaTemplate: string | null = null;
const spaRepresentation = createContentSnapshot(buildSpaDocument);
const encodedSpaRepresentation = createEncodedContentCache();

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

function buildSpaDocument(runtime: RuntimeConfig): string {
  spaTemplate ??= readFileSync(join(publicDir, "index.html"), "utf8");
  const config = siteConfigPayload(runtime);
  const { site } = config;
  const inlineConfig = JSON.stringify(config).replace(/</g, "\\u003c");
  const title = escapeHtmlText(site.title);
  const description = escapeHtmlAttr(site.description);
  const iconUrl = escapeHtmlAttr(site.icon);
  const head = `<script type="application/json" id="__site_config__">${inlineConfig}</script>`;
  return spaTemplate
    .replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${title}</title>`)
    .replace(/<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i, () => `<meta name="description" content="${description}" />`)
    .replace(/<link\s+rel="icon"[^>]*>/i, () => `<link rel="icon" type="${iconUrl.endsWith(".svg") ? "image/svg+xml" : ""}" href="${iconUrl}" />`)
    .replace("</head>", () => `${head}</head>`);
}

function spaDocumentResponse(
  representation: ContentRepresentation,
  options: {
    cacheControl?: string;
    headers?: Readonly<Record<string, string>>;
    ifNoneMatch?: string | null;
    acceptEncoding?: string;
  } = {}
) {
  const selected = encodedSpaRepresentation(representation, options.acceptEncoding);
  if (!selected) {
    return new Response(null, {
      status: 406,
      headers: {
        ...(options.headers ?? spaDocumentHeaders),
        Vary: "Accept-Encoding",
        "Cache-Control": noStoreCacheControl
      }
    });
  }
  return contentResponse(selected, {
    cacheControl: options.cacheControl ?? publicDocumentCacheControl,
    contentType: "text/html; charset=utf-8",
    headers: { ...(options.headers ?? spaDocumentHeaders), Vary: "Accept-Encoding" },
    ifNoneMatch: options.ifNoneMatch
  });
}

async function spaHandler(c: Context) {
  return spaDocumentResponse(
    spaRepresentation(getRuntimeConfig()),
    {
      ifNoneMatch: c.req.header("if-none-match"),
      acceptEncoding: c.req.header("accept-encoding")
    }
  );
}

async function rootSpaHandler(c: Context) {
  if (publicRootPath(getRuntimeConfig().site) === null) {
    return apiErrorResponse({ status: 404, message: "Not Found" });
  }
  return spaHandler(c);
}

async function embedSpaHandler(c: Context) {
  const allowedAncestors = effectiveEmbedAncestorSources();
  if (allowedAncestors.length === 0) {
    return apiErrorResponse({ status: 404, message: "Not Found" });
  }
  return markEmbedDocumentResponse(
    c,
    spaDocumentResponse(spaRepresentation(getRuntimeConfig()), {
      cacheControl: noStoreCacheControl,
      headers: embedSpaDocumentHeaders(allowedAncestors),
      ifNoneMatch: c.req.header("if-none-match"),
      acceptEncoding: c.req.header("accept-encoding")
    })
  );
}
