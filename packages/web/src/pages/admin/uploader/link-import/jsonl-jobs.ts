import type { ImageDraft, ImportJob } from "../../../../lib/types.js";
import { browserUuid, resolveUploadDefaultBrightness, type CommonImageAttributes } from "../../../../lib/upload/upload-utils.js";
import type { JsonlManifestItem } from "../import-api.js";
import type { LinkImportMode } from "./LinkUrlDialog.js";

function valueOrDefault<T>(value: T | undefined, fallback: T) {
  return value === undefined ? fallback : value;
}

/** @internal Exported only for local JSONL precedence verification. */
export function mergeJsonlDraft(item: JsonlManifestItem, defaults: CommonImageAttributes): ImageDraft {
  return {
    title: item.title ?? "",
    description: item.description ?? "",
    source: item.source ?? "",
    original: item.original,
    device: valueOrDefault(item.device, defaults.device ? defaults.device as ImageDraft["device"] : "auto"),
    brightness: valueOrDefault(item.brightness, resolveUploadDefaultBrightness(defaults.brightness, "auto")),
    theme: valueOrDefault(item.theme, defaults.theme),
    author: valueOrDefault(item.author, defaults.author),
    tags: item.tags === undefined ? [...defaults.tags] : [...item.tags]
  };
}

export function jsonlImportJobs(
  items: JsonlManifestItem[],
  defaults: CommonImageAttributes,
  defaultMode: LinkImportMode,
  defaultStorageSlug: string
): ImportJob[] {
  const batchTime = new Date().toISOString();
  return items.map((item) => ({
    id: browserUuid(),
    attemptKey: browserUuid(),
    kind: item.mode ?? defaultMode,
    status: "queued",
    message: "等待下载",
    preview: "",
    draft: mergeJsonlDraft(item, defaults),
    width: 0,
    height: 0,
    uploadProgress: 0,
    duplicates: [],
    duplicateDecision: "upload",
    url: item.original,
    storageSlug: item.storage_slug ?? defaultStorageSlug,
    imageTime: item.image_time,
    batchTime,
    manifestLine: item.line,
    manifestPosition: item.manifest_position,
    duplicatePolicy: "skip",
    inlineMetadataFields: (["device", "brightness", "theme", "author", "tags"] as const)
      .filter((field) => Object.hasOwn(item, field))
  }));
}
