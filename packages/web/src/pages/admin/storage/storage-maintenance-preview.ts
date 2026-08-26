type StorageIssue = Record<string, unknown>;

function issueList(
  result: Record<string, unknown>,
  key: string
): StorageIssue[] {
  const value = result[key];
  return Array.isArray(value)
    ? value.filter((item): item is StorageIssue => (
        Boolean(item) && typeof item === "object" && !Array.isArray(item)
      ))
    : [];
}

function issueId(issue: StorageIssue) {
  return typeof issue.id === "string" ? issue.id : "";
}

function issueText(issue: StorageIssue, key: string) {
  return typeof issue[key] === "string" ? issue[key] : "";
}

function issueNamespace(issue: StorageIssue) {
  return issueText(issue, "namespace") || issueText(issue, "backend");
}

export function storageMaintenancePreview(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const storage = result as Record<string, unknown>;
  const requiredKeys = [
    "missing_objects",
    "missing_thumbs",
    "pending_thumbnail_repairs",
    "orphan_objects",
    "orphan_thumbs",
    "active_staging_files",
    "retained_staging_files",
    "orphan_staging_files",
    "incomplete_listings",
    "unavailable_backends"
  ];
  if (!requiredKeys.every((key) => Array.isArray(storage[key]))) return null;

  const missingObjects = issueList(storage, "missing_objects");
  const missingObjectIds = new Set(missingObjects.map(issueId).filter(Boolean));
  const missingThumbs = issueList(storage, "missing_thumbs");
  const repairCandidates = [
    ...missingThumbs,
    ...issueList(storage, "pending_thumbnail_repairs")
  ];
  const incompleteListings = issueList(storage, "incomplete_listings");
  const unavailableBackends = issueList(storage, "unavailable_backends");
  const blockedNamespaces = new Set(
    incompleteListings.map(issueNamespace).filter(Boolean)
  );
  for (const issue of unavailableBackends) {
    if (issue.blocks_maintenance === true) {
      const namespace = issueNamespace(issue);
      if (namespace) blockedNamespaces.add(namespace);
    }
  }
  const unavailableSlugs = new Set(
    unavailableBackends
      .filter((issue) => issue.blocks_maintenance === false)
      .map((issue) => issueText(issue, "backend"))
      .filter(Boolean)
  );
  const groupBlocked = (issue: StorageIssue) => (
    blockedNamespaces.has(issueNamespace(issue))
  );
  const repairBlocked = (issue: StorageIssue) => (
    groupBlocked(issue) || unavailableSlugs.has(issueText(issue, "backend"))
  );
  const repairableThumbnails = repairCandidates.filter((issue) => (
    !missingObjectIds.has(issueId(issue))
    && !repairBlocked(issue)
  )).length;
  const orphanIssues = [
    ...issueList(storage, "orphan_objects"),
    ...issueList(storage, "orphan_thumbs"),
    ...issueList(storage, "orphan_staging_files")
  ];
  const removableObjects = orphanIssues.filter((issue) => !groupBlocked(issue)).length;
  const blockedItems = [
    ...missingObjects,
    ...repairCandidates,
    ...orphanIssues
  ].filter((issue) => groupBlocked(issue)).length + repairCandidates.filter((issue) => (
    !missingObjectIds.has(issueId(issue))
    && !groupBlocked(issue)
    && unavailableSlugs.has(issueText(issue, "backend"))
  )).length;
  const protectedUploads = issueList(storage, "active_staging_files").length
    + issueList(storage, "retained_staging_files").length;

  return {
    repairable_thumbnails: repairableThumbnails,
    missing_originals: missingObjects.length,
    removable_objects: removableObjects,
    protected_uploads: protectedUploads,
    blocked_namespaces: blockedNamespaces.size,
    unavailable_logical_backends: unavailableSlugs.size,
    blocked_items: blockedItems,
    preview_items:
      repairableThumbnails
      + missingObjects.length
      + removableObjects
  };
}
