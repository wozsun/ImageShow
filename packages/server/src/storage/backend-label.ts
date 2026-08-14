const storageBackendLabels: Record<string, string> = {
  local: "本地存储"
};

export function storageBackendLabel(row: {
  storage_slug: string;
  storage_display_name?: string | null;
}) {
  return row.storage_display_name?.trim()
    || storageBackendLabels[row.storage_slug]
    || row.storage_slug;
}
