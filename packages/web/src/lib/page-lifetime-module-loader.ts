import { createElement, use, type ComponentType } from "react";

/**
 * Records a promise's outcome in the fields React's `use()` reads, so a
 * component reading a module that has already loaded renders at once instead
 * of showing its Suspense fallback first.
 */
export function readableBySuspense<T>(promise: Promise<T>) {
  const thenable = promise as Promise<T> & { status?: string; value?: T; reason?: unknown };
  thenable.then(
    (value) => {
      thenable.status = "fulfilled";
      thenable.value = value;
    },
    (reason: unknown) => {
      thenable.status = "rejected";
      thenable.reason = reason;
    }
  );
  return promise;
}

/** An already loaded module in the same form, read without suspending. */
export function fulfilledForSuspense<T>(value: T) {
  return Object.assign(Promise.resolve(value), { status: "fulfilled", value });
}

/**
 * Renders a component exported by a lazily loaded module. The module is read
 * with `use()`, so one loaded before the first render shows at once, without
 * the loading screen and React's delayed reveal; until then the nearest
 * Suspense boundary shows. `loadModule` returns the same promise every call.
 */
export function moduleComponent<M, P extends object>(
  loadModule: () => Promise<M>,
  pick: (module: M) => ComponentType<P>
) {
  return function ModuleComponent(props: P) {
    return createElement(pick(use(loadModule())), props);
  };
}

/**
 * Reuses one dynamic-module request for the lifetime of the current page.
 *
 * The rejected promise is intentionally retained. Vite remembers attempted
 * CSS preloads in the same document, so retrying only the JavaScript import
 * could otherwise open a capability without its styles. Callers must offer a
 * full-page reload after a load failure.
 */
export function createPageLifetimeModuleLoader<T>(importModule: () => Promise<T>) {
  let modulePromise: Promise<T> | undefined;
  return () => {
    modulePromise ??= readableBySuspense(importModule());
    return modulePromise;
  };
}
