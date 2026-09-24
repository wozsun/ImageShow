import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";

const validationStarts = new WeakMap<Query, number>();

export function recordAdminImageListValidation(
  client: QueryClient,
  queryKey: QueryKey,
  startedAt: number
) {
  const query = client.getQueryCache().find({ queryKey, exact: true });
  if (query) validationStarts.set(query, startedAt);
}

export function adminImageListValidationCovers(
  query: Query,
  completedAt: number
) {
  if (query.state.status !== "success") return false;
  const validatedAfter = validationStarts.get(query);
  return validatedAfter !== undefined && validatedAfter > completedAt;
}
