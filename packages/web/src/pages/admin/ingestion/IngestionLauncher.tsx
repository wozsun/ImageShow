import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { AsyncIntentFence } from "../../../lib/async-intent-fence.js";
import {
  createPageLifetimeModuleLoader
} from "../../../lib/page-lifetime-module-loader.js";
import { usePageScrollLock } from "../../../hooks/usePageScrollLock.js";
import { IngestionTriggers } from "./IngestionTriggers.js";
import type {
  IngestionActivation,
  IngestionActivationKind
} from "./ingestion-activation.js";
import "../../../styles/admin/ingestion-triggers.css";

type IngestionModule = typeof import("./Ingestion.js");
type ImportSourceDialogModule =
  typeof import("./import/ImportSourceDialog.js");

type IngestionLauncherModuleLoaders = Readonly<{
  ingestion: () => Promise<IngestionModule>;
  importSource: () => Promise<ImportSourceDialogModule>;
}>;

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
  moduleLoaders
}: {
  showTriggers: boolean;
  disabled: boolean;
  onDone: () => void;
  onLoadError: (error: unknown) => void;
  moduleLoaders?: IngestionLauncherModuleLoaders;
}) {
  const ingestionLoader = moduleLoaders?.ingestion ?? loadIngestionModule;
  const importSourceLoader = moduleLoaders?.importSource
    ?? loadImportSourceModule;
  const [IngestionComponent, setIngestionComponent] =
    useState<IngestionModule["Ingestion"] | null>(null);
  const [activation, setActivation] = useState<IngestionActivation | null>(null);
  const [launchPending, setLaunchPending] = useState(false);
  const activationActiveRef = useRef(false);
  const launchPendingRef = useRef(false);
  const failedLaunchFocusRef = useRef<HTMLButtonElement | null>(null);
  const sequenceRef = useRef(0);
  const activeSequenceRef = useRef(0);
  const launchFenceRef = useRef(new AsyncIntentFence());
  const showTriggersRef = useRef(showTriggers);
  showTriggersRef.current = showTriggers;

  const updateLaunchPending = useCallback((nextPending: boolean) => {
    if (launchPendingRef.current === nextPending) return;
    launchPendingRef.current = nextPending;
    setLaunchPending(nextPending);
  }, []);

  // The lazy-loading interval needs interaction exclusion, not a disabled
  // presentation. Reuse the page-root lock so buttons keep their normal
  // appearance while pointer, keyboard, focus and scrolling are fenced. The
  // mounted DialogFrame takes a second lease before this one is released.
  usePageScrollLock(launchPending);

  useLayoutEffect(() => {
    if (launchPending) return;
    const target = failedLaunchFocusRef.current;
    failedLaunchFocusRef.current = null;
    if (
      target?.isConnected
      && !target.disabled
      && !target.closest("[inert]")
    ) target.focus();
  }, [launchPending]);

  useEffect(() => {
    const launchFence = launchFenceRef.current;
    launchFence.mount();
    return () => launchFence.unmount();
  }, []);

  useEffect(() => {
    if (showTriggers) return;
    launchFenceRef.current.invalidate();
    activationActiveRef.current = false;
    setActivation(null);
    updateLaunchPending(false);
  }, [showTriggers, updateLaunchPending]);

  const preloadIngestion = () => {
    void ingestionLoader().catch(() => undefined);
  };
  const preloadImportSource = () => {
    void importSourceLoader().catch(() => undefined);
  };
  const activate = async (
    kind: IngestionActivationKind,
    opener: HTMLButtonElement
  ) => {
    if (activationActiveRef.current || disabled) return;
    const launchFence = launchFenceRef.current;
    const launchSequence = launchFence.begin();
    activationActiveRef.current = true;
    failedLaunchFocusRef.current = null;
    updateLaunchPending(true);
    let dispatched = false;
    try {
      const needsImportSource = kind === "urls"
        || kind === "jsonl"
        || kind === "weibo";
      const ingestionModule = needsImportSource
        ? (await Promise.all([
            ingestionLoader(),
            importSourceLoader()
          ]))[0]
        : await ingestionLoader();
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
        activationActiveRef.current = false;
        failedLaunchFocusRef.current = opener;
        updateLaunchPending(false);
      }
    }
  };
  const markActivationOpened = useCallback((sequence: number) => {
    if (
      launchFenceRef.current.isMounted()
      && activeSequenceRef.current === sequence
      && activationActiveRef.current
    ) {
      // DialogFrame has mounted and made the page root inert. From this point
      // the modal boundary owns interaction, so release the launcher's counted
      // root-lock lease without exposing an interactive frame.
      updateLaunchPending(false);
    }
  }, [updateLaunchPending]);
  const settleActivation = useCallback((sequence: number) => {
    if (
      launchFenceRef.current.isMounted()
      && activeSequenceRef.current === sequence
    ) {
      launchFenceRef.current.invalidate();
      activationActiveRef.current = false;
      setActivation((current) => (
        current?.sequence === sequence ? null : current
      ));
      updateLaunchPending(false);
    }
  }, [updateLaunchPending]);

  return (
    <>
      {showTriggers && (
        <IngestionTriggers
          pending={disabled}
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
          loadImportSourceModule={importSourceLoader}
          onActivationOpened={markActivationOpened}
          onActivationSettled={settleActivation}
          onDone={onDone}
          onLoadError={onLoadError}
        />
      )}
    </>
  );
}
