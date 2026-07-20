import type {
  ImageDraft,
  ImportCommonAttributeField,
  ImportDetectedClassification,
  ImportJob
} from "../../../lib/types.js";
import type { ImportAttributeDefaults } from "../../../lib/upload/upload-utils.js";

type ImportAttributePhase = "initial" | "ready" | "locked";

const initialAttributeStatuses = new Set<ImportJob["status"]>([
  "queued",
  "uploading",
  "downloading"
]);

function importAttributePhase(job: ImportJob): ImportAttributePhase {
  if (initialAttributeStatuses.has(job.status)) return "initial";
  if (job.status === "ready") return "ready";
  if (job.status !== "failed") return "locked";

  if (job.failureStage === "commit") {
    return job.commitFailureCheckpoint === "ready" ? "ready" : "locked";
  }
  if (job.failureStage === "cancel") return "locked";
  return "initial";
}

export function importJobAttributesEditable(job: ImportJob) {
  return importAttributePhase(job) === "ready";
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
  job: ImportJob,
  defaults: ImportAttributeDefaults
): Partial<ImageDraft> {
  const provided = new Set<ImportCommonAttributeField>(
    job.manifestProvidedCommonFields ?? []
  );
  return {
    ...(!provided.has("device") ? { device: defaults.device } : {}),
    ...(!provided.has("brightness") ? { brightness: defaults.brightness } : {}),
    ...(!provided.has("theme") ? { theme: defaults.theme } : {}),
    ...(!provided.has("author") ? { author: defaults.author } : {}),
    ...(!provided.has("tags") ? { tags: [...defaults.tags] } : {})
  };
}

function readyAttributePatch(
  job: ImportJob,
  defaults: ImportAttributeDefaults
): Partial<ImageDraft> {
  const device = defaults.device === "auto"
    ? job.detectedClassification?.device
    : defaults.device;
  const brightness = defaults.brightness === "auto"
    ? job.detectedClassification?.brightness
    : defaults.brightness;
  const tags = defaults.tags.length
    ? [...new Set([...job.draft.tags, ...defaults.tags])]
    : undefined;
  return {
    ...(device ? { device } : {}),
    ...(brightness ? { brightness } : {}),
    ...(defaults.theme.trim() ? { theme: defaults.theme } : {}),
    ...(defaults.author.trim() ? { author: defaults.author } : {}),
    ...(tags ? { tags } : {})
  };
}

export function importAttributeDefaultsPatch(
  job: ImportJob,
  defaults: ImportAttributeDefaults
): Partial<ImageDraft> {
  const phase = importAttributePhase(job);
  if (phase === "initial") return initialAttributePatch(job, defaults);
  if (phase === "ready") return readyAttributePatch(job, defaults);
  return {};
}

export function canApplyImportAttributeDefaults(
  job: ImportJob,
  defaults: ImportAttributeDefaults
) {
  return imageDraftPatchChanges(
    job.draft,
    importAttributeDefaultsPatch(job, defaults)
  );
}

export function draftWithDetectedClassification(
  draft: ImageDraft,
  detected: ImportDetectedClassification
): ImageDraft {
  return {
    ...draft,
    device: draft.device === "auto" ? detected.device : draft.device,
    brightness: draft.brightness === "auto" ? detected.brightness : draft.brightness
  };
}

export function classificationOverrideFor(
  draft: ImageDraft,
  detected: ImportDetectedClassification | undefined
): ImportJob["classificationOverride"] {
  if (!detected) return undefined;
  const override: NonNullable<ImportJob["classificationOverride"]> = {};
  if (draft.device !== detected.device) override.device = true;
  if (draft.brightness !== detected.brightness) override.brightness = true;
  return Object.keys(override).length ? override : undefined;
}
