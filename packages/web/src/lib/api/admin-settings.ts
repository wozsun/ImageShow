import { useQuery } from "@tanstack/react-query";
import type { AdminSettingsResponseDto } from "@imageshow/shared/browser";
import { adminApiBasePath } from "../constants.js";
import { api } from "./client.js";
import { queryKeys } from "./query-keys.js";

export function useAdminSettings() {
  return useQuery<AdminSettingsResponseDto>({
    queryKey: queryKeys.settings,
    queryFn: ({ signal }) => api(`${adminApiBasePath}/settings`, { signal })
  });
}
