const STORAGE_KEY_BATCH_SIZE = 256;
export const STORAGE_ADMIN_LIST_MAX_KEYS = 100_000;

export type StorageKeyListOptions = {
  signal?: AbortSignal;
  maxKeys?: number;
};

export type StorageKeyListResult =
  | { complete: true; count: number }
  | { complete: false; count: number; reason: "max_keys" };

export type StorageKeyListing = AsyncGenerator<
  readonly string[],
  StorageKeyListResult,
  void
>;

function checkedMaxKeys(value: number | undefined) {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Storage listing maxKeys must be a non-negative safe integer");
  }
  return value;
}

/**
 * Convert any key source into fixed-size batches. Reaching maxKeys is not an
 * implicit success: one additional key is observed before returning an
 * explicit incomplete result, so an exact-size namespace remains complete.
 */
export async function* batchStorageKeys(
  source: Iterable<string> | AsyncIterable<string>,
  options: StorageKeyListOptions = {}
): StorageKeyListing {
  const maxKeys = checkedMaxKeys(options.maxKeys);
  const batch: string[] = [];
  let count = 0;

  options.signal?.throwIfAborted();
  for await (const key of source) {
    options.signal?.throwIfAborted();
    if (count >= maxKeys) {
      if (batch.length) yield batch.splice(0, batch.length);
      return { complete: false, count, reason: "max_keys" };
    }
    batch.push(key);
    count += 1;
    if (batch.length === STORAGE_KEY_BATCH_SIZE) {
      yield batch.splice(0, batch.length);
    }
  }
  options.signal?.throwIfAborted();
  if (batch.length) yield batch;
  return { complete: true, count };
}

async function consumeStorageKeyListing(
  listing: StorageKeyListing,
  consume: (keys: readonly string[]) => void | Promise<void>
): Promise<StorageKeyListResult> {
  let finished = false;
  try {
    while (true) {
      const step = await listing.next();
      if (step.done) {
        finished = true;
        return step.value;
      }
      await consume(step.value);
    }
  } finally {
    if (!finished) {
      await listing.return(undefined as never).catch(() => undefined);
    }
  }
}

export async function collectStorageKeyListing(listing: StorageKeyListing) {
  const keys: string[] = [];
  const result = await consumeStorageKeyListing(listing, (batch) => {
    keys.push(...batch);
  });
  return { ...result, keys };
}
