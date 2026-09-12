import { parseHTML } from "linkedom";

const environmentKey = Symbol.for("imageshow.tests.web-environment");
const environmentState = globalThis as typeof globalThis & {
  [environmentKey]?: true;
};

if (!environmentState[environmentKey]) {
  const { window, document } = parseHTML(
    "<!doctype html><html><body></body></html>"
  );
  // linkedom ignores AddEventListenerOptions.signal. Model its cancellation
  // on the shared prototype so every test document retires scoped listeners.
  const eventTargetPrototype = window.EventTarget.prototype;
  const originalAdd = eventTargetPrototype.addEventListener;
  const originalRemove = eventTargetPrototype.removeEventListener;
  const abortCleanups = new WeakMap<EventTarget, Map<string, Map<EventListenerOrEventListenerObject, () => void>>>();
  eventTargetPrototype.addEventListener = function (type, listener, options) {
    const signal = typeof options === "object" ? options?.signal : undefined;
    if (signal?.aborted || !listener) return;
    originalAdd.call(this, type, listener, options);
    if (!signal) return;
    let events = abortCleanups.get(this);
    if (!events) abortCleanups.set(this, events = new Map());
    let listeners = events.get(type);
    if (!listeners) events.set(type, listeners = new Map());
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
  // linkedom has no layout engine. Supply the standard visibility query for
  // connected fixtures; geometry-specific cases can override it per element.
  if (!elementPrototype.getClientRects) {
    elementPrototype.getClientRects = function () {
      const rects = this.isConnected && !this.closest("[hidden]")
        && this.style.display !== "none" ? [this.getBoundingClientRect()] : [];
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
