export type FilterSetSource = { key: string; count: number };
export type FilterSetOperation = {
  kind: "union" | "intersection" | "difference";
  sources: FilterSetSource[];
  result: FilterSetSource;
};

/** A finite execution sequence shared by admission and materialization. */
export function readyImageFilterOperations(input: {
  all: FilterSetSource;
  positive: FilterSetSource[][];
  tagClauses: FilterSetSource[][];
  exclusions: FilterSetSource[][];
}, nextKey: () => string) {
  const operations: FilterSetOperation[] = [];
  const combine = (kind: FilterSetOperation["kind"], sources: FilterSetSource[]): FilterSetSource => {
    const active = kind === "union" ? sources.filter((source) => source.count > 0) : sources;
    // A verified empty union can reuse a verified empty source.
    if (!active.length) return sources[0]!;
    if (active.length === 1) return active[0]!;
    const count = kind === "union"
      ? Math.min(input.all.count, active.reduce((sum, source) => sum + source.count, 0))
      : kind === "intersection" ? Math.min(...active.map((source) => source.count)) : active[0]!.count;
    const result = { key: nextKey(), count };
    operations.push({ kind, sources: active, result });
    return result;
  };
  // Complete each AND branch before forming the tag OR candidate set.
  const components: FilterSetSource[] = [];
  if (input.tagClauses.length) {
    components.push(combine("union", input.tagClauses.map((clause) => combine("intersection", clause))));
  }
  for (const group of input.positive) {
    if (group.length) components.push(combine("union", group));
  }
  let result = components[0] ?? input.all;
  for (const component of components.slice(1)) result = combine("intersection", [result, component]);
  for (const group of input.exclusions) {
    if (group.some((source) => source.count > 0)) result = combine("difference", [result, combine("union", group)]);
  }
  return { operations, result };
}
