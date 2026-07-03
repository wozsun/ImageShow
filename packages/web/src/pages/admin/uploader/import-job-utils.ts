import type { Device, ImageDraft, ImportJob } from "../../../lib/types.js";
import { browserUuid, resolveUploadDefaultBrightness, runWithConcurrency, type CommonAttributes } from "../../../lib/upload/upload-utils.js";
import type { PreparedImport } from "./import-api.js";

export function parseImportUrls(input: string | string[]) {
  const raw = Array.isArray(input) ? input : input.split(/\s+/);
  const seen = new Set<string>();
  return raw.map((url) => url.trim()).filter((url) => {
    if (!/^https:\/\//i.test(url) || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function linkDraft(url: string, defaults: CommonAttributes, fillOriginalUrl: boolean): ImageDraft {
  return {
    title: "",
    description: "",
    source: "",
    original: fillOriginalUrl ? url : "",
    device: defaults.device ? defaults.device as Device : "pc",
    brightness: resolveUploadDefaultBrightness(defaults.brightness, "auto"),
    theme: defaults.theme,
    author: defaults.author,
    tags: [...defaults.tags]
  };
}

export function linkImportJobs(
  kind: "download" | "proxy",
  urls: string[],
  defaults: CommonAttributes,
  fillOriginalUrl: boolean,
  storageSlug: string
) {
  return parseImportUrls(urls).map((url): ImportJob => ({
    id: browserUuid(),
    kind,
    status: "queued",
    message: "等待下载",
    preview: "",
    draft: linkDraft(url, defaults, fillOriginalUrl),
    width: 0,
    height: 0,
    uploadProgress: 0,
    duplicates: [],
    duplicateDecision: "upload",
    detected: { device: "pc", brightness: "auto" },
    url,
    storageSlug
  }));
}

export function draftWithPreparedDetection(draft: ImageDraft, defaults: CommonAttributes, prepared: Pick<PreparedImport, "device" | "brightness">): ImageDraft {
  return {
    ...draft,
    device: defaults.device ? defaults.device as Device : prepared.device,
    brightness: resolveUploadDefaultBrightness(defaults.brightness, prepared.brightness)
  };
}

export function retryPrepareJob(job: ImportJob): ImportJob {
  return {
    ...job,
    stagingId: browserUuid(),
    status: "queued",
    failureStage: undefined,
    message: "等待重试"
  };
}

export async function appendAndPrepare(
  queue: { appendJobs: (jobs: ImportJob[]) => void },
  jobs: ImportJob[],
  concurrency: number,
  prepare: (job: ImportJob) => Promise<void>
) {
  queue.appendJobs(jobs);
  await runWithConcurrency(jobs, concurrency, prepare);
}
