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
