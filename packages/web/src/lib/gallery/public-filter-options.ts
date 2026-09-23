/** Keep zero-count styling stable while a new result is being verified. */
export function publicFilterOptionState({
  selected, count, unverified, unrestricted = false
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
