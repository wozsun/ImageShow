import type { AdminImageListItemDto } from "@imageshow/shared/browser";
import {
  getDuplicateSnapshotByMd5
} from "../../read-models/duplicates.ts";

export function ingestionContentLockKey(md5: string) {
  return `imageshow:ingestion:content:${md5}`;
}

export async function captureIngestionDuplicateCheck(md5: string): Promise<{
  check: { md5: string; match_count: number };
  duplicates: AdminImageListItemDto[];
}> {
  const snapshot = await getDuplicateSnapshotByMd5(md5);
  return {
    check: { md5, match_count: snapshot.matchCount },
    duplicates: snapshot.items
  };
}
