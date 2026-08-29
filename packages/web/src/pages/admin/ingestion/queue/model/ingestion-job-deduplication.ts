import type { IngestionJob } from "../../../../../lib/types.js";
import { normalizeImportDownloadUrl } from "./import-job-source.js";

export function uploadFileFingerprint(file: File) {
  // 浏览器不会暴露普通文件选择器中的绝对路径。目录选择时使用相对路径，
  // 其他入口以名称、大小和修改时间识别同一次选择的文件。
  return [
    file.webkitRelativePath || file.name,
    file.size,
    file.lastModified
  ].join("\u0000");
}

export function filterNewUploadFiles(
  existingJobs: readonly IngestionJob[],
  files: readonly File[],
  reservedFingerprints: ReadonlySet<string> = new Set()
) {
  const fingerprints = new Set(
    existingJobs
      .filter((job) => job.kind === "upload")
      .map((job) => job.fileFingerprint)
      .filter((fingerprint): fingerprint is string => Boolean(fingerprint))
  );
  for (const fingerprint of reservedFingerprints) fingerprints.add(fingerprint);
  return files.filter((file) => {
    const fingerprint = uploadFileFingerprint(file);
    if (fingerprints.has(fingerprint)) return false;
    fingerprints.add(fingerprint);
    return true;
  });
}

export function deduplicateImportJobsByDownloadUrl(
  existingJobs: readonly IngestionJob[],
  incomingJobs: readonly IngestionJob[]
) {
  const downloadUrls = new Set(
    existingJobs
      .filter((job) => job.kind === "import" && job.downloadUrl)
      .map((job) => normalizeImportDownloadUrl(job.downloadUrl!))
      .filter((url): url is string => Boolean(url))
  );
  return incomingJobs.filter((job) => {
    if (job.kind !== "import" || !job.downloadUrl) return true;
    const downloadUrl = normalizeImportDownloadUrl(job.downloadUrl);
    if (!downloadUrl) return true;
    if (downloadUrls.has(downloadUrl)) return false;
    downloadUrls.add(downloadUrl);
    return true;
  });
}
