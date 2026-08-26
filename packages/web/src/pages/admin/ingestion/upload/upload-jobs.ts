import type { ImageDraft, IngestionJob } from "../../../../lib/types.js";
import { normalizeAuthor, normalizeTheme } from "../../../../lib/image-draft.js";
import type { IngestionAttributeDefaults } from "../queue/model/ingestion-attribute-defaults.js";
import {
  webIngestionBatchKey,
  webUuidV7
} from "../queue/model/ingestion-identity.js";
import {
  filterNewUploadFiles,
  uploadFileFingerprint
} from "../queue/model/ingestion-job-utils.js";

const defaultDraft: ImageDraft = {
  device: "auto",
  brightness: "auto",
  theme: "",
  author: "",
  title: "",
  description: "",
  source: "",
  original: "",
  tags: []
};

function fileExt(file: File) {
  return (file.name.split(".").pop() || "").toLowerCase();
}

function isUploadableImage(file: File) {
  return file.type.startsWith("image/")
    || ["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(fileExt(file));
}

async function loadImageDimensions(previewUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    const finish = (width = 0, height = 0) => {
      window.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      resolve({ width, height });
    };
    const timeout = window.setTimeout(() => finish(), 2000);
    image.onload = () => finish(image.naturalWidth, image.naturalHeight);
    image.onerror = () => finish();
    image.src = previewUrl;
  });
}

function applyUploadDefaults(
  inferred: ImageDraft,
  defaults: IngestionAttributeDefaults
): ImageDraft {
  return {
    ...inferred,
    device: defaults.device,
    brightness: defaults.brightness,
    theme: defaults.theme.trim() ? defaults.theme.trim().toLowerCase() : inferred.theme,
    author: defaults.author.trim() ? defaults.author.trim().toLowerCase() : inferred.author,
    tags: defaults.tags.length ? [...new Set([...inferred.tags, ...defaults.tags])] : inferred.tags
  };
}

async function draftFromFile(
  defaults: IngestionAttributeDefaults,
  previewUrl: string
) {
  const image = await loadImageDimensions(previewUrl);
  return {
    draft: applyUploadDefaults(defaultDraft, defaults),
    width: image.width,
    height: image.height
  };
}

export function uploadIntentInput(
  job: IngestionJob,
  maxLongEdge: number
) {
  if (!job.file) throw new Error("上传任务缺少图片文件");
  if (job.manifestPosition === undefined) {
    throw new Error("上传任务缺少批次位置");
  }
  if (job.uploadIntentInput?.idempotency_key === job.attemptKey) {
    return job.uploadIntentInput;
  }
  return {
    ...job.draft,
    theme: normalizeTheme(job.draft.theme),
    author: normalizeAuthor(job.draft.author),
    idempotency_key: job.attemptKey,
    batch_key: job.subscriptionBatchKey,
    storage_slug: job.storageSlug,
    batch_time: job.batchTime,
    manifest_position: job.manifestPosition,
    expected_size: job.file.size,
    max_long_edge: maxLongEdge
  };
}

export function selectUploadFiles(
  jobs: readonly IngestionJob[],
  files: FileList | null,
  pendingFingerprints: ReadonlySet<string>
) {
  return filterNewUploadFiles(
    jobs,
    Array.from(files ?? []).filter(isUploadableImage),
    pendingFingerprints
  );
}

export function uploadFileFingerprints(files: readonly File[]) {
  return files.map(uploadFileFingerprint);
}

export async function createUploadJobs({
  files,
  defaults,
  storageSlug,
  maxBytes,
  maxLongEdge
}: {
  files: readonly File[];
  defaults: IngestionAttributeDefaults;
  storageSlug: string;
  maxBytes: number;
  maxLongEdge: number;
}) {
  const batchTime = new Date().toISOString();
  const subscriptionBatchKey = webIngestionBatchKey();
  return Promise.all(files.map(async (
    file,
    manifestPosition
  ): Promise<IngestionJob> => {
    const objectUrl = URL.createObjectURL(file);
    const inferred = await draftFromFile(defaults, objectUrl);
    const tooLarge = file.size > maxBytes;
    const tooWide = Math.max(inferred.width, inferred.height) > maxLongEdge;
    return {
      id: webUuidV7(),
      attemptKey: webUuidV7(),
      subscriptionBatchKey,
      batchTime,
      manifestPosition,
      kind: "upload",
      file,
      fileFingerprint: uploadFileFingerprint(file),
      status: tooLarge || tooWide ? "failed" : "queued",
      failureStage: tooLarge || tooWide ? "create" : undefined,
      message: tooLarge
        ? "图片大小超过限制"
        : tooWide
          ? "图片长边超过限制"
          : "等待上传",
      preview: objectUrl,
      objectUrl,
      draft: inferred.draft,
      width: inferred.width,
      height: inferred.height,
      originalWidth: inferred.width,
      originalHeight: inferred.height,
      transferProgress: 0,
      duplicates: [],
      duplicateDecision: "upload",
      storageSlug,
      originalSize: file.size
    };
  }));
}

export function revokeUploadJobPreviews(jobs: readonly IngestionJob[]) {
  for (const job of jobs) {
    if (job.objectUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(job.objectUrl);
    }
  }
}
