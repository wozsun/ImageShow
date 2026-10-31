import { useEffect, useRef } from "react";
import type { PublicImageOrder } from "@imageshow/shared/browser";
import { trackAnalytics } from "../lib/analytics/analytics.js";

/** Reports each change of a browse page's order, whichever control made it. */
export function useOrderAnalytics(order: PublicImageOrder) {
  const previous = useRef(order);
  useEffect(() => {
    if (previous.current === order) return;
    previous.current = order;
    trackAnalytics({ event: "sort_change", order });
  }, [order]);
}
