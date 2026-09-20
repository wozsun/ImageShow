import { useEffect } from "react";

const channel = "imageshow:embed-safe-area";
const edges = ["top", "right", "bottom", "left"] as const;
type Insets = Record<typeof edges[number], number>;

/** The parent knows which physical screen edges actually intersect this frame. */
export function useEmbeddedSafeArea(enabled: boolean) {
  useEffect(() => {
    if (!enabled || window.parent === window) return;
    const parent = window.parent;
    const root = document.documentElement;
    const bridgeId = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => (
      value.toString(16).padStart(8, "0")
    )).join("");
    let origin: string | null = null;
    let insets: Insets | null = null;
    const listeners = new AbortController();
    const apply = () => {
      for (const edge of edges) {
        const property = `--embed-safe-area-${edge}`;
        // Fullscreen changes the coordinate system: the browser owns its insets.
        if (insets && !document.fullscreenElement) root.style.setProperty(property, `${insets[edge]}px`);
        else root.style.removeProperty(property);
      }
    };
    const announce = (target = origin ?? "*") => parent.postMessage({
      channel, version: 1, type: "ready", bridgeId
    }, target);
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== parent || event.origin === "null" || (origin && event.origin !== origin)) return;
      const data = event.data;
      if (!data || typeof data !== "object" || Array.isArray(data)
        || !("channel" in data) || data.channel !== channel
        || !("version" in data) || data.version !== 1 || !("type" in data)) return;
      if (data.type === "hello") { announce(event.origin); return; }
      if (!("bridgeId" in data) || data.bridgeId !== bridgeId) return;
      if (data.type === "insets" && "insets" in data) {
        const value = data.insets;
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const candidate = value as Record<string, unknown>;
        if (!edges.every(edge => typeof candidate[edge] === "number"
          && Number.isFinite(candidate[edge]) && candidate[edge] >= 0
          && candidate[edge] <= (edge === "top" || edge === "bottom" ? window.innerHeight : window.innerWidth) / 2)) return;
        origin = event.origin;
        insets = candidate as Insets;
        apply();
      } else if (data.type === "disconnect" && origin === event.origin) {
        insets = null;
        apply();
      }
    };
    window.addEventListener("message", onMessage, { signal: listeners.signal });
    window.addEventListener("pageshow", () => announce(), { signal: listeners.signal });
    document.addEventListener("fullscreenchange", apply, { signal: listeners.signal });
    announce();
    return () => {
      listeners.abort();
      insets = null;
      apply();
    };
  }, [enabled]);
}
