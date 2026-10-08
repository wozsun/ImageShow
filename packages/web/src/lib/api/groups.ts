import type { QueryClient } from "@tanstack/react-query";
import { adminApiBasePath, type ImageGroupListResponseDto, type ImageGroupAddResponseDto } from "@imageshow/shared/browser";
import { api } from "./client.js";
import { requestWithDeadline } from "./request-deadline.js";
import { readRequestRetryOptions } from "./read-request-retry.js";
import { queryKeys } from "./query-keys.js";

export const imageGroupsQuery = {
  queryKey: queryKeys.groups,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    requestWithDeadline((signal) => api<ImageGroupListResponseDto>(`${adminApiBasePath}/groups`, { signal }), signal),
  ...readRequestRetryOptions
};

/** Membership only changes this group's views and the list's member count. */
export async function refreshImageGroup(client: QueryClient, slug: string, writeConfirmed: boolean) {
  const memberKey = [...queryKeys.groupImages, slug];
  await client.cancelQueries({ queryKey: memberKey });
  if (!writeConfirmed) {
    // This bounded reconciliation read survives navigation. Inactive queries do
    // not refetch, and an observed page read can be cancelled on unmount.
    const params = new URLSearchParams({ group: slug, status: "ready", limit: "1" });
    await requestWithDeadline((signal) => api(
      `${adminApiBasePath}/images?${params}`,
      { signal }
    ));
  }
  await client.invalidateQueries({ queryKey: memberKey }, { throwOnError: true });
  await client.cancelQueries({ queryKey: queryKeys.groups, exact: true });
  await client.invalidateQueries({ queryKey: queryKeys.groups, exact: true }, { throwOnError: true });
}

export function addImageGroupMembers(slug: string, ids: string[], signal?: AbortSignal) {
  return requestWithDeadline((signal) => api<ImageGroupAddResponseDto>(
    `${adminApiBasePath}/groups/${slug}/members/add`,
    { method: "POST", body: JSON.stringify({ ids }), signal }
  ), signal);
}

export function removeImageGroupMembers(slug: string, ids: string[]) {
  return requestWithDeadline((signal) => api<{ removed: number }>(
    `${adminApiBasePath}/groups/${slug}/members/remove`,
    { method: "POST", body: JSON.stringify({ ids }), signal }
  ));
}
