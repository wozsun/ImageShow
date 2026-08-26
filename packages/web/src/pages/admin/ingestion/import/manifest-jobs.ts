import type {
  ImageDraft,
  IngestionCommonAttributeField,
  IngestionJob
} from "../../../../lib/types.js";
import type { IngestionAttributeDefaults } from "../queue/model/ingestion-attribute-defaults.js";
import {
  webIngestionBatchKey,
  webUuidV7
} from "../queue/model/ingestion-identity.js";
import type { JsonlManifestItem } from "../queue/ingestion-api.js";

function valueOrDefault<T>(value: T | undefined, fallback: T) {
  return value === undefined ? fallback : value;
}

const manifestCommonAttributeFields: readonly IngestionCommonAttributeField[] = [
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
  defaults: IngestionAttributeDefaults
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

export function manifestImportJobs(
  items: JsonlManifestItem[],
  defaults: IngestionAttributeDefaults,
  defaultStorageSlug: string,
  source: "jsonl" | "weibo" = "jsonl"
): IngestionJob[] {
  const batchTime = new Date().toISOString();
  const subscriptionBatchKey = webIngestionBatchKey();
  return items.map((item) => ({
    id: webUuidV7(),
    attemptKey: webUuidV7(),
    subscriptionBatchKey,
    kind: "import",
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
    manifestSource: source,
    manifestProvidedCommonFields: providedManifestCommonFields(item),
    manifestLine: item.line,
    manifestPosition: item.manifest_position
  }));
}
