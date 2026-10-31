import type {
  AnalyticsCollectRequestDto,
  AnalyticsEventInput
} from "@imageshow/shared/browser";
import type { VisitorAgent } from "./user-agent.ts";
import { bufferVisitEvents, type VisitEventRow } from "./visit-events.ts";

function eventDetail(input: AnalyticsEventInput): Record<string, unknown> {
  switch (input.event) {
    case "page_view":
      return {
        entry: input.entry,
        support: input.support,
        new_visitor: input.new_visitor,
        viewport: input.viewport,
        color_scheme: input.color_scheme,
        reduced_motion: input.reduced_motion
      };
    default: {
      const { event: _event, page: _page, embedded: _embedded, ...detail } = input;
      return detail;
    }
  }
}

/**
 * Turns one validated report into rows and buffers them. Hosts equal to the
 * site's own host are internal navigation, not an external source.
 */
export function bufferCollectedEvents(
  input: AnalyticsCollectRequestDto,
  agent: VisitorAgent,
  siteHostname: string
) {
  const occurredAt = new Date();
  const externalHost = (host: string | null) => (host && host !== siteHostname ? host : null);
  const rows = input.events.map((event): VisitEventRow => ({
    occurredAt,
    visitorId: input.visitor,
    sessionId: input.session,
    event: event.event,
    page: event.page,
    embedded: event.embedded,
    referrerHost: event.event === "page_view" ? externalHost(event.referrer) : null,
    embedHost: event.event === "page_view" && event.embedded ? event.embed_host : null,
    device: agent.device,
    browser: agent.browser,
    browserMajor: agent.browserMajor,
    os: agent.os,
    detail: eventDetail(event)
  }));
  return bufferVisitEvents(rows);
}
