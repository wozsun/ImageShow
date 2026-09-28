import { unsetThemeFilter } from "@imageshow/shared/browser";

export function themesWithUnsetLast<T extends { slug: string }>(items: readonly T[]) {
  const configured: T[] = [];
  const unset: T[] = [];
  for (const item of items) {
    (item.slug === unsetThemeFilter ? unset : configured).push(item);
  }
  return [...configured, ...unset];
}

/** Keep zero-count styling stable while a new result is being verified. */
export function publicFilterOptionState({
  selected,
  count,
  unverified,
  unrestricted = false
}: {
  selected: boolean;
  count: number | undefined;
  unverified: boolean;
  unrestricted?: boolean;
}) {
  const canRemove = selected || unrestricted;
  return {
    disabled: !canRemove && count === 0,
    locked: !canRemove && (unverified || count === undefined)
  };
}
