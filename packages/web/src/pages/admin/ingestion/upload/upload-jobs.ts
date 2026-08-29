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
} from "../queue/model/ingestion-job-deduplication.js";

function createUploadDraft(
  defaults: IngestionAttributeDefaults
): ImageDraft {
  return {
    device: defaults.device,
    brightness: defaults.brightness,
    theme: defaults.theme.trim().toLowerCase(),
    author: defaults.author.trim().toLowerCase(),
    title: "",
    description: "",
    source: "",
    original: "",
    tags: [...new Set(defaults.tags)]
  };
}

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

async function inspectUploadPreview(
  defaults: IngestionAttributeDefaults,
  previewUrl: string
) {
  const dimensions = await loadImageDimensions(previewUrl);
  return {
    draft: createUploadDraft(defaults),
    width: dimensions.width,
    height: dimensions.height
  };
}

export function buildUploadIntentItemInput(
  job: IngestionJob,
  maxLongEdge: number
) {
  if (!job.file) throw new Error("上传任务缺少图片文件");
  if (job.batchPosition === undefined) {
    throw new Error("上传任务缺少批次位置");
  }
  if (job.uploadIntentItemInput?.idempotency_key === job.attemptKey) {
    return job.uploadIntentItemInput;
  }
  return {
    ...job.draft,
    theme: normalizeTheme(job.draft.theme),
    author: normalizeAuthor(job.draft.author),
    idempotency_key: job.attemptKey,
    batch_key: job.batchKey,
    storage_slug: job.storageSlug,
    batch_time: job.batchTime,
    batch_position: job.batchPosition,
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
  maxLongEdge,
  runInBrowserLane
}: {
  files: readonly File[];
  defaults: IngestionAttributeDefaults;
  storageSlug: string;
  maxBytes: number;
  maxLongEdge: number;
  runInBrowserLane: <Result>(work: () => Promise<Result>) => Promise<Result>;
}) {
  const batchTime = new Date().toISOString();
  const batchKey = webIngestionBatchKey();
  const outcomes = await Promise.allSettled(files.map((
    file,
    batchPosition
  ): Promise<IngestionJob> => runInBrowserLane(async () => {
    const objectUrl = URL.createObjectURL(file);
    try {
      const preview = await inspectUploadPreview(defaults, objectUrl);
      const tooLarge = file.size > maxBytes;
      const tooWide = Math.max(preview.width, preview.height) > maxLongEdge;
      return {
        id: webUuidV7(),
        attemptKey: webUuidV7(),
        batchKey,
        batchTime,
        batchPosition,
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
        draft: preview.draft,
        width: preview.width,
        height: preview.height,
        originalWidth: preview.width,
        originalHeight: preview.height,
        transferProgress: 0,
        duplicates: [],
        duplicateDecision: "upload",
        storageSlug,
        originalSize: file.size
      };
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
  })));
  const jobs: IngestionJob[] = [];
  let failed = false;
  let firstError: unknown;
  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled") jobs.push(outcome.value);
    else if (!failed) {
      failed = true;
      firstError = outcome.reason;
    }
  }
  if (failed) {
    revokeUploadJobPreviews(jobs);
    throw firstError;
  }
  return jobs;
}

export function revokeUploadJobPreviews(jobs: readonly IngestionJob[]) {
  for (const job of jobs) {
    if (job.objectUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(job.objectUrl);
    }
  }
}
