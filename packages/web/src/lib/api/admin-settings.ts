import { useQuery } from "@tanstack/react-query";
import { adminApiBasePath } from "../constants.js";
import type { AdminSettings } from "../types.js";
import { api } from "./client.js";
import { queryKeys } from "./query-keys.js";

export function useAdminSettings() {
  return useQuery<{ settings: AdminSettings }>({
    queryKey: queryKeys.settings,
    queryFn: ({ signal }) => api(`${adminApiBasePath}/settings`, { signal })
  });
}
