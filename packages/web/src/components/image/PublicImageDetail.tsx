import { useMemo, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type PublicImageDetailResponseDto,
  type PublicImageView,
  type ShowImageCardDto,
  imageDevice,
  type EditableImageSnapshotDto,
  type GalleryImageCardDto
} from "@imageshow/shared/browser";
import { api } from "../../lib/api/client.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import {
  completePublicDetailValidation,
  publicDetailValidation
} from "../../lib/api/image-data-revision.js";
import { errorMessage } from "../../lib/ui/formatters.js";
import type { PublicImageItem } from "../../lib/gallery/public-image.js";
import { ImageDetailModal } from "./ImageDetailModal.js";
import { useOptionalAuthSessionQuery } from "../../hooks/useAuthSession.js";

function imagePlaceholder(card: ShowImageCardDto | GalleryImageCardDto): PublicImageItem {
  return {
    brightness: "light",
    theme: null,
    author: null,
    tags: [],
    image_time: "",
    ...card,
    device: imageDevice(card.width, card.height),
    description: "",
    original_url: null,
    source: null
  };
}

export function PublicImageDetail({
  card,
  view,
  onClose,
  onTrashCommitted,
  onTrashed,
  onItemUpdated,
  onItemRefreshRequested,
  returnFocusRef
}: {
  onClose: () => void;
  onTrashCommitted?: (imageId: string) => void | Promise<void>;
  onTrashed?: (imageId: string) => void;
  onItemUpdated?: (item: EditableImageSnapshotDto) => void;
  onItemRefreshRequested?: (imageId: string) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
} & ({ view: "show"; card: ShowImageCardDto } | { view: "gallery"; card: GalleryImageCardDto })) {
  const placeholder = useMemo(() => imagePlaceholder(card), [card]);
  const [trashCommitted, setTrashCommitted] = useState(false);
  const authQuery = useOptionalAuthSessionQuery();
  const authIdentity = authQuery?.data?.authenticated
    ? authQuery.data.username
    : null;
  const { data, isPending, isFetching, isError, error, refetch } =
    useQuery<PublicImageDetailResponseDto<PublicImageView>>({
      queryKey: [...queryKeys.publicImageDetail, card.id, authIdentity, view],
      // The tiny metadata request is reusable across StrictMode's simulated
      // remount. Full-image DOM work remains owned and cancelled by the modal.
      queryFn: async ({ queryKey, client }) => {
        const validation = publicDetailValidation(client, card.id);
        const response = await api<PublicImageDetailResponseDto<PublicImageView>>(
          `/api/images/${encodeURIComponent(card.id)}?view=${view}`,
          {
            credentials: authIdentity ? "same-origin" : "omit",
            ...(validation || client.getQueryState(queryKey)?.isInvalidated
              ? { cache: "no-cache" as const }
              : {})
          }
        );
        if (validation) completePublicDetailValidation(client, card.id, validation);
        return response;
      },
      gcTime: 0,
      enabled: !trashCommitted && !(authQuery?.isPending && authQuery.isFetching)
    });
  const detail = data?.item ?? null;
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
