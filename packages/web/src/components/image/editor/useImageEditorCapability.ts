import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  imageEditorTargetKey,
  loadImageEditorCapabilityModule,
  type ImageEditorCapabilityModule,
  type ImageEditorTarget
} from "./image-editor-capability-loader.js";
import { AsyncIntentFence } from "../../../lib/async-intent-fence.js";
import type {
  BatchEditableImageSnapshot
} from "../../../lib/types.js";
import type { ImportVocabularyDto } from "@imageshow/shared/browser";

type PreparedImageEditor = {
  key: string;
  kind: ImageEditorTarget["kind"];
  itemIds: string[];
  module: ImageEditorCapabilityModule;
  items: BatchEditableImageSnapshot[];
  vocabulary: ImportVocabularyDto;
};

type PendingImageEditor = Pick<
  PreparedImageEditor,
  "key" | "kind" | "itemIds"
>;

type Preparation = {
  createdAt: number;
  key: string;
  promise: Promise<PreparedImageEditor>;
  settled: boolean;
};

const editorPreparationReuseMs = 30_000;

export function useImageEditorCapability({
  onPreparationError,
  onOpenError
}: {
  onPreparationError?: (error: unknown) => void;
  onOpenError?: (error: unknown) => void;
} = {}) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<PreparedImageEditor | null>(null);
  const [pending, setPending] = useState<PendingImageEditor | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const preparationRef = useRef<Preparation | null>(null);
  const requestFenceRef = useRef(new AsyncIntentFence());
  const onPreparationErrorRef = useRef(onPreparationError);
  const onOpenErrorRef = useRef(onOpenError);
  onPreparationErrorRef.current = onPreparationError;
  onOpenErrorRef.current = onOpenError;

  useEffect(() => {
    const requestFence = requestFenceRef.current;
    requestFence.mount();
    return () => requestFence.unmount();
  }, []);

  const prepare = useCallback((target: ImageEditorTarget) => {
    const key = imageEditorTargetKey(target);
    if (
      preparationRef.current?.key === key
      && (
        !preparationRef.current.settled
        || Date.now() - preparationRef.current.createdAt
          < editorPreparationReuseMs
      )
    ) {
      return preparationRef.current.promise;
    }

    const itemIds = target.sources.map((item) => item.id);
    const promise = loadImageEditorCapabilityModule()
      .then(async (module) => ({
        key,
        kind: target.kind,
        itemIds,
        module,
        ...await module.prepareImageEditor(queryClient, target.sources)
      }));
    const preparation = {
      createdAt: Date.now(),
      key,
      promise,
      settled: false
    };
    preparationRef.current = preparation;
    void promise.then(
      () => { preparation.settled = true; },
      () => { preparation.settled = true; }
    );
    void promise.catch((error: unknown) => {
      if (preparationRef.current === preparation) {
        preparationRef.current = null;
      }
      if (requestFenceRef.current.isMounted()) {
        onPreparationErrorRef.current?.(error);
      }
    });
    return promise;
  }, [queryClient]);

  const preload = useCallback((target: ImageEditorTarget) => {
    void prepare(target).catch(() => undefined);
  }, [prepare]);

  const open = useCallback(async (
    target: ImageEditorTarget,
    opener: HTMLElement
  ) => {
    const requestFence = requestFenceRef.current;
    const requestSequence = requestFence.begin();
    const nextPending = {
      key: imageEditorTargetKey(target),
      kind: target.kind,
      itemIds: target.sources.map((item) => item.id)
    };
    setPending(nextPending);

    try {
      const prepared = await prepare(target);
      if (
        !requestFence.isCurrent(requestSequence)
        || !opener.isConnected
      ) {
        return;
      }
      returnFocusRef.current = opener;
      setSession(prepared);
    } catch (error) {
      if (requestFence.isCurrent(requestSequence)) {
        onOpenErrorRef.current?.(error);
      }
    } finally {
      if (requestFence.isCurrent(requestSequence)) {
        setPending(null);
      }
    }
  }, [prepare]);

  const reset = useCallback(() => {
    requestFenceRef.current.invalidate();
    preparationRef.current = null;
    setPending(null);
    setSession(null);
  }, []);

  const close = useCallback(() => {
    preparationRef.current = null;
    setSession(null);
  }, []);

  const updateItems = useCallback((items: BatchEditableImageSnapshot[]) => {
    preparationRef.current = null;
    setSession((current) => current ? { ...current, items } : current);
  }, []);

  return {
    close,
    open,
    pending,
    preload,
    reset,
    returnFocusRef,
    session,
    updateItems
  };
}
