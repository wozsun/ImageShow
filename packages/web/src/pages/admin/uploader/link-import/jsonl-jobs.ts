import type {
  ImageDraft,
  ImportCommonAttributeField,
  ImportJob
} from "../../../../lib/types.js";
import {
  browserUuid,
  type ImportAttributeDefaults
} from "../../../../lib/upload/upload-utils.js";
import type { JsonlManifestItem } from "../import-api.js";

function valueOrDefault<T>(value: T | undefined, fallback: T) {
  return value === undefined ? fallback : value;
}

const manifestCommonAttributeFields: readonly ImportCommonAttributeField[] = [
  "device",
  "brightness",
  "theme",
  "author",
  "tags"
];

function providedManifestCommonFields(item: JsonlManifestItem) {
  return manifestCommonAttributeFields.filter((field) => Object.hasOwn(item, field));
}

function mergeJsonlDraft(
  item: JsonlManifestItem,
  defaults: ImportAttributeDefaults
): ImageDraft {
  return {
    title: item.title ?? "",
    description: item.description ?? "",
    source: item.source ?? "",
    original: item.original,
    device: valueOrDefault(item.device, defaults.device),
    brightness: valueOrDefault(item.brightness, defaults.brightness),
    theme: valueOrDefault(item.theme, defaults.theme),
    author: valueOrDefault(item.author, defaults.author),
    tags: item.tags === undefined ? [...defaults.tags] : [...item.tags]
  };
}

export function jsonlImportJobs(
  items: JsonlManifestItem[],
  defaults: ImportAttributeDefaults,
  defaultStorageSlug: string
): ImportJob[] {
  const batchTime = new Date().toISOString();
  return items.map((item) => ({
    id: browserUuid(),
    attemptKey: browserUuid(),
    kind: "download",
    status: "queued",
    message: "等待下载",
    preview: "",
    draft: mergeJsonlDraft(item, defaults),
    width: 0,
    height: 0,
    duplicates: [],
    duplicateDecision: "upload",
    url: item.original,
    storageSlug: item.storage_slug ?? defaultStorageSlug,
    imageTime: item.image_time,
    batchTime,
    manifestSource: "jsonl",
    manifestProvidedCommonFields: providedManifestCommonFields(item),
    manifestLine: item.line,
    manifestPosition: item.manifest_position,
    duplicatePolicy: "skip"
  }));
}
