// Runs `task` over `items` with at most `limit` in flight, processed in fixed-size chunks
// (one Promise.all per chunk). A bounded-concurrency map for storage-I/O-heavy loops: capping
// how many objects are copied / buffered at once keeps native memory and backend load in check.
// Shared by the theme-reassign file moves and the storage-migrate batch.
export async function mapWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const size = Math.max(1, limit);
  for (let offset = 0; offset < items.length; offset += size) {
    await Promise.all(items.slice(offset, offset + size).map(task));
  }
}
