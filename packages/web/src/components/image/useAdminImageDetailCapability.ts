import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import {
  loadImageAdminDetailsModule
} from "./image-admin-details-loader.js";
import { AsyncIntentFence } from "../../lib/async-intent-fence.js";
import {
  createPageLifetimeModuleLoader
} from "../../lib/page-lifetime-module-loader.js";
import type {
  AdminImageDetailItem,
  AdminImageListItem
} from "../../lib/types.js";

type ImageDetailModalModule =
  typeof import("./ImageDetailModal.js");
type ImageDetailModalComponent = ImageDetailModalModule["ImageDetailModal"];
type AdminDetailItem = AdminImageDetailItem | AdminImageListItem;

const loadImageDetailModalModule =
  createPageLifetimeModuleLoader<ImageDetailModalModule>(
    () => import("./ImageDetailModal.js")
  );

function loadAdminImageDetailCapability() {
  return Promise.all([
    loadImageDetailModalModule(),
    loadImageAdminDetailsModule()
  ]).then(([modalModule]) => modalModule);
}

export function useAdminImageDetailCapability<T extends AdminDetailItem>(
  onLoadError: (error: unknown) => void
) {
  const [item, setItem] = useState<T | null>(null);
  const [Modal, setModal] = useState<ImageDetailModalComponent | null>(null);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const requestFenceRef = useRef(new AsyncIntentFence());
  const onLoadErrorRef = useRef(onLoadError);
  onLoadErrorRef.current = onLoadError;

  useEffect(() => {
    const requestFence = requestFenceRef.current;
    requestFence.mount();
    return () => requestFence.unmount();
  }, []);

  const preload = useCallback(() => {
    void loadAdminImageDetailCapability().catch(() => undefined);
  }, []);

  const open = useCallback(async (nextItem: T, opener: HTMLElement) => {
    const requestFence = requestFenceRef.current;
    const requestSequence = requestFence.begin();
    setPendingItemId(nextItem.id);
    try {
      const module = await loadAdminImageDetailCapability();
      if (
        !requestFence.isCurrent(requestSequence)
        || !opener.isConnected
      ) {
        return;
      }
      returnFocusRef.current = opener;
      setModal(() => module.ImageDetailModal);
      setItem(nextItem);
    } catch (error) {
      if (requestFence.isCurrent(requestSequence)) {
        onLoadErrorRef.current(error);
      }
    } finally {
      if (requestFence.isCurrent(requestSequence)) {
        setPendingItemId(null);
      }
    }
  }, []);

  const close = useCallback(() => setItem(null), []);

  return {
    Modal,
    close,
    item,
    open,
    pendingItemId,
    preload,
    returnFocusRef
  };
}
