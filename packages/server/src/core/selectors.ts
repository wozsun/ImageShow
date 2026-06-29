// Shared parsing for the comma-separated, optionally `!`-prefixed filter selectors used by
// the random API (t / tag / a) and the gallery list filters. Each raw value may be
// comma-joined; an exclude term carries a leading `!`. Returns deduped, lowercased bare
// slug lists; a lone "!" (no slug after it) is dropped. Mixing include and exclude is left
// for the caller to reject (the error shape differs between the two call sites).
export function splitSelectors(rawValues: string[]): { include: string[]; exclude: string[] } {
  const values = [...new Set(rawValues
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean))];
  const include: string[] = [];
  const exclude: string[] = [];
  for (const value of values) {
    if (value.startsWith("!")) {
      const bare = value.slice(1);
      if (bare) exclude.push(bare);
    } else {
      include.push(value);
    }
  }
  return { include, exclude };
}
