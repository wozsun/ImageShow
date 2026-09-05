import { useMemo, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PublicImageDetailResponseDto } from "@imageshow/shared/browser";
import { api } from "../../lib/api/client.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import { errorMessage } from "../../lib/ui/formatters.js";
import type {
  EditableImageSnapshot,
  GalleryImageCard,
  PublicImageItem
} from "../../lib/types.js";
import { ImageDetailModal } from "./ImageDetailModal.js";

function imagePlaceholder(card: GalleryImageCard): PublicImageItem {
  return {
    ...card,
    description: "",
    object_url: "",
    source: ""
  };
}

export function PublicImageDetail({
  card,
  onClose,
  onTrashCommitted,
  onTrashed,
  onItemUpdated,
  onItemRefreshRequested,
  returnFocusRef,
}: {
  card: GalleryImageCard;
  onClose: () => void;
  onTrashCommitted?: (imageId: string) => void | Promise<void>;
  onTrashed?: (imageId: string) => void;
  onItemUpdated?: (item: EditableImageSnapshot) => void;
  onItemRefreshRequested?: (imageId: string) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const placeholder = useMemo(() => imagePlaceholder(card), [card]);
  const [trashCommitted, setTrashCommitted] = useState(false);
  const { data, isPending, isFetching, isError, error, refetch } =
    useQuery<PublicImageDetailResponseDto>({
      queryKey: [...queryKeys.publicImageDetail, card.id],
      // The tiny metadata request is reusable across StrictMode's simulated
      // remount. Full-image DOM work remains owned and cancelled by the modal.
      queryFn: () => api(`/api/images/${encodeURIComponent(card.id)}`),
      gcTime: 0,
      enabled: !trashCommitted
    });
  const detail = data?.item.id === card.id ? data.item : null;
  const item = useMemo(
    () => ({ ...placeholder, ...(detail ?? {}) }),
    [placeholder, detail]
  );
  const detailLoading = isPending || (isFetching && !detail);
  const detailError = isError && !detail && !isFetching
    ? errorMessage(error)
    : "";

  return (
    <ImageDetailModal
      item={item}
      onClose={onClose}
      onTrashCommitted={async (imageId) => {
        if (imageId !== card.id) return;
        setTrashCommitted(true);
        await onTrashCommitted?.(imageId);
      }}
      onTrashed={onTrashed}
      onItemUpdated={onItemUpdated}
      onItemRefreshRequested={onItemRefreshRequested}
      admin={false}
      detailLoading={detailLoading}
      detailError={detailError}
      onDetailRetry={() => void refetch()}
      returnFocusRef={returnFocusRef}
    />
  );
}
