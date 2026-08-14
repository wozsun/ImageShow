import {
  runRequiredRedisCommand
} from "../../core/runtime-availability.ts";
import {
  ReadyImageCoreCacheError
} from "./cache-errors.ts";
import type {
  ReadyImageFilterIndex,
  ReadyImageFilterIndexValidation
} from "./filter-index.ts";
import {
  parseReadyImageCacheItem,
  readyImageMember,
  type ReadyImageCacheItem
} from "./model.ts";

export type ReadyImageCacheWindow = {
  items: ReadyImageCacheItem[];
  total: number;
};

export type ReadyImagePageReadMode = "fallback" | "required";

export type ReadyImageWindowDependencies = {
  validate(index: ReadyImageFilterIndex): Promise<
    boolean | ReadyImageFilterIndexValidation
  >;
  count(index: ReadyImageFilterIndex): Promise<number>;
  members(
    index: ReadyImageFilterIndex,
    start: number,
    stop: number
  ): Promise<string[]>;
  items(members: string[]): Promise<Array<string | null>>;
  assertDerivedItems(
    members: string[],
    raws: Array<string | null>
  ): Promise<void>;
};

function executeRedisCommand<T>(
  mode: ReadyImagePageReadMode,
  work: () => Promise<T>
) {
  return mode === "required" ? runRequiredRedisCommand(work) : work();
}

async function executeConsistencyCheck<T>(
  mode: ReadyImagePageReadMode,
  work: () => Promise<T>
) {
  try {
    return await work();
  } catch (error) {
    // Logical projection mismatches remain recoverable cache fallbacks. The
    // default checker attaches a cause only when its Redis pipeline failed.
    if (
      mode === "required"
      && error instanceof ReadyImageCoreCacheError
      && error.cause !== undefined
    ) {
      return runRequiredRedisCommand(() => Promise.reject(error));
    }
    throw error;
  }
}

function parsedItem(raw: string | null, expectedMember: string) {
  const item = parseReadyImageCacheItem(raw);
  if (!item || readyImageMember(item.id) !== expectedMember) {
    throw new ReadyImageCoreCacheError(
      "Ready-image cache returned a corrupt core item"
    );
  }
  return item;
}

export async function readReadyImageOrderedWindow(
  index: ReadyImageFilterIndex,
  start: number,
  limit: number,
  mode: ReadyImagePageReadMode,
  dependencies: ReadyImageWindowDependencies
): Promise<ReadyImageCacheWindow | null> {
  const indexIsValid = async () => {
    const raw = await executeRedisCommand(
      mode,
      () => dependencies.validate(index)
    );
    const validation = raw === true
      ? "valid"
      : raw === false
        ? "invalid"
        : raw;
    if (validation === "valid") return true;
    if (validation === "invalid" && index.kind === "core") {
      throw new ReadyImageCoreCacheError(
        "Ready-image core index validation failed"
      );
    }
    return false;
  };
  if (!await indexIsValid()) return null;
  const total = Number(await executeRedisCommand(
    mode,
    () => dependencies.count(index)
  ));
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Ready-image cache returned an invalid page count");
  }
  if (index.count !== null && index.count !== total) {
    throw new Error("Ready-image cached filter cardinality changed");
  }
  if (start >= total) {
    return await indexIsValid() ? { items: [], total } : null;
  }
  const members = await executeRedisCommand(
    mode,
    () => dependencies.members(index, start, start + limit - 1)
  );
  const expectedMembers = Math.min(limit, total - start);
  if (
    !Array.isArray(members)
    || members.length !== expectedMembers
  ) {
    throw new Error("Ready-image cache returned an invalid ordered window");
  }
  const raws = await executeRedisCommand(
    mode,
    () => dependencies.items(members)
  );
  if (!Array.isArray(raws) || raws.length !== members.length) {
    throw new ReadyImageCoreCacheError(
      "Ready-image cache returned incomplete core items"
    );
  }
  if (index.kind !== "core") {
    await executeConsistencyCheck(
      mode,
      () => dependencies.assertDerivedItems(members, raws)
    );
  }
  const items = raws.map((raw, position) => (
    parsedItem(raw, members[position]!)
  ));
  return await indexIsValid() ? { items, total } : null;
}
