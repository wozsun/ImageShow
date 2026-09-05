import type {
  FocusEvent,
  MouseEvent,
  PointerEvent
} from "react";
import {
  createElement,
  createContext,
  useContext,
  type ReactNode
} from "react";

/**
 * Reuses a public route request while it is pending or fulfilled, and records
 * failed passive imports so normal navigation can obtain a fresh module map.
 */
export function createPublicRouteModuleLoader<T>(
  importModule: () => Promise<T>
) {
  let loadedModule: T | undefined;
  let pending: { passive: boolean; promise: Promise<T> } | undefined;
  let passivePreloadFailed = false;

  const start = (passive: boolean) => {
    if (loadedModule !== undefined) return Promise.resolve(loadedModule);
    if (pending) return pending.promise;
    const nextPromise = importModule()
      .then((module) => {
        loadedModule = module;
        passivePreloadFailed = false;
        if (pending?.promise === nextPromise) pending = undefined;
        return module;
      })
      .catch((error: unknown) => {
        if (passive) passivePreloadFailed = true;
        if (pending?.promise === nextPromise) pending = undefined;
        throw error;
      });
    pending = { passive, promise: nextPromise };
    return nextPromise;
  };

  return {
    load: () => {
      if (passivePreloadFailed && typeof window !== "undefined") {
        // A native module import failure is cached for the whole document, so
        // retrying the same specifier from React.lazy cannot recover it. Keep
        // the recovery at the loader boundary as well as on intent links:
        // programmatic and otherwise unbound SPA entries then receive the same
        // fresh document module map after the router commits their target URL.
        window.location.reload();
        return new Promise<T>(() => undefined);
      }
      if (!pending?.passive) return start(false);
      return pending.promise.catch(() => {
        if (typeof window !== "undefined") {
          // Native module maps retain a failed import for this document. The
          // router has already committed the target URL, so a single reload
          // gives normal navigation a fresh module map without looping.
          window.location.reload();
          return new Promise<T>(() => undefined);
        }
        return start(false);
      });
    },
    preload: () => {
      void start(true).catch(() => undefined);
    },
    passivePreloadFailed: () => passivePreloadFailed
  };
}

function routePreloadIntentProps(
  loader: ReturnType<typeof createPublicRouteModuleLoader>
) {
  return {
    onPointerEnter: (event: PointerEvent<HTMLAnchorElement>) => {
      if (event.pointerType === "mouse") loader.preload();
    },
    onFocus: (event: FocusEvent<HTMLAnchorElement>) => {
      if (event.currentTarget.matches(":focus-visible")) loader.preload();
    },
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (!loader.passivePreloadFailed()) return;
      if (
        event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
      ) return;
      event.preventDefault();
      window.location.assign(event.currentTarget.href);
    }
  };
}

type PublicRoutePreloadIntentProps = ReturnType<
  typeof routePreloadIntentProps
>;

type PublicRoutePreloadIntents = {
  home: PublicRoutePreloadIntentProps;
  show: PublicRoutePreloadIntentProps;
  gallery: PublicRoutePreloadIntentProps;
};

const PublicRoutePreloadContext = createContext<
  PublicRoutePreloadIntents | null
>(null);

export function createPublicRoutePreloadIntents(
  homeRouteModule: ReturnType<typeof createPublicRouteModuleLoader>,
  showRouteModule: ReturnType<typeof createPublicRouteModuleLoader>,
  galleryRouteModule: ReturnType<typeof createPublicRouteModuleLoader>
): PublicRoutePreloadIntents {
  return {
    home: routePreloadIntentProps(homeRouteModule),
    show: routePreloadIntentProps(showRouteModule),
    gallery: routePreloadIntentProps(galleryRouteModule)
  };
}

export function PublicRoutePreloadProvider({
  children,
  intents
}: {
  children: ReactNode;
  intents: PublicRoutePreloadIntents;
}) {
  return createElement(
    PublicRoutePreloadContext.Provider,
    { value: intents },
    children
  );
}

export function usePublicRoutePreloadIntents() {
  const value = useContext(PublicRoutePreloadContext);
  if (!value) throw new Error("公开路由预加载上下文缺失");
  return value;
}
