import { useCallback, useEffect, useRef, useState } from "react";
import { AsyncIntentFence } from "../../../lib/async-intent-fence.js";
import {
  createPageLifetimeModuleLoader
} from "../../../lib/page-lifetime-module-loader.js";
import { IngestionTriggers } from "./IngestionTriggers.js";
import type {
  IngestionActivation,
  IngestionActivationKind
} from "./ingestion-activation.js";
import "../../../styles/admin/ingestion-triggers.css";

type IngestionModule = typeof import("./Ingestion.js");
type ImportSourceDialogModule =
  typeof import("./import/ImportSourceDialog.js");

const loadIngestionModule = createPageLifetimeModuleLoader<IngestionModule>(
  () => import("./Ingestion.js")
);
const loadImportSourceModule =
  createPageLifetimeModuleLoader<ImportSourceDialogModule>(
    () => import("./import/ImportSourceDialog.js")
  );

export function IngestionLauncher({
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
  const [IngestionComponent, setIngestionComponent] =
    useState<IngestionModule["Ingestion"] | null>(null);
  const [activation, setActivation] = useState<IngestionActivation | null>(null);
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

  const preloadIngestion = () => {
    void loadIngestionModule().catch(() => undefined);
  };
  const preloadImportSource = () => {
    void loadImportSourceModule().catch(() => undefined);
  };
  const activate = async (
    kind: IngestionActivationKind,
    opener: HTMLButtonElement
  ) => {
    if (pendingRef.current || disabled) return;
    const launchFence = launchFenceRef.current;
    const launchSequence = launchFence.begin();
    updatePending(true);
    let dispatched = false;
    try {
      const needsImportSource = kind === "urls"
        || kind === "jsonl"
        || kind === "weibo";
      const ingestionModule = needsImportSource
        ? (await Promise.all([
            loadIngestionModule(),
            loadImportSourceModule()
          ]))[0]
        : await loadIngestionModule();
      if (
        !launchFence.isCurrent(launchSequence)
        || !showTriggersRef.current
      ) {
        return;
      }
      setIngestionComponent(() => ingestionModule.Ingestion);
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
        <IngestionTriggers
          pending={pending || disabled}
          onPreloadWorkflow={preloadIngestion}
          onPreloadImportSource={preloadImportSource}
          onOpenWorkflow={(opener) => void activate("workflow", opener)}
          onOpenUrls={(opener) => void activate("urls", opener)}
          onOpenJsonl={(opener) => void activate("jsonl", opener)}
          onOpenWeibo={(opener) => void activate("weibo", opener)}
          onOpenFiles={(opener) => void activate("files", opener)}
        />
      )}
      {IngestionComponent && (
        <IngestionComponent
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
