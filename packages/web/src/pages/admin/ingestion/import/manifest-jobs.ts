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
import type { ImportManifestItem } from "../queue/ingestion-api.js";

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

function providedManifestCommonFields(item: ImportManifestItem) {
  return manifestCommonAttributeFields.filter((field) => Object.hasOwn(item, field));
}

function createManifestItemDraft(
  item: ImportManifestItem,
  defaults: IngestionAttributeDefaults,
  retainOriginalLink: boolean
): ImageDraft {
  return {
    title: item.title ?? "",
    description: item.description ?? "",
    source: item.source ?? "",
    original: retainOriginalLink ? item.original : "",
    device: valueOrDefault(item.device, defaults.device),
    brightness: valueOrDefault(item.brightness, defaults.brightness),
    theme: valueOrDefault(item.theme, defaults.theme),
    author: valueOrDefault(item.author, defaults.author),
    tags: item.tags === undefined ? [...defaults.tags] : [...item.tags]
  };
}

export function createManifestImportJobs(
  items: ImportManifestItem[],
  defaults: IngestionAttributeDefaults,
  defaultStorageSlug: string,
  manifestSource: "jsonl" | "weibo",
  retainOriginalLink: boolean
): IngestionJob[] {
  const batchTime = new Date().toISOString();
  const batchKey = webIngestionBatchKey();
  return items.map((item) => ({
    id: webUuidV7(),
    attemptKey: webUuidV7(),
    batchKey,
    kind: "import",
    status: "queued",
    message: "等待下载",
    preview: "",
    draft: createManifestItemDraft(item, defaults, retainOriginalLink),
    width: 0,
    height: 0,
    duplicates: [],
    duplicateDecision: "upload",
    downloadUrl: item.original,
    storageSlug: item.storage_slug ?? defaultStorageSlug,
    imageTime: item.image_time,
    batchTime,
    manifestSource,
    manifestProvidedCommonFields: providedManifestCommonFields(item),
    manifestLine: item.line,
    batchPosition: item.batch_position
  }));
}
