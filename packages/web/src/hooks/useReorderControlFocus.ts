import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import {
  reorderPageForKey,
  type ReorderDirection
} from "../lib/ui/reorder.js";
import { ReorderControlRegistry } from "../lib/ui/reorder-focus.js";

type PendingReorderFocus = {
  slug: string;
  direction: ReorderDirection;
};

/**
 * Restores focus to a moved item's sorting control. Targets are registered
 * only by stable slug; page changes happen synchronously through React state.
 */
export function useReorderControlFocus({
  itemSlugs,
  page = 1,
  pageSize,
  onPageChange
}: {
  itemSlugs: string[];
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
}) {
  const registryRef = useRef<ReorderControlRegistry | null>(null);
  if (!registryRef.current) {
    registryRef.current = new ReorderControlRegistry();
  }
  const [pending, setPending] = useState<PendingReorderFocus | null>(null);

  const registerControl = useCallback((
    slug: string,
    direction: ReorderDirection,
    node: HTMLButtonElement | null
  ) => {
    registryRef.current?.register(slug, direction, node);
  }, []);

  const requestFocus = useCallback((
    slug: string,
    direction: ReorderDirection
  ) => {
    setPending({ slug, direction });
  }, []);

  useLayoutEffect(() => {
    if (!pending) return;
    const targetPage = reorderPageForKey(
      itemSlugs,
      pending.slug,
      pageSize
    );
    if (targetPage === null) {
      setPending(null);
      return;
    }

    if (targetPage !== page && onPageChange) {
      onPageChange(targetPage);
      return;
    }

    if (!registryRef.current?.focus(
      pending.slug,
      pending.direction
    )) return;
    setPending(null);
  }, [itemSlugs, onPageChange, page, pageSize, pending]);

  return {
    registerReorderControl: registerControl,
    requestReorderFocus: requestFocus
  };
}
