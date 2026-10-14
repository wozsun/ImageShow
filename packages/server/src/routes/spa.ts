import type { Context, Hono } from "hono";
import {
  adminApiBasePath,
  adminBasePath,
  publicPageTarget,
  publicRootPath,
  type RuntimeConfig
} from "@imageshow/shared/browser";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { siteConfigPayload } from "../config/app-settings.ts";
import { staticResourceBaseUrl } from "../config/site-host.ts";
import { effectiveEmbedAncestorSources } from "../config/embed-ancestors.ts";
import { publishedPublicImageOrigins } from "../storage/objects/public-urls.ts";
import {
  embedSpaDocumentHeaders,
  markEmbedDocumentResponse,
  noStoreCacheControl,
  publicDocumentCacheControl,
  siteSpaDocumentHeaders
} from "../core/http/headers.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import {
  contentResponse,
  createContentSnapshot,
  type ContentRepresentation
} from "../core/http/content-response.ts";
import { createEncodedContentCache } from "../core/http/encoded-content.ts";

const publicDir = join(import.meta.dirname, "../public");

export function registerSpaRoutes(app: Hono) {
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

type DocumentPreloads = Readonly<Record<string, { scripts: string[]; styles: string[] }>>;

let spaTemplate: string | null = null;
let documentPreloads: DocumentPreloads | null = null;

// The web build lists, per document, the files of the page it opens beyond the
// entry; preloading them with the document saves a round trip on a cold load.
// The build always writes the list next to the server.
function readDocumentPreloads(): DocumentPreloads {
  documentPreloads ??= (JSON.parse(
    readFileSync(join(import.meta.dirname, "../document-preloads.json"), "utf8")
  ) as { documents: DocumentPreloads }).documents;
  return documentPreloads;
}

// Reads a document's first render waits on besides its code: the administrator
// document always reads the session first, then loads what that session sees.
const documentReads: Readonly<Record<string, readonly string[]>> = {
  admin: [`${adminApiBasePath}/auth/me`]
};

// The template's loading screen shows until a page renders, in the public
// loading color; the administrator document keeps the bootstrap text.
const publicLoadingClass = " app-public-loading";

/**
 * The documents a path opens: the page it shows under the same enable and
 * fallback rules as the web routes, and for embeds also the embed layout.
 */
function documentNames(path: string, runtime: RuntimeConfig): string[] {
  if (path === adminBasePath || path.startsWith(`${adminBasePath}/`)) return ["admin"];
  const embedEnabled = inlinedSiteConfig(runtime).config.embed.enabled;
  const target = publicPageTarget(runtime.site, embedEnabled, path);
  if (!target) return [];
  const embedded = /^\/embed\/(.+)$/.exec(target);
  return embedded ? ["embed", embedded[1]!] : [target.slice(1)];
}

// Public pages connect to the hosts their images come from while their code
// loads. The show page's textures are anonymous CORS fetches and the other
// pages' images credentialed loads, which browsers keep on separate connections.
function imageConnections(names: readonly string[]) {
  const page = names.find((name) => name === "home" || name === "gallery" || name === "show");
  if (!page) return "";
  const crossorigin = page === "show" ? " crossorigin" : "";
  return publishedPublicImageOrigins()
    .map((origin) => `<link rel="preconnect" href="${escapeHtmlAttr(origin)}"${crossorigin}>`)
    .join("");
}

const spaDocuments = new Map<string, {
  connections: string;
  representation: (runtime: RuntimeConfig) => ContentRepresentation;
  encoded: ReturnType<typeof createEncodedContentCache>;
}>();

function spaDocument(names: readonly string[], embedded: boolean, connections: string) {
  const key = `${embedded ? "embedded:" : ""}${names.join("+")}`;
  let document = spaDocuments.get(key);
  // The image hosts follow the storage registry rather than the configuration,
  // so a change replaces the document in place.
  if (document?.connections !== connections) {
    document = {
      connections,
      representation: createContentSnapshot(
        (runtime: RuntimeConfig) => buildSpaDocument(runtime, names, embedded, connections),
        // A cache revalidating the document must also see its policy change.
        (runtime: RuntimeConfig) => JSON.stringify(spaDocumentHeaders(runtime, embedded))
      ),
      encoded: createEncodedContentCache()
    };
    spaDocuments.set(key, document);
  }
  return document;
}

// Every document of one published configuration inlines the same payload.
let inlinedSite: Readonly<{
  runtime: RuntimeConfig;
  config: ReturnType<typeof siteConfigPayload>;
  json: string;
}> | undefined;

function inlinedSiteConfig(runtime: RuntimeConfig) {
  if (inlinedSite?.runtime !== runtime) {
    const config = siteConfigPayload(runtime);
    inlinedSite = { runtime, config, json: JSON.stringify(config).replace(/</g, "\\u003c") };
  }
  return inlinedSite;
}

function readSpaTemplate() {
  spaTemplate ??= readFileSync(join(publicDir, "index.html"), "utf8");
  return spaTemplate;
}

// Chunks import each other by stable names that the template's import map
// maps to the current files. Its addresses follow the static resource base
// like the document's other asset links, and the CSP allows the inline map
// by its hash.
const importMapPattern = /<script type="importmap">([\s\S]*?)<\/script>/;
let documentImportMap: Readonly<{ runtime: RuntimeConfig; text: string; hash: string }> | undefined;

function importMapOf(runtime: RuntimeConfig) {
  if (documentImportMap?.runtime !== runtime) {
    const source = importMapPattern.exec(readSpaTemplate())?.[1];
    if (source === undefined) throw new Error("The SPA template has no import map");
    const base = staticResourceBaseUrl(runtime);
    const located = (path: string) =>
      path.startsWith("./assets/") ? `${base}/${path.slice("./assets/".length)}` : path;
    const { imports } = JSON.parse(source) as { imports: Record<string, string> };
    const text = JSON.stringify({
      imports: Object.fromEntries(Object.entries(imports).map(([key, value]) => [located(key), located(value)]))
    }).replace(/</g, "\\u003c");
    documentImportMap = { runtime, text, hash: createHash("sha256").update(text).digest("base64") };
  }
  return documentImportMap;
}

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

function buildSpaDocument(
  runtime: RuntimeConfig,
  names: readonly string[],
  embedded: boolean,
  connections: string
): string {
  const source = readSpaTemplate();
  const preloads = readDocumentPreloads();
  const scripts = new Set(names.flatMap((name) => preloads[name]?.scripts ?? []));
  const styles = new Set(names.flatMap((name) => preloads[name]?.styles ?? []));
  const preloadLinks = [
    ...names.flatMap((name) => documentReads[name] ?? []).map((path) =>
      `<link rel="preload" as="fetch" crossorigin href="${escapeHtmlAttr(path)}">`),
    ...[...scripts].map((file) =>
      `<link rel="modulepreload" crossorigin href="./${escapeHtmlAttr(file)}">`),
    ...[...styles].map((file) =>
      `<link rel="preload" as="style" crossorigin href="./${escapeHtmlAttr(file)}">`)
  ].join("");
  const { config: { site }, json: inlineConfig } = inlinedSiteConfig(runtime);
  const title = escapeHtmlText(site.title);
  const description = escapeHtmlAttr(site.description);
  const iconUrl = escapeHtmlAttr(site.icon);
  const head = `<script type="application/json" id="__site_config__">${inlineConfig}</script>`;
  const template = names.includes("admin")
    ? source.replace(publicLoadingClass, "")
    : source;
  return template
    .replace(importMapPattern, () => `<script type="importmap">${importMapOf(runtime).text}</script>`)
    .replace("</head>", () => `${connections}${preloadLinks}</head>`)
    .replace(
      /\b(src|href)="\.\/assets\//g,
      (_match, attribute: string) =>
        `${attribute}="${escapeHtmlAttr(staticResourceBaseUrl(runtime))}/`
    )
    .replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${title}</title>`)
    .replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i,
      () => `<meta name="description" content="${description}" />`
    )
    .replace(
      /<link\s+rel="icon"[^>]*>/i,
      // The tab belongs to the parent page, so an embedded document's icon
      // never shows.
      () =>
        embedded
          ? ""
          : `<link rel="icon" type="${iconUrl.endsWith(".svg") ? "image/svg+xml" : ""}" href="${iconUrl}" />`
    )
    .replace("</head>", () => `${head}</head>`);
}

// A document's policy follows the configuration beyond its body: the script
// sources, and for embeds the ancestors allowed to frame it.
function spaDocumentHeaders(runtime: RuntimeConfig, embedded: boolean) {
  const inlineScriptHashes = [importMapOf(runtime).hash];
  return embedded
    ? embedSpaDocumentHeaders(effectiveEmbedAncestorSources(runtime), runtime.site, inlineScriptHashes)
    : siteSpaDocumentHeaders(runtime.site, inlineScriptHashes);
}

function spaDocumentResponse(c: Context, runtime: RuntimeConfig, embedded: boolean) {
  const names = documentNames(c.req.path, runtime);
  const document = spaDocument(names, embedded, imageConnections(names));
  const headers = spaDocumentHeaders(runtime, embedded);
  const selected = document.encoded(document.representation(runtime), c.req.header("accept-encoding"));
  if (!selected) {
    return new Response(null, {
      status: 406,
      headers: {
        ...headers,
        Vary: "Accept-Encoding",
        "Cache-Control": noStoreCacheControl
      }
    });
  }
  return contentResponse(selected, {
    cacheControl: publicDocumentCacheControl,
    contentType: "text/html; charset=utf-8",
    headers: { ...headers, Vary: "Accept-Encoding" },
    ifNoneMatch: c.req.header("if-none-match")
  });
}

async function spaHandler(c: Context) {
  return spaDocumentResponse(c, getRuntimeConfig(), false);
}

async function rootSpaHandler(c: Context) {
  if (publicRootPath(getRuntimeConfig().site) === null) {
    return apiErrorResponse({ status: 404, message: "Not Found" });
  }
  return spaHandler(c);
}

async function embedSpaHandler(c: Context) {
  const runtime = getRuntimeConfig();
  if (effectiveEmbedAncestorSources(runtime).length === 0) {
    return apiErrorResponse({ status: 404, message: "Not Found" });
  }
  return markEmbedDocumentResponse(c, spaDocumentResponse(c, runtime, true));
}
