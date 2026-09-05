import type { ReactNode } from "react";
import type { AdminSettings } from "@imageshow/shared/browser";
import { useAdminSettings } from "../../lib/api/admin-settings.js";
import { QueryErrorState } from "./QueryErrorState.js";

export function AdminSettingsBoundary({ children }: {
  children: (settings: AdminSettings) => ReactNode;
}) {
  const query = useAdminSettings();
  // Keep the mounted page and its workflows when a background refresh fails.
  // Only the initial read gates consumers of the authoritative settings.
  if (query.data) return children(query.data.settings);
  if (query.isError) {
    return (
      <QueryErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        fullPage
        reportContext="settings.load"
      />
    );
  }
  return <div className="center" role="status">加载中</div>;
}
