import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState
} from "react";
import {
  createActionFeedback,
  type ActionFeedbackState
} from "../lib/ui/action-feedback.js";
import { waitForMinimumPendingDuration } from "../lib/ui/async-action-timing.js";
import {
  reorderItemByDirection,
  reorderItemByKey,
  reorderPositionByKey,
  type ReorderDirection
} from "../lib/ui/reorder.js";
import { useReorderControlFocus } from "./useReorderControlFocus.js";

type PersistedReorderErrorStage = "save" | "refresh";

type PersistedReorderFocusOptions<Item> = {
  itemKeys?: (items: readonly Item[]) => string[];
  page?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
};

const noFixedItems = () => false;

/**
 * Owns optimistic keyboard/pointer sorting through the authoritative reread.
 * Consumers provide persistence and cache access, but do not duplicate the
 * drag state, save lock, rollback, feedback, or focus lifecycle.
 */
export function usePersistedReorder<Item>({
  items,
  externalBusy,
  getKey,
  isFixed = noFixedItems,
  itemLabel,
  save,
  refresh,
  readAuthoritative,
  reportError,
  minimumPendingMs = 0,
  focus
}: {
  items: readonly Item[] | undefined;
  externalBusy: boolean;
  getKey: (item: Item) => string;
  isFixed?: (item: Item) => boolean;
  itemLabel: (items: readonly Item[], key: string) => string;
  save: (movableKeys: string[]) => Promise<unknown>;
  refresh: () => Promise<unknown>;
  readAuthoritative: () => readonly Item[] | null | undefined;
  reportError: (stage: PersistedReorderErrorStage, error: unknown) => void;
  minimumPendingMs?: number;
  focus?: PersistedReorderFocusOptions<Item>;
}) {
  const [order, setOrder] = useState<Item[]>(() => [...(items ?? [])]);
  const [reordering, setReordering] = useState(false);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [feedback, setFeedback] = useState<ActionFeedbackState | null>(null);
  const orderRef = useRef(order);
  const dragKeyRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const replaceOrder = useCallback((next: readonly Item[]) => {
    const copied = [...next];
    orderRef.current = copied;
    if (mountedRef.current) setOrder(copied);
  }, []);

  useEffect(() => {
    if (runningRef.current || dragKeyRef.current) return;
    replaceOrder(items ?? []);
  }, [items, replaceOrder]);

  const focusItemKeys = focus?.itemKeys
    ? focus.itemKeys(order)
    : order.map(getKey);
  const {
    registerReorderControl,
    requestReorderFocus
  } = useReorderControlFocus({
    itemSlugs: focusItemKeys,
    page: focus?.page,
    pageSize: focus?.pageSize,
    onPageChange: focus?.onPageChange
  });

  const showFeedback = useCallback((
    text: string,
    status: "pending" | "success" | "error"
  ) => {
    if (!mountedRef.current) return;
    setFeedback(createActionFeedback(text, status));
    setAnnouncement(text);
  }, []);

  const positionText = useCallback((
    nextOrder: readonly Item[],
    movedKey: string
  ) => {
    const position = reorderPositionByKey(
      [...nextOrder],
      movedKey,
      getKey,
      isFixed
    );
    return position
      ? `可排序项第 ${position.position} / ${position.total} 位`
      : "当前位置不可用";
  }, [getKey, isFixed]);

  const persistOrder = useCallback(async ({
    nextOrder,
    previousOrder,
    movedKey,
    focusDirection
  }: {
    nextOrder: Item[];
    previousOrder: Item[];
    movedKey: string;
    focusDirection: ReorderDirection | null;
  }) => {
    if (runningRef.current || externalBusy) return;

    runningRef.current = true;
    setReordering(true);
    replaceOrder(nextOrder);
    if (focusDirection) requestReorderFocus(movedKey, focusDirection);
    showFeedback("正在保存排序...", "pending");
    const startedAt = Date.now();

    try {
      let saveSucceeded = false;
      try {
        await save(
          nextOrder.filter((item) => !isFixed(item)).map(getKey)
        );
        saveSucceeded = true;
      } catch (error) {
        reportError("save", error);
      }

      try {
        await refresh();
      } catch (error) {
        reportError("refresh", error);
      }
      if (minimumPendingMs > 0) {
        await waitForMinimumPendingDuration(startedAt, minimumPendingMs);
      }

      const refreshedOrder = readAuthoritative();
      const authoritativeOrder = refreshedOrder
        ? [...refreshedOrder]
        : saveSucceeded
          ? nextOrder
          : previousOrder;
      replaceOrder(authoritativeOrder);
      if (focusDirection) requestReorderFocus(movedKey, focusDirection);

      const position = positionText(authoritativeOrder, movedKey);
      const label = itemLabel(authoritativeOrder, movedKey);
      showFeedback(
        saveSucceeded
          ? `${label}排序已保存，当前为${position}`
          : refreshedOrder
            ? `${label}排序保存失败，已按服务器顺序恢复到${position}`
            : `${label}排序保存失败，已恢复到上次已知的${position}`,
        saveSucceeded ? "success" : "error"
      );
    } finally {
      runningRef.current = false;
      if (mountedRef.current) setReordering(false);
    }
  }, [
    externalBusy,
    getKey,
    isFixed,
    itemLabel,
    minimumPendingMs,
    positionText,
    readAuthoritative,
    refresh,
    replaceOrder,
    reportError,
    requestReorderFocus,
    save,
    showFeedback
  ]);

  const moveByKeyboard = useCallback((
    movedKey: string,
    direction: ReorderDirection
  ) => {
    if (externalBusy || runningRef.current || dragKeyRef.current) return;
    const previousOrder = orderRef.current;
    const result = reorderItemByDirection(
      previousOrder,
      movedKey,
      direction,
      getKey,
      isFixed
    );
    if (!result.moved) return;
    void persistOrder({
      nextOrder: result.items,
      previousOrder,
      movedKey,
      focusDirection: direction
    });
  }, [externalBusy, getKey, isFixed, persistOrder]);

  const beginDrag = useCallback((movedKey: string) => {
    if (externalBusy || runningRef.current) return;
    const item = orderRef.current.find((candidate) => (
      getKey(candidate) === movedKey
    ));
    if (!item || isFixed(item)) return;
    dragKeyRef.current = movedKey;
    setDraggingKey(movedKey);
  }, [externalBusy, getKey, isFixed]);

  // Keep the native drag source in place until a drop chooses the target.
  // Moving its ancestor during dragenter can interrupt the browser's drag
  // lifecycle; child dragenter events also cause repeated order reversals.
  const finishDrag = useCallback((targetKey?: string) => {
    const movedKey = dragKeyRef.current;
    dragKeyRef.current = null;
    if (!movedKey) return;
    setDraggingKey(null);
    const previousOrder = [...(readAuthoritative() ?? orderRef.current)];
    if (!targetKey || externalBusy || runningRef.current) {
      if (!runningRef.current) replaceOrder(previousOrder);
      return;
    }
    const result = reorderItemByKey(
      previousOrder,
      movedKey,
      targetKey,
      getKey,
      isFixed
    );
    if (!result.moved) {
      replaceOrder(previousOrder);
      return;
    }
    void persistOrder({
      nextOrder: result.items,
      previousOrder,
      movedKey,
      focusDirection: null
    });
  }, [externalBusy, getKey, isFixed, persistOrder, readAuthoritative, replaceOrder]);

  const cancelDrag = useEffectEvent(() => finishDrag());
  useEffect(() => {
    if (!draggingKey) return;
    const cancel = () => cancelDrag();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    const onVisibility = () => { if (document.hidden) cancel(); };
    // A valid card drop commits in React before this window bubble listener.
    // Outside drops, Escape and lost focus only release the shared drag state.
    window.addEventListener("drop", cancel);
    window.addEventListener("dragend", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("drop", cancel);
      window.removeEventListener("dragend", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [draggingKey]);

  const positionFor = useCallback((key: string) => reorderPositionByKey(
    order,
    key,
    getKey,
    isFixed
  ), [getKey, isFixed, order]);

  return {
    order,
    draggingKey,
    busy: externalBusy || reordering,
    reordering,
    announcement,
    feedback,
    clearFeedback: () => setFeedback(null),
    positionFor,
    moveByKeyboard,
    registerReorderControl,
    beginDrag,
    finishDrag
  };
}
