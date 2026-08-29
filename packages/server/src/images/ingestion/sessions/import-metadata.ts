import type {
  ImageDraftDto,
  ImportSourceTypeDto,
  RuntimeConfig
} from "@imageshow/shared/browser";

type ImportMetadataRuntime = {
  import: Pick<RuntimeConfig["import"], "keep_original_link">;
  weibo: Pick<RuntimeConfig["weibo"], "source_enabled">;
};

export function canonicalImportMetadata(
  runtime: ImportMetadataRuntime,
  sourceType: ImportSourceTypeDto,
  downloadUrl: string,
  metadata: ImageDraftDto
): ImageDraftDto {
  return {
    ...metadata,
    source: sourceType === "weibo" && !runtime.weibo.source_enabled
      ? ""
      : metadata.source,
    original: runtime.import.keep_original_link.includes(sourceType)
      ? downloadUrl
      : ""
  };
}
