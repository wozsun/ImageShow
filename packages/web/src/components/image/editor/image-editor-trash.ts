import type { ImageTrashResponseDto } from "@imageshow/shared/browser";
import type { EditableImageSnapshot } from "../../../lib/types.js";
import type { ImageMetadataSessionState } from "./image-metadata-session.js";

export type ImageEditorTrashOutcome = {
  trashedIds: string[];
  editableIds: string[];
  unknownIds: string[];
};

function canonicalImageId(id: string) {
  return id.toLowerCase();
}

function responseTrashedIdSet(response: ImageTrashResponseDto | null) {
  return new Set(
    (response?.results ?? [])
      .filter((result) => result.status === "trashed")
      .map((result) => canonicalImageId(result.id))
  );
}

/**
 * The per-item results are the only success authority. Aggregate counters are
 * presentation data and a missing response leaves every item unresolved.
 */
export function imageTrashIdsNeedingSnapshot(
  requestedIds: string[],
  response: ImageTrashResponseDto | null
) {
  const trashedIdSet = responseTrashedIdSet(response);
  return requestedIds.filter(
    (id) => !trashedIdSet.has(canonicalImageId(id))
  );
}

export function reconcileImageEditorTrash(
  requestedIds: string[],
  response: ImageTrashResponseDto | null,
  authoritativeItems: EditableImageSnapshot[] | null
): ImageEditorTrashOutcome {
  const responseTrashedIds = responseTrashedIdSet(response);
  const editableIdSet = authoritativeItems === null
    ? null
    : new Set(
        authoritativeItems.map((item) => canonicalImageId(item.id))
      );
  const trashedIds: string[] = [];
  const editableIds: string[] = [];
  const unknownIds: string[] = [];

  for (const id of requestedIds) {
    const canonicalId = canonicalImageId(id);
    if (responseTrashedIds.has(canonicalId)) {
      trashedIds.push(id);
    } else if (editableIdSet === null) {
      unknownIds.push(id);
    } else if (editableIdSet.has(canonicalId)) {
      editableIds.push(id);
    } else {
      trashedIds.push(id);
    }
  }
  return { trashedIds, editableIds, unknownIds };
}

export function pruneImageMetadataSessionAfterTrash(
  state: ImageMetadataSessionState,
  trashedIds: string[]
): ImageMetadataSessionState {
  const trashedIdSet = new Set(trashedIds.map(canonicalImageId));
  return {
    ...state,
    activeIds: state.activeIds.filter(
      (id) => !trashedIdSet.has(canonicalImageId(id))
    ),
    baselineItems: state.baselineItems.filter(
      (item) => !trashedIdSet.has(canonicalImageId(item.id))
    ),
    drafts: Object.fromEntries(
      Object.entries(state.drafts).filter(
        ([id]) => !trashedIdSet.has(canonicalImageId(id))
      )
    )
  };
}
