import type { IngestionJob } from "./model/ingestion-job.js";

/** Queue-owned URLs are adopted from producers and released at most once. */
export class IngestionPreviews {
  #owned = new Set<string>();

  adopt(job: IngestionJob) {
    if (job.objectUrl?.startsWith("blob:")) this.#owned.add(job.objectUrl);
  }

  releaseUrl(url: string | undefined) {
    if (url && this.#owned.delete(url)) URL.revokeObjectURL(url);
  }

  release = (job: IngestionJob) => {
    this.releaseUrl(job.objectUrl);
  };

  replace(previous: IngestionJob | undefined, next: IngestionJob) {
    if (previous?.objectUrl === next.objectUrl) return;
    this.releaseUrl(previous?.objectUrl);
    this.adopt(next);
  }

  clear() {
    for (const url of this.#owned) URL.revokeObjectURL(url);
    this.#owned.clear();
  }
}
