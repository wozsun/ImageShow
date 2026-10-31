import {
  analyticsCollectLimits,
  analyticsCollectPath,
  type AnalyticsCollectRequestDto,
  type AnalyticsEventInput
} from "@imageshow/shared/browser";

// Loaded only where collection is allowed (see analytics.ts). The visitor ID
// exists only to count distinct visitors and is never tied to an address.
const visitorKey = "imageshow:analytics-visitor";
const sessionKey = "imageshow:analytics-session";
const idleFlushMs = 2_000;
// A visitor idle this long starts a new session.
const sessionIdleMs = 30 * 60 * 1000;

// `entered` records whether the session has a page view yet: its first one is
// the entry, even when a trailing event of the previous view started it.
type StoredSession = { id: string; lastAtMs: number; entered: boolean };

let memoryVisitor: string | null = null;
// Set when this document created the visitor ID, until a page view reports it.
let newVisitor = false;
let memorySession: StoredSession | null = null;
let queue: AnalyticsEventInput[] = [];
let flushTimer: number | undefined;

// randomUUID needs a secure context; plain HTTP deployments use the same format.
function randomId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readStorage(storage: () => Storage, key: string) {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: () => Storage, key: string, value: string) {
  try {
    storage().setItem(key, value);
  } catch {
    // Without storage the identifiers last for this document only.
  }
}

function visitorId() {
  memoryVisitor ??= readStorage(() => localStorage, visitorKey);
  if (!memoryVisitor) {
    memoryVisitor = randomId();
    newVisitor = true;
    writeStorage(() => localStorage, visitorKey, memoryVisitor);
  }
  return memoryVisitor;
}

function parseSession(value: string | null): StoredSession | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredSession>;
    return typeof parsed.id === "string" && typeof parsed.lastAtMs === "number"
      ? { id: parsed.id, lastAtMs: parsed.lastAtMs, entered: parsed.entered === true }
      : null;
  } catch {
    return null;
  }
}

/** The current session, replaced after 30 minutes without activity. */
function touchSession(nowMs: number, pageView: boolean) {
  const stored = parseSession(readStorage(() => sessionStorage, sessionKey)) ?? memorySession;
  const current = stored && nowMs - stored.lastAtMs <= sessionIdleMs ? stored : null;
  memorySession = {
    id: current?.id ?? randomId(),
    lastAtMs: nowMs,
    entered: pageView || current?.entered === true
  };
  writeStorage(() => sessionStorage, sessionKey, JSON.stringify(memorySession));
  return { id: memorySession.id, entry: pageView && current?.entered !== true };
}

function send(body: AnalyticsCollectRequestDto) {
  const payload = JSON.stringify(body);
  const blob = new Blob([payload], { type: "application/json" });
  // A full beacon queue refuses the data; keepalive fetch still sends it.
  if (navigator.sendBeacon(analyticsCollectPath, blob)) return;
  void fetch(analyticsCollectPath, {
    method: "POST",
    body: payload,
    headers: { "content-type": "application/json" },
    credentials: "omit",
    keepalive: true
  }).catch(() => undefined);
}

let currentSession = "";

/** Sends what is queued now; failures are dropped, never retried. */
export function flushAnalyticsEvents() {
  if (flushTimer !== undefined) window.clearTimeout(flushTimer);
  flushTimer = undefined;
  if (!queue.length) return;
  const events = queue;
  queue = [];
  const visitor = visitorId();
  for (let index = 0; index < events.length; index += analyticsCollectLimits.maxEvents) {
    send({
      visitor,
      session: currentSession,
      events: events.slice(index, index + analyticsCollectLimits.maxEvents)
    });
  }
}

export function queueAnalyticsEvent(event: AnalyticsEventInput) {
  const session = touchSession(Date.now(), event.event === "page_view");
  // Events of the previous session leave before the new one starts.
  if (currentSession && session.id !== currentSession) flushAnalyticsEvents();
  currentSession = session.id;
  if (event.event === "page_view") {
    visitorId();
    queue.push({ ...event, entry: session.entry, new_visitor: newVisitor });
    newVisitor = false;
  } else {
    queue.push(event);
  }
  if (queue.length >= analyticsCollectLimits.maxEvents) {
    flushAnalyticsEvents();
    return;
  }
  if (flushTimer !== undefined) window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(flushAnalyticsEvents, idleFlushMs);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushAnalyticsEvents();
});
window.addEventListener("pagehide", flushAnalyticsEvents);
