import { ApiError, errorMessage } from "../../core/api-error.ts";
import type {
  StorageObjectReference,
  StorageRemovalFailure,
  StorageRemovalResult,
  StorageRemoveOptions,
  StorageRequestOptions
} from "./driver.ts";

const STORAGE_REMOVAL_DELETE_ATTEMPTS = 2;
const STORAGE_REMOVAL_CONFIRM_ATTEMPTS = 2;
const STORAGE_REMOVAL_CHECK_CONCURRENCY = 8;
export const LOCAL_STORAGE_REMOVAL_CONCURRENCY = 8;

export type StorageDeleteAttemptResult =
  | { status: "acknowledged" }
  | { status: "not_started" | "failed" | "unknown"; error: StorageRemovalFailure };

type ConfirmedStorageRemovalOptions = Readonly<{
  objects: readonly StorageObjectReference[];
  options?: StorageRemoveOptions;
  exists: (
    object: StorageObjectReference,
    options: StorageRequestOptions
  ) => Promise<boolean>;
  remove: (
    objects: readonly StorageObjectReference[],
    options: StorageRemoveOptions
  ) => Promise<StorageDeleteAttemptResult[]>;
}>;

type PendingRemoval = {
  object: StorageObjectReference;
  attempt?: StorageDeleteAttemptResult;
};

function objectIdentity(object: StorageObjectReference) {
  return JSON.stringify([object.prefix, object.key]);
}

function cancellationFailure(signal: AbortSignal): StorageRemovalFailure {
  return {
    code: "storage_delete_cancelled",
    message: errorMessage(signal.reason ?? new Error("Storage deletion cancelled"))
  };
}

export function storageRemovalFailure(
  error: unknown,
  fallbackCode = "storage_delete_failed"
): StorageRemovalFailure {
  const candidate = error as { code?: unknown; name?: unknown };
  const meaningfulName = typeof candidate?.name === "string"
    && candidate.name !== "Error"
    && candidate.name !== "AbortError"
    ? candidate.name
    : undefined;
  const code = error instanceof ApiError
    ? error.code
    : typeof candidate?.code === "string" && candidate.code
      ? candidate.code
      : meaningfulName
        ? meaningfulName
        : fallbackCode;
  return { code, message: errorMessage(error) };
}

export async function mapStorageObjectsBounded<Item, Result>(
  items: readonly Item[],
  concurrency: number,
  work: (item: Item, index: number) => Promise<Result>
) {
  if (!items.length) return [];
  const results = new Array<Result>(items.length);
  const workerCount = Math.min(
    items.length,
    Number.isFinite(concurrency)
      ? Math.max(1, Math.floor(concurrency))
      : 1
  );
  let nextIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;
      results[index] = await work(items[index]!, index);
    }
  }));
  return results;
}

async function confirmRemoval(
  pending: PendingRemoval,
  exists: ConfirmedStorageRemovalOptions["exists"],
  options: StorageRemoveOptions
) {
  let lastError: unknown;
  for (
    let attempt = 0;
    attempt < STORAGE_REMOVAL_CONFIRM_ATTEMPTS;
    attempt += 1
  ) {
    if (options.signal?.aborted) {
      return {
        state: "unknown" as const,
        error: cancellationFailure(options.signal)
      };
    }
    try {
      return {
        state: await exists(pending.object, options)
          ? "present" as const
          : "absent" as const
      };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    state: "unknown" as const,
    error: storageRemovalFailure(
      lastError,
      "storage_delete_confirmation_failed"
    )
  };
}

/**
 * Convert provider acknowledgements into the same per-object model. Missing
 * preflight objects never enter a delete request, and only non-terminal items
 * are retried.
 */
export async function removeDriverObjectsAndConfirm(
  input: ConfirmedStorageRemovalOptions
): Promise<StorageRemovalResult[]> {
  if (!input.objects.length) {
    throw new RangeError("Storage removal requires at least one object");
  }
  const options = input.options ?? {};
  const unique = [...new Map(input.objects.map((object) => [
    objectIdentity(object),
    object
  ])).values()];
  const settled = new Map<string, StorageRemovalResult>();
  let pending: PendingRemoval[] = [];

  const preflight = await mapStorageObjectsBounded(
    unique,
    STORAGE_REMOVAL_CHECK_CONCURRENCY,
    async (object) => {
      if (options.signal?.aborted) {
        return {
          object,
          error: cancellationFailure(options.signal)
        };
      }
      try {
        return { object, exists: await input.exists(object, options) };
      } catch (error) {
        return {
          object,
          error: storageRemovalFailure(
            error,
            "storage_delete_preflight_failed"
          )
        };
      }
    }
  );

  for (const state of preflight) {
    const identity = objectIdentity(state.object);
    if ("error" in state) {
      settled.set(identity, {
        ...state.object,
        status: "failed",
        error: state.error!
      });
    } else if (!state.exists) {
      settled.set(identity, { ...state.object, status: "missing" });
    } else {
      pending.push({ object: state.object });
    }
  }

  for (
    let deleteAttempt = 0;
    pending.length && deleteAttempt < STORAGE_REMOVAL_DELETE_ATTEMPTS;
    deleteAttempt += 1
  ) {
    let attempts: StorageDeleteAttemptResult[];
    try {
      attempts = await input.remove(
        pending.map((item) => item.object),
        options
      );
      if (attempts.length !== pending.length) {
        throw new Error("Storage provider returned an incomplete removal result");
      }
    } catch (error) {
      attempts = pending.map(() => ({
        status: "unknown",
        error: storageRemovalFailure(
          error,
          "storage_delete_outcome_unknown"
        )
      }));
    }

    pending = pending.map((item, index) => ({
      ...item,
      attempt: attempts[index]!
    }));
    const confirmations = await mapStorageObjectsBounded(
      pending,
      STORAGE_REMOVAL_CHECK_CONCURRENCY,
      (item) => confirmRemoval(item, input.exists, options)
    );
    const retry: PendingRemoval[] = [];

    for (const [index, item] of pending.entries()) {
      const identity = objectIdentity(item.object);
      const attempt = item.attempt!;
      const confirmation = confirmations[index]!;
      if (confirmation.state === "absent") {
        settled.set(identity, attempt.status === "not_started"
          ? {
              ...item.object,
              status: "failed",
              error: attempt.error
            }
          : { ...item.object, status: "removed" });
        continue;
      }
      if (confirmation.state === "present") {
        if (
          attempt.status !== "not_started"
          && deleteAttempt + 1 < STORAGE_REMOVAL_DELETE_ATTEMPTS
          && !options.signal?.aborted
        ) {
          retry.push({ object: item.object });
          continue;
        }
        settled.set(identity, {
          ...item.object,
          status: "failed",
          error: attempt.status === "acknowledged"
            ? {
                code: "storage_delete_incomplete",
                message: "Storage acknowledged deletion but the object still exists"
              }
            : attempt.error
        });
        continue;
      }

      if (
        attempt.status !== "acknowledged"
        && attempt.status !== "not_started"
        && deleteAttempt + 1 < STORAGE_REMOVAL_DELETE_ATTEMPTS
        && !options.signal?.aborted
      ) {
        retry.push({ object: item.object });
        continue;
      }
      settled.set(identity, {
        ...item.object,
        status: attempt.status === "not_started" ? "failed" : "unknown",
        error: attempt.status === "not_started"
          ? attempt.error
          : confirmation.error!
      });
    }
    pending = retry;
  }

  return input.objects.map((object) => {
    const result = settled.get(objectIdentity(object));
    if (!result) {
      return {
        ...object,
        status: "unknown",
        error: {
          code: "storage_delete_outcome_unknown",
          message: "Storage deletion did not produce a terminal result"
        }
      };
    }
    return { ...result, ...object } as StorageRemovalResult;
  });
}
