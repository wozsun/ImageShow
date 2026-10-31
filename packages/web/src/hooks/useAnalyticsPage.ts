import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AnalyticsPage, SiteConfigDto } from "@imageshow/shared/browser";
import { beginAnalyticsPage } from "../lib/analytics/analytics.js";
import { queryKeys } from "../lib/api/query-keys.js";

/**
 * Counts a view of this public page for as long as it stays mounted. Public
 * routes render only after the site configuration is read, so this reads the
 * cached copy instead of requesting it.
 */
export function useAnalyticsPage(page: AnalyticsPage, embedded: boolean) {
  const enabled = useQueryClient().getQueryData<SiteConfigDto>(queryKeys.siteConfig)!.analytics.enabled;
  useEffect(
    () => beginAnalyticsPage(page, embedded, enabled),
    [page, embedded, enabled]
  );
}
