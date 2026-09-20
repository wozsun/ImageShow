import { useEffect } from "react";

const channel = "imageshow:embed-safe-area";
const edges = ["top", "right", "bottom", "left"] as const;
type Insets = Record<typeof edges[number], number>;

/** Exchange optional layout data with the direct parent; native insets stay independent. */
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
    let probes: HTMLSpanElement[] = [];
    let observer: ResizeObserver | undefined;
    let reportFrame: number | undefined;
    let lastReport = "";
    const stopReporting = () => {
      if (reportFrame !== undefined) window.cancelAnimationFrame(reportFrame);
      reportFrame = undefined;
      observer?.disconnect();
      observer = undefined;
      probes.forEach(probe => probe.remove());
      probes = [];
      lastReport = "";
    };
    const report = () => {
      reportFrame = undefined;
      if (!origin || !observer) return;
      const [topLeft, bottomRight] = probes.map(probe => probe.getBoundingClientRect());
      const native = {
        insets: {
          top: topLeft.height, right: bottomRight.width,
          bottom: bottomRight.height, left: topLeft.width
        },
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        fullscreen: Boolean(document.fullscreenElement)
      };
      const key = JSON.stringify(native);
      if (key === lastReport) return;
      lastReport = key;
      parent.postMessage({ channel, version: 1, type: "native-insets", bridgeId, ...native }, origin);
    };
    const scheduleReport = () => {
      if (observer && reportFrame === undefined) reportFrame = window.requestAnimationFrame(report);
    };
    const startReporting = () => {
      if (!observer) {
        const nativeObserver = new ResizeObserver(scheduleReport);
        observer = nativeObserver;
        probes = [["left", "top"], ["right", "bottom"]].map(([x, y]) => {
          const probe = document.createElement("span");
          probe.setAttribute("aria-hidden", "true");
          // Read env() directly so the host's applied values cannot echo back.
          probe.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;"
            + `width:env(safe-area-inset-${x}, 0px);height:env(safe-area-inset-${y}, 0px);`;
          document.body.appendChild(probe);
          nativeObserver.observe(probe);
          return probe;
        });
      }
      lastReport = "";
      scheduleReport();
    };
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
      if (data.type === "connect") {
        origin = event.origin;
        startReporting();
      } else if (data.type === "insets" && "insets" in data) {
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
        stopReporting();
        insets = null;
        apply();
      }
    };
    window.addEventListener("message", onMessage, { signal: listeners.signal });
    window.addEventListener("resize", scheduleReport, { signal: listeners.signal });
    window.visualViewport?.addEventListener("resize", scheduleReport, { signal: listeners.signal });
    window.addEventListener("pageshow", () => {
      announce();
      lastReport = "";
      scheduleReport();
    }, { signal: listeners.signal });
    document.addEventListener("fullscreenchange", () => {
      apply();
      scheduleReport();
    }, { signal: listeners.signal });
    announce();
    return () => {
      listeners.abort();
      if (observer && origin) parent.postMessage({ channel, version: 1, type: "disconnect", bridgeId }, origin);
      stopReporting();
      insets = null;
      apply();
    };
  }, [enabled]);
}
