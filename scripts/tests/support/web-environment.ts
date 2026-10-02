import { parseHTML } from "linkedom";

const environmentKey = Symbol.for("imageshow.tests.web-environment");
const environmentState = globalThis as typeof globalThis & {
  [environmentKey]?: true;
};

if (!environmentState[environmentKey]) {
  const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (media: string) => ({
      media,
      matches: false,
      onchange: null,
      addEventListener() {},
      removeEventListener() {}
    })
  });
  // linkedom ignores AddEventListenerOptions.signal. Model its cancellation
  // on the shared prototype so every test document retires scoped listeners.
  const eventTargetPrototype = window.EventTarget.prototype;
  const originalAdd = eventTargetPrototype.addEventListener;
  const originalRemove = eventTargetPrototype.removeEventListener;
  const abortCleanups = new WeakMap<
    EventTarget,
    Map<string, Map<EventListenerOrEventListenerObject, () => void>>
  >();
  eventTargetPrototype.addEventListener = function (type, listener, options) {
    const signal = typeof options === "object" ? options?.signal : undefined;
    if (signal?.aborted || !listener) return;
    originalAdd.call(this, type, listener, options);
    if (!signal) return;
    let events = abortCleanups.get(this);
    if (!events) abortCleanups.set(this, (events = new Map()));
    let listeners = events.get(type);
    if (!listeners) events.set(type, (listeners = new Map()));
    if (listeners.has(listener)) return;
    const abort = () => this.removeEventListener(type, listener, options);
    listeners.set(listener, () => {
      signal.removeEventListener("abort", abort);
      listeners.delete(listener);
      if (!listeners.size) events.delete(type);
    });
    signal.addEventListener("abort", abort, { once: true });
  };
  eventTargetPrototype.removeEventListener = function (type, listener, options) {
    if (listener) abortCleanups.get(this)?.get(type)?.get(listener)?.();
    originalRemove.call(this, type, listener, options);
  };
  Object.defineProperty(document, "oninput", {
    configurable: true,
    writable: true,
    value: null
  });
  // Advertise native composition events so React handles the dispatched IME
  // events instead of its legacy key-code based composition fallback.
  Object.defineProperty(window, "CompositionEvent", {
    configurable: true,
    value: window.Event
  });
  Object.defineProperty(window, "getSelection", {
    configurable: true,
    value: () => ({
      anchorNode: null,
      anchorOffset: 0,
      focusNode: null,
      focusOffset: 0
    })
  });
  // React DOM falls back to its legacy text-input watcher when linkedom does
  // not advertise native input events. Keep that public DOM compatibility
  // surface on the shared linkedom prototype so focus can safely move between
  // independently created documents during the unified Web run.
  const elementPrototype = window.HTMLElement.prototype as HTMLElement & {
    attachEvent?: () => void;
    detachEvent?: () => void;
  };
  if (!elementPrototype.attachEvent) elementPrototype.attachEvent = () => {};
  if (!elementPrototype.detachEvent) elementPrototype.detachEvent = () => {};
  // Production code uses these browser baseline APIs directly. linkedom lacks
  // them, so every test document shares minimal versions on its prototypes:
  // no web fonts are pending, nothing is selected or animating, loaded images
  // decode at once and pointer capture only records its own state.
  const documentPrototype = Object.getPrototypeOf(document) as Document;
  const loadedFonts = { ready: Promise.resolve() };
  Object.defineProperty(documentPrototype, "fonts", {
    configurable: true,
    get: () => loadedFonts
  });
  Object.defineProperty(documentPrototype, "getSelection", {
    configurable: true,
    writable: true,
    value: () => ({ anchorNode: null, focusNode: null, isCollapsed: true, rangeCount: 0 })
  });
  if (!elementPrototype.getAnimations) elementPrototype.getAnimations = () => [];
  const imagePrototype = window.HTMLImageElement.prototype;
  if (!imagePrototype.decode) imagePrototype.decode = () => Promise.resolve();
  const capturedPointers = new WeakMap<Element, Set<number>>();
  const pointerCapture = (element: Element) => {
    let pointers = capturedPointers.get(element);
    if (!pointers) capturedPointers.set(element, (pointers = new Set()));
    return pointers;
  };
  if (!elementPrototype.setPointerCapture) {
    elementPrototype.setPointerCapture = function (pointerId) {
      pointerCapture(this).add(pointerId);
    };
    elementPrototype.releasePointerCapture = function (pointerId) {
      pointerCapture(this).delete(pointerId);
    };
    elementPrototype.hasPointerCapture = function (pointerId) {
      return pointerCapture(this).has(pointerId);
    };
  }
  // There is no layout or viewport: report every observed fixture as visible,
  // as an on-screen fixture would be, and leave size changes unobserved.
  class FixtureIntersectionObserver {
    readonly root = null;
    readonly rootMargin: string;
    readonly thresholds = [0];
    readonly #callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
      this.#callback = callback;
      this.rootMargin = options.rootMargin ?? "0px";
    }

    observe(target: Element) {
      const bounds = target.getBoundingClientRect();
      this.#callback(
        [{
          target,
          isIntersecting: true,
          intersectionRatio: 1,
          boundingClientRect: bounds,
          intersectionRect: bounds,
          rootBounds: null,
          time: 0
        }],
        this as unknown as IntersectionObserver
      );
    }

    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  // Fixture renderers never create a WebGL2 context.
  class FixtureWebGL2RenderingContext {}
  class FixtureResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // linkedom has no layout engine. Supply the standard visibility query for
  // connected fixtures; geometry-specific cases can override it per element.
  if (!elementPrototype.getClientRects) {
    elementPrototype.getClientRects = function () {
      const rects =
        this.isConnected && !this.closest("[hidden]")
          && this.style.display !== "none"
          ? [this.getBoundingClientRect()]
          : [];
      return Object.assign(rects, {
        item: (index: number) => rects[index] ?? null
      });
    };
  }
  const globals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    IntersectionObserver: FixtureIntersectionObserver,
    ResizeObserver: FixtureResizeObserver,
    WebGL2RenderingContext: FixtureWebGL2RenderingContext,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }
  Object.defineProperty(environmentState, environmentKey, {
    configurable: false,
    value: true
  });
}
