import {
  useState,
  type Dispatch,
  type SetStateAction
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ImageTrashResponseDto } from "@imageshow/shared/browser";
import { useAsyncActionStatus } from "../../../hooks/useAsyncActionStatus.js";
import { moveImagesToTrash } from "../../../lib/api/image-mutations.js";
import { readEditableImageSnapshots } from "../../../lib/api/image-edit.js";
import {
  invalidateImageData,
  invalidateImageDataAfterTrash
} from "../../../lib/api/query-invalidation.js";
import { reportAdminUiError } from "../../../lib/ui/error-reporting.js";
import type { EditableImageSnapshot } from "../../../lib/types.js";
import type { ImageMetadataSessionState } from "./image-metadata-session.js";
import {
  imageTrashIdsNeedingSnapshot,
  pruneImageMetadataSessionAfterTrash,
  reconcileImageEditorTrash,
  type ImageEditorTrashOutcome
} from "./image-editor-trash.js";

function unresolvedTrashMessage(
  requestedCount: number,
  outcome: ImageEditorTrashOutcome
) {
  if (outcome.editableIds.length) {
    return requestedCount === 1
      ? "图片当前仍可编辑，删除未生效"
      : `${outcome.editableIds.length} 张图片当前仍可编辑，删除未全部生效`;
  }
  return requestedCount === 1
    ? "删除结果无法确认，请稍后重试或刷新页面"
    : `${outcome.unknownIds.length} 张图片的删除结果无法确认，请稍后重试或刷新页面`;
}

export function useImageEditorTrashAction({
  setSession,
  onTrashCommitted,
  publicImageMembershipHandled
}: {
  setSession: Dispatch<SetStateAction<ImageMetadataSessionState>>;
  onTrashCommitted: (imageIds: string[]) => void | Promise<void>;
  publicImageMembershipHandled: boolean;
}) {
  const queryClient = useQueryClient();
  const status = useAsyncActionStatus({ resultDurationMs: null });
  const [errorMessage, setErrorMessage] = useState("");

  const trash = async (imageIds: string[]) => status.run(async () => {
    setErrorMessage("");
    let response: ImageTrashResponseDto | null = null;
    try {
      response = await moveImagesToTrash(imageIds);
    } catch (error) {
      // A lost response cannot prove failure: reconcile every unresolved item
      // from the authoritative editable snapshot before changing local state.
      reportAdminUiError("image_metadata.trash", error, { imageIds });
    }

    const idsNeedingSnapshot = imageTrashIdsNeedingSnapshot(
      imageIds,
      response
    );
    let authoritativeItems: EditableImageSnapshot[] | null = [];
    if (idsNeedingSnapshot.length) {
      try {
        const snapshot = await readEditableImageSnapshots(idsNeedingSnapshot);
        authoritativeItems = snapshot.items;
      } catch (error) {
        authoritativeItems = null;
        reportAdminUiError(
          "image_metadata.trash_snapshot",
          error,
          { imageIds: idsNeedingSnapshot }
        );
      }
    }

    const outcome = reconcileImageEditorTrash(
      imageIds,
      response,
      authoritativeItems
    );
    if (outcome.trashedIds.length) {
      setSession((current) => pruneImageMetadataSessionAfterTrash(
        current,
        outcome.trashedIds
      ));

      // Local membership changes must precede invalidation so an active public
      // detail query is disabled before its now-404 projection is cancelled.
      try {
        await onTrashCommitted(outcome.trashedIds);
      } catch (error) {
        reportAdminUiError(
          "image_metadata.trash_membership",
          error,
          { imageIds: outcome.trashedIds }
        );
      }
      try {
        if (publicImageMembershipHandled) {
          await invalidateImageDataAfterTrash(
            queryClient,
            outcome.trashedIds
          );
        } else {
          await invalidateImageData(queryClient);
        }
      } catch (error) {
        reportAdminUiError(
          "image_metadata.trash_refresh",
          error,
          { imageIds: outcome.trashedIds }
        );
      }
    }

    if (outcome.editableIds.length || outcome.unknownIds.length) {
      setErrorMessage(unresolvedTrashMessage(imageIds.length, outcome));
      return false;
    }
    return true;
  });

  return {
    clearError: () => setErrorMessage(""),
    errorMessage,
    pending: status.pending,
    trash
  };
}
