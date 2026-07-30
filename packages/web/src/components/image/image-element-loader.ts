export type ImageElementSource = {
  src: string;
  srcSet?: string;
  sizes?: string;
  loading?: "eager" | "lazy";
};

export type ImageElementLoadResult = {
  decodeAttempted: boolean;
  decoded: boolean;
};

function imageAbortError() {
  const error = new Error("Image load cancelled");
  error.name = "AbortError";
  return error;
}

export function clearImageElement(element: HTMLImageElement) {
  element.onload = null;
  element.onerror = null;
  element.removeAttribute("src");
  element.removeAttribute("srcset");
  element.removeAttribute("sizes");
}

/**
 * Loads and decodes a source on the final DOM image node.
 *
 * Listeners are installed before source attributes. Abort synchronously
 * removes listeners and all request-producing attributes.
 */
export function loadImageElement(
  element: HTMLImageElement,
  source: ImageElementSource,
  signal: AbortSignal
) {
  return new Promise<ImageElementLoadResult>((resolve, reject) => {
    let settled = false;
    let decodeStarted = false;

    const removeListeners = () => {
      element.removeEventListener("load", onLoad);
      element.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      element.onload = null;
      element.onerror = null;
    };
    const finish = (
      outcome: "resolve" | "reject",
      value: ImageElementLoadResult | unknown
    ) => {
      if (settled) return;
      settled = true;
      removeListeners();
      if (outcome === "resolve") {
        resolve(value as ImageElementLoadResult);
      } else {
        reject(value);
      }
    };
    const decodeLoadedImage = () => {
      if (decodeStarted || settled) return;
      decodeStarted = true;
      if (typeof element.decode !== "function") {
        finish("resolve", { decodeAttempted: false, decoded: true });
        return;
      }
      void element.decode().then(
        () => finish("resolve", { decodeAttempted: true, decoded: true }),
        () => {
          if (signal.aborted) {
            finish("reject", signal.reason ?? imageAbortError());
            return;
          }
          // A decode rejection does not necessarily mean the already loaded
          // image is undisplayable. Record the attempt and release the slot.
          finish("resolve", { decodeAttempted: true, decoded: false });
        }
      );
    };
    function onLoad() {
      decodeLoadedImage();
    }
    function onError() {
      clearImageElement(element);
      finish("reject", new Error(`Image failed to load: ${source.src}`));
    }
    function onAbort() {
      removeListeners();
      clearImageElement(element);
      finish("reject", signal.reason ?? imageAbortError());
    }

    clearImageElement(element);
    if (signal.aborted) {
      finish("reject", signal.reason ?? imageAbortError());
      return;
    }
    element.loading = source.loading ?? "eager";
    element.decoding = "async";
    element.referrerPolicy = "no-referrer";
    element.addEventListener("load", onLoad);
    element.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (source.sizes) element.setAttribute("sizes", source.sizes);
    if (source.srcSet) element.setAttribute("srcset", source.srcSet);
    element.setAttribute("src", source.src);

    // Cached resources can already be complete before some DOM shims dispatch
    // a load event. The microtask keeps the listener-first ordering intact.
    queueMicrotask(() => {
      if (
        !settled
        && element.complete
        && element.naturalWidth > 0
      ) {
        decodeLoadedImage();
      }
    });
  });
}
