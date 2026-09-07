import { parseHTML } from "linkedom";

const environmentKey = Symbol.for("imageshow.tests.web-environment");
const environmentState = globalThis as typeof globalThis & {
  [environmentKey]?: true;
};

if (!environmentState[environmentKey]) {
  const { window, document } = parseHTML(
    "<!doctype html><html><body></body></html>"
  );
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
