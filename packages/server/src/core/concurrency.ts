export async function mapWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const size = Math.max(1, limit);
  for (let offset = 0; offset < items.length; offset += size) {
    await Promise.all(items.slice(offset, offset + size).map(task));
  }
}
