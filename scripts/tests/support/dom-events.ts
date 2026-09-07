function setNativeControlValue(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string
) {
  let prototype: object | null = Object.getPrototypeOf(control);
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(control, value);
      return;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  throw new Error("测试控件没有可用的原生 value setter");
}

export function dispatchDomEvent(
  window: Window,
  target: EventTarget,
  type: string,
  properties: Record<string, unknown> = {}
) {
  const EventConstructor = (window as Window & { Event: typeof Event }).Event;
  const event = new EventConstructor(type, {
    bubbles: true,
    cancelable: true
  });
  Object.defineProperties(event, Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [
      key,
      { configurable: true, value }
    ])
  ));
  target.dispatchEvent(event);
  return event;
}

export function inputText(
  window: Window,
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string
) {
  const selectionView = control.ownerDocument.defaultView ?? window;
  const missingSelection = typeof selectionView.getSelection !== "function";
  if (missingSelection) {
    Object.defineProperty(selectionView, "getSelection", {
      configurable: true,
      value: () => ({
        anchorNode: null,
        anchorOffset: 0,
        focusNode: null,
        focusOffset: 0
      })
    });
  }
  const missingSelectionRange = !("selectionStart" in control);
  if (missingSelectionRange) {
    Object.defineProperties(control, {
      selectionStart: { configurable: true, writable: true, value: 0 },
      selectionEnd: { configurable: true, writable: true, value: 0 }
    });
  }
  const missingInputType = control.tagName === "INPUT" && !(
    control as HTMLInputElement
  ).type;
  if (missingInputType) {
    Object.defineProperty(control, "type", {
      configurable: true,
      value: "text"
    });
  }
  const legacyControl = control as typeof control & {
    attachEvent?: () => void;
    detachEvent?: () => void;
  };
  if (!legacyControl.attachEvent) legacyControl.attachEvent = () => {};
  if (!legacyControl.detachEvent) legacyControl.detachEvent = () => {};
  dispatchDomEvent(window, control, "focusin");
  try {
    setNativeControlValue(control, value);
    const event = dispatchDomEvent(window, control, "input");
    dispatchDomEvent(window, control, "keyup", { key: "Unidentified" });
    return event;
  } finally {
    if (missingInputType) Reflect.deleteProperty(control, "type");
    if (missingSelectionRange) {
      Reflect.deleteProperty(control, "selectionStart");
      Reflect.deleteProperty(control, "selectionEnd");
    }
    if (missingSelection) {
      Reflect.deleteProperty(selectionView, "getSelection");
    }
  }
}
