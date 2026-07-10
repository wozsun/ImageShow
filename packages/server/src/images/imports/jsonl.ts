import { z } from "zod";
import { appConfig, slugPattern, type Brightness, type Device, type ImportMode } from "@imageshow/shared";
import { ImageTimeError, parseImageTime } from "../image-time.ts";

const httpsUrl = z.string().trim().max(2048).url().refine((value) => new URL(value).protocol === "https:", "必须使用 HTTPS URL");
const pageUrl = z.string().trim().max(2048).url().refine((value) => new URL(value).protocol === "https:", "必须使用 HTTPS URL");
const slug = z.string().trim().toLowerCase().min(1).max(32).regex(slugPattern);

const jsonlRowSchema = z.object({
  original: httpsUrl,
  source: pageUrl.optional(),
  image_time: z.string().trim().min(1).max(64).optional(),
  mode: z.enum(["download", "proxy"]).optional(),
  author: slug.optional(),
  tags: z.array(slug).max(50).transform((tags) => [...new Set(tags)]).optional(),
  title: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  theme: slug.optional(),
  device: z.enum([...appConfig.devices, "auto"]).optional(),
  brightness: z.enum([...appConfig.brightness, "auto"]).optional(),
  storage_slug: slug.optional()
}).strict();

type JsonlManifestItem = {
  line: number;
  manifest_position: number;
  original: string;
  source?: string;
  image_time?: string;
  mode?: Extract<ImportMode, "download" | "proxy">;
  author?: string;
  tags?: string[];
  title?: string;
  description?: string;
  theme?: string;
  device?: Device | "auto";
  brightness?: Brightness | "auto";
  storage_slug?: string;
};

type JsonlManifestErrorItem = {
  line: number;
  raw: string;
  error: string;
};

export class JsonlManifestError extends Error {
  readonly code: "jsonl_limit_exceeded" | "jsonl_too_large";

  constructor(code: "jsonl_limit_exceeded" | "jsonl_too_large", message: string) {
    super(message);
    this.code = code;
  }
}

function zodErrorMessage(error: z.ZodError) {
  return [...new Set(error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  }))].join("；");
}

export function parseJsonlManifest(content: string, options: { maxItems: number; timeZone?: string }) {
  const maxItems = Math.max(1, Math.floor(options.maxItems));
  if (Buffer.byteLength(content, "utf8") > appConfig.imports.jsonlManifestMaxBytes) {
    throw new JsonlManifestError("jsonl_too_large", "JSONL 清单内容过大");
  }
  const lines = content.split(/\r?\n/)
    .map((raw, index) => ({ line: index + 1, raw: raw.trim() }))
    .filter((entry) => entry.raw.length > 0)
    .map((entry, manifestPosition) => ({ ...entry, manifestPosition }));
  if (lines.length > maxItems) {
    throw new JsonlManifestError("jsonl_limit_exceeded", `JSONL 清单最多允许 ${maxItems} 条图片记录`);
  }

  const items: JsonlManifestItem[] = [];
  const errors: JsonlManifestErrorItem[] = [];
  for (const entry of lines) {
    try {
      const value = jsonlRowSchema.parse(JSON.parse(entry.raw));
      let imageTime: string | undefined;
      if (value.image_time !== undefined) imageTime = parseImageTime(value.image_time, { timeZone: options.timeZone }).iso;
      items.push({
        ...value,
        line: entry.line,
        manifest_position: entry.manifestPosition,
        image_time: imageTime
      });
    } catch (error) {
      const message = error instanceof z.ZodError ? zodErrorMessage(error)
        : error instanceof ImageTimeError ? error.message
          : error instanceof SyntaxError ? "不是有效的 JSON 对象"
            : "JSONL 行无法解析";
      errors.push({ line: entry.line, raw: errorLinePreview(entry.raw), error: message });
    }
  }
  return { items, errors, total: lines.length };
}

function errorLinePreview(value: string) {
  return value.length <= 500 ? value : `${value.slice(0, 500)}...`;
}
