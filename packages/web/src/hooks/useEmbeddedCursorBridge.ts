import { useEffect } from "react";

const channel = "imageshow:embed-cursor";
const version = 1;
const cursorAttribute = "data-embed-cursor";

type PointerPhase = "enter" | "move" | "down" | "up";
type PointerSample = {
  x: number;
  y: number;
  button: number;
  buttons: number;
  viewportWidth: number;
  viewportHeight: number;
};
type OutgoingMessage =
  | { type: "ready" }
  | { type: "state"; connected: boolean; active: boolean }
  | ({ type: "pointer"; phase: PointerPhase } & PointerSample)
  | { type: "pointer"; phase: "leave" | "cancel" };

/** Enabled with embedding; the direct parent connects before taking over the cursor. */
export function useEmbeddedCursorBridge(enabled: boolean) {
  useEffect(() => {
    if (!enabled || window.parent === window) return;

    const parent = window.parent;
    const bridgeId = Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
      value.toString(16).padStart(8, "0")
    ).join("");
    const root = document.documentElement;
    const finePointer = window.matchMedia("(pointer: fine)");
    const listeners = new AbortController();
    const pointerOptions = { capture: true, passive: true, signal: listeners.signal };
    let parentOrigin: string | null = null;
    let connected = false;
    let active = false;
    let inside = false;
    let pageHidden = false;
    let frame = 0;
    let pendingMove: PointerSample | null = null;

    const send = (message: OutgoingMessage, targetOrigin = parentOrigin) => {
      if (targetOrigin === null) return;
      parent.postMessage({ channel, version, bridgeId, ...message }, targetOrigin);
    };
    const clearMove = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      pendingMove = null;
    };
    const leave = (phase: "leave" | "cancel" = "leave") => {
      clearMove();
      if (inside) send({ type: "pointer", phase });
      inside = false;
    };
    const syncActive = () => {
      active =
        connected &&
        finePointer.matches &&
        !pageHidden &&
        document.visibilityState === "visible" &&
        !document.fullscreenElement;
      if (active) root.setAttribute(cursorAttribute, "host");
      else {
        root.removeAttribute(cursorAttribute);
        leave();
      }
      send({ type: "state", connected, active });
    };
    const announce = (targetOrigin: string) => send({ type: "ready" }, targetOrigin);
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== parent || event.origin === "null") return;
      if (parentOrigin !== null && event.origin !== parentOrigin) return;
      const data = event.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      if (
        !("channel" in data) ||
        data.channel !== channel ||
        !("version" in data) ||
        data.version !== version ||
        !("type" in data)
      )
        return;
      if (data.type === "hello") {
        announce(event.origin);
      } else if (
        (data.type === "connect" || data.type === "disconnect") &&
        "bridgeId" in data &&
        data.bridgeId === bridgeId
      ) {
        parentOrigin = event.origin;
        connected = data.type === "connect";
        syncActive();
      }
    };
    const flushMove = () => {
      const sample = pendingMove;
      clearMove();
      if (active && inside && sample) send({ type: "pointer", phase: "move", ...sample });
    };
    const relayPointer = (event: PointerEvent, phase: PointerPhase) => {
      if (!active || event.pointerType !== "mouse" || !event.isPrimary) return;
      const sample: PointerSample = {
        x: event.clientX,
        y: event.clientY,
        button: event.button,
        buttons: event.buttons,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      };
      // Captured drags can continue outside the iframe's visible viewport.
      if (
        sample.x < 0 ||
        sample.y < 0 ||
        sample.x >= sample.viewportWidth ||
        sample.y >= sample.viewportHeight
      ) {
        leave();
        return;
      }
      if (!inside) {
        inside = true;
        send({ type: "pointer", phase: "enter", ...sample });
        if (phase === "move" || phase === "enter") return;
      }
      if (phase === "move") {
        pendingMove = sample;
        if (!frame) frame = window.requestAnimationFrame(flushMove);
      } else if (phase !== "enter") {
        flushMove();
        send({ type: "pointer", phase, ...sample });
      }
    };
    const onMove = (event: PointerEvent) => relayPointer(event, "move");
    const onDown = (event: PointerEvent) => relayPointer(event, "down");
    const onUp = (event: PointerEvent) => relayPointer(event, "up");
    const onOver = (event: PointerEvent) => {
      if (event.relatedTarget === null) relayPointer(event, "enter");
    };
    const onOut = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.relatedTarget === null) leave();
    };
    const onCancel = (event: PointerEvent) => {
      if (event.pointerType === "mouse") leave("cancel");
    };
    const onBlur = () => leave();
    const onPageHide = () => {
      pageHidden = true;
      syncActive();
    };
    const onPageShow = () => {
      pageHidden = false;
      syncActive();
      if (parentOrigin === null) announce("*");
    };

    window.addEventListener("message", onMessage, { signal: listeners.signal });
    window.addEventListener("pointermove", onMove, pointerOptions);
    window.addEventListener("pointerdown", onDown, pointerOptions);
    window.addEventListener("pointerup", onUp, pointerOptions);
    window.addEventListener("pointerover", onOver, pointerOptions);
    window.addEventListener("pointerout", onOut, pointerOptions);
    window.addEventListener("pointercancel", onCancel, pointerOptions);
    window.addEventListener("blur", onBlur, { signal: listeners.signal });
    window.addEventListener("pagehide", onPageHide, { signal: listeners.signal });
    window.addEventListener("pageshow", onPageShow, { signal: listeners.signal });
    document.addEventListener("visibilitychange", syncActive, { signal: listeners.signal });
    document.addEventListener("fullscreenchange", syncActive, { signal: listeners.signal });
    finePointer.addEventListener("change", syncActive, { signal: listeners.signal });
    // Discovery carries no input or page data. All subsequent data has an exact origin.
    announce("*");

    return () => {
      listeners.abort();
      connected = false;
      syncActive();
    };
  }, [enabled]);
}
