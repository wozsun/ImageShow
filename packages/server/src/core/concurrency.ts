export async function mapWithConcurrency<T, Result>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<Result>
): Promise<Result[]> {
  const size = Math.max(1, limit);
  const results: Result[] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    results.push(...await Promise.all(items.slice(offset, offset + size).map(task)));
  }
  return results;
}
