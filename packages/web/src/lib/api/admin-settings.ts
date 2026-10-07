import { useQuery } from "@tanstack/react-query";
import { type AdminSettingsResponseDto, adminApiBasePath } from "@imageshow/shared/browser";
import { api } from "./client.js";
import { queryKeys } from "./query-keys.js";

export function useAdminSettings() {
  return useQuery<AdminSettingsResponseDto>({
    queryKey: queryKeys.settings,
    queryFn: ({ signal }) => api(`${adminApiBasePath}/settings`, { signal })
  });
}
