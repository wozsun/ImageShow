import type {
  ImageDraft,
  IngestionCommonAttributeField,
  IngestionDetectedClassification,
  IngestionJob
} from "../../../../../lib/types.js";
import type { IngestionAttributeDefaults } from "./ingestion-attribute-defaults.js";

type IngestionAttributePhase = "initial" | "ready" | "locked";
export type IngestionAutomaticClassificationLabel =
  | "待上传"
  | "待下载"
  | "待识别"
  | "识别中"
  | "自动识别";

const initialAttributeStatuses = new Set<IngestionJob["status"]>([
  "queued",
  "uploading",
  "downloading",
  "received"
]);

function ingestionAttributePhase(job: IngestionJob): IngestionAttributePhase {
  if (job.commitIntent) return "locked";
  if (job.status === "ready") return "ready";
  if (initialAttributeStatuses.has(job.status)) return "initial";
  if (job.uploadIntentItemInput || job.importAcceptItemInput) return "locked";
  if (job.status !== "failed") return "locked";

  if (job.failureStage === "commit" || job.failureStage === "cancel") {
    return "locked";
  }
  return "initial";
}

export function ingestionAutomaticClassificationLabel(
  job: Pick<IngestionJob, "kind" | "status">
): IngestionAutomaticClassificationLabel {
  if (job.status === "queued") {
    return job.kind === "upload" ? "待上传" : "待下载";
  }
  if (job.status === "uploading") return "待上传";
  if (job.status === "downloading") return "待下载";
  if (job.status === "received") return "待识别";
  if (job.status === "processing") return "识别中";
  return "自动识别";
}

export function ingestionJobAttributesEditable(job: IngestionJob) {
  return ingestionAttributePhase(job) === "ready"
    && job.serverHandoffPending !== true;
}

export function imageDraftPatchChanges(
  draft: ImageDraft,
  patch: Partial<ImageDraft>
) {
  return (Object.keys(patch) as Array<keyof ImageDraft>).some((field) => {
    const current = draft[field];
    const next = patch[field];
    if (Array.isArray(current) && Array.isArray(next)) {
      return current.length !== next.length
        || current.some((value, index) => value !== next[index]);
    }
    return current !== next;
  });
}

function initialAttributePatch(
  job: IngestionJob,
  defaults: IngestionAttributeDefaults
): Partial<ImageDraft> {
  const provided = new Set<IngestionCommonAttributeField>(
    job.manifestProvidedCommonFields ?? []
  );
  return {
    ...(!provided.has("device") ? { device: defaults.device } : {}),
    ...(!provided.has("brightness") ? { brightness: defaults.brightness } : {}),
    ...(!provided.has("theme") ? { theme: defaults.theme } : {}),
    ...(!provided.has("author") ? { author: defaults.author } : {})
  };
}

function readyAttributePatch(
  job: IngestionJob,
  defaults: IngestionAttributeDefaults
): Partial<ImageDraft> {
  const device = defaults.device === "auto"
    ? job.detectedClassification?.device
    : defaults.device;
  const brightness = defaults.brightness === "auto"
    ? job.detectedClassification?.brightness
    : defaults.brightness;
  return {
    ...(device ? { device } : {}),
    ...(brightness ? { brightness } : {}),
    ...(defaults.theme.trim() ? { theme: defaults.theme } : {}),
    ...(defaults.author.trim() ? { author: defaults.author } : {})
  };
}

export function ingestionAttributeDefaultsPatch(
  job: IngestionJob,
  defaults: IngestionAttributeDefaults
): Partial<ImageDraft> {
  const phase = ingestionAttributePhase(job);
  if (phase === "locked") return {};
  return {
    ...(phase === "initial"
      ? initialAttributePatch(job, defaults)
      : readyAttributePatch(job, defaults)),
    ...(defaults.tags.length
      ? { tags: [...new Set([...job.draft.tags, ...defaults.tags])] }
      : {})
  };
}

export function ingestionAttributeDefaultsActionMetadata(
  defaults: IngestionAttributeDefaults
): Partial<ImageDraft> {
  const theme = defaults.theme.trim();
  const author = defaults.author.trim();
  return {
    device: defaults.device,
    brightness: defaults.brightness,
    ...(theme ? { theme } : {}),
    ...(author ? { author } : {}),
    ...(defaults.tags.length ? { tags: [...new Set(defaults.tags)] } : {})
  };
}

export function canApplyIngestionAttributeDefaults(
  job: IngestionJob,
  defaults: IngestionAttributeDefaults
) {
  return imageDraftPatchChanges(
    job.draft,
    ingestionAttributeDefaultsPatch(job, defaults)
  );
}

export function draftWithDetectedClassification(
  draft: ImageDraft,
  detected: IngestionDetectedClassification
): ImageDraft {
  return {
    ...draft,
    device: draft.device === "auto" ? detected.device : draft.device,
    brightness: draft.brightness === "auto" ? detected.brightness : draft.brightness
  };
}

export function classificationOverrideFor(
  draft: ImageDraft,
  detected: IngestionDetectedClassification | undefined
): IngestionJob["classificationOverride"] {
  if (!detected) return undefined;
  const override: NonNullable<IngestionJob["classificationOverride"]> = {};
  if (draft.device !== detected.device) override.device = true;
  if (draft.brightness !== detected.brightness) override.brightness = true;
  return Object.keys(override).length ? override : undefined;
}
