import { useCallback, useEffect, useRef, useState } from "react";
import { AsyncIntentFence } from "../../../lib/async-intent-fence.js";
import {
  createPageLifetimeModuleLoader
} from "../../../lib/page-lifetime-module-loader.js";
import { UploaderTriggers } from "./UploaderTriggers.js";
import type {
  UploaderActivation,
  UploaderActivationKind
} from "./uploader-activation.js";
import "../../../styles/admin/upload-triggers.css";

type UploaderModule = typeof import("./Uploader.js");
type ImportSourceDialogModule =
  typeof import("./link-import/ImportSourceDialog.js");

const loadUploaderModule = createPageLifetimeModuleLoader<UploaderModule>(
  () => import("./Uploader.js")
);
const loadImportSourceModule =
  createPageLifetimeModuleLoader<ImportSourceDialogModule>(
    () => import("./link-import/ImportSourceDialog.js")
  );

export function UploaderLauncher({
  showTriggers,
  disabled,
  onDone,
  onLoadError,
  onPendingChange
}: {
  showTriggers: boolean;
  disabled: boolean;
  onDone: () => void;
  onLoadError: (error: unknown) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const [UploaderComponent, setUploaderComponent] =
    useState<UploaderModule["Uploader"] | null>(null);
  const [activation, setActivation] = useState<UploaderActivation | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const sequenceRef = useRef(0);
  const activeSequenceRef = useRef(0);
  const launchFenceRef = useRef(new AsyncIntentFence());
  const showTriggersRef = useRef(showTriggers);
  showTriggersRef.current = showTriggers;

  const updatePending = useCallback((nextPending: boolean) => {
    pendingRef.current = nextPending;
    setPending(nextPending);
    onPendingChange(nextPending);
  }, [onPendingChange]);

  useEffect(() => {
    const launchFence = launchFenceRef.current;
    launchFence.mount();
    return () => launchFence.unmount();
  }, []);

  useEffect(() => {
    if (showTriggers) return;
    launchFenceRef.current.invalidate();
    setActivation(null);
    updatePending(false);
  }, [showTriggers, updatePending]);

  const preloadUploader = () => {
    void loadUploaderModule().catch(() => undefined);
  };
  const preloadImportSource = () => {
    void loadImportSourceModule().catch(() => undefined);
  };
  const activate = async (
    kind: UploaderActivationKind,
    opener: HTMLButtonElement
  ) => {
    if (pendingRef.current || disabled) return;
    const launchFence = launchFenceRef.current;
    const launchSequence = launchFence.begin();
    updatePending(true);
    let dispatched = false;
    try {
      const needsLinkInput = kind === "urls"
        || kind === "jsonl"
        || kind === "weibo";
      const uploaderModule = needsLinkInput
        ? (await Promise.all([
            loadUploaderModule(),
            loadImportSourceModule()
          ]))[0]
        : await loadUploaderModule();
      if (
        !launchFence.isCurrent(launchSequence)
        || !showTriggersRef.current
      ) {
        return;
      }
      setUploaderComponent(() => uploaderModule.Uploader);
      const sequence = ++sequenceRef.current;
      activeSequenceRef.current = sequence;
      setActivation({
        sequence,
        kind,
        opener
      });
      dispatched = true;
    } catch (error) {
      if (
        launchFence.isCurrent(launchSequence)
        && showTriggersRef.current
      ) {
        onLoadError(error);
      }
    } finally {
      if (
        !dispatched
        && launchFence.isCurrent(launchSequence)
      ) {
        updatePending(false);
      }
    }
  };
  const settleActivation = (sequence: number) => {
    if (
      launchFenceRef.current.isMounted()
      && activeSequenceRef.current === sequence
    ) {
      launchFenceRef.current.invalidate();
      setActivation((current) => (
        current?.sequence === sequence ? null : current
      ));
      updatePending(false);
    }
  };

  return (
    <>
      {showTriggers && (
        <UploaderTriggers
          pending={pending || disabled}
          onPreloadWorkflow={preloadUploader}
          onPreloadImportSource={preloadImportSource}
          onOpenWorkflow={(opener) => void activate("workflow", opener)}
          onOpenUrls={(opener) => void activate("urls", opener)}
          onOpenJsonl={(opener) => void activate("jsonl", opener)}
          onOpenWeibo={(opener) => void activate("weibo", opener)}
          onOpenFiles={(opener) => void activate("files", opener)}
        />
      )}
      {UploaderComponent && (
        <UploaderComponent
          activation={activation}
          activationEnabled={showTriggers}
          loadImportSourceModule={loadImportSourceModule}
          onActivationSettled={settleActivation}
          onDone={onDone}
          onLoadError={onLoadError}
        />
      )}
    </>
  );
}
