/**
 * Reuses one dynamic-module request for the lifetime of the current page.
 *
 * The rejected promise is intentionally retained. Vite remembers attempted
 * CSS preloads in the same document, so retrying only the JavaScript import
 * could otherwise open a capability without its styles. Callers must offer a
 * full-page reload after a load failure.
 */
export function createPageLifetimeModuleLoader<T>(
  importModule: () => Promise<T>
) {
  let modulePromise: Promise<T> | undefined;
  return () => {
    modulePromise ??= importModule();
    return modulePromise;
  };
}
